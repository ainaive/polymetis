/**
 * PASS/FAIL verification for the run queue (ADR-0001, M3a).
 *
 * These are properties Postgres has to enforce and unit tests cannot see: that
 * two workers racing the same queue take different runs, that a claim survives
 * only as long as its heartbeat, and that the reaper puts an abandoned run back
 * rather than leaving it running with nothing behind it. Run in CI.
 *
 *   DATABASE_URL=... bun run scripts/verify/queue-claim.ts
 *
 * **Run this against a database nothing else is using.** claimNext takes
 * whatever row is next — that is its job — so beside real work this does not
 * merely fail an assertion: it claims someone else's run, backdates its
 * heartbeat, and reaps it until the attempt cap marks it failed. It destroyed a
 * queued demo run exactly that way.
 *
 * Two mitigations, and it is worth being clear about what each does. A session
 * advisory lock stops two copies of this verification colliding. A preflight
 * count refuses to start when the queue already holds work. Neither closes the
 * window: a run enqueued *after* the count still gets claimed, because nothing
 * outside this file takes that lock. An isolated database is the only real
 * guarantee, which is what CI uses.
 */
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  runEvents,
  runQueue,
  runs,
  templateVersions,
  templates,
  workspaces,
} from "@/db/schema";
import { appendEvents } from "@/lib/events/store";
import { newId } from "@/lib/ids";
import {
  claimNext,
  heartbeat,
  MAX_ATTEMPTS,
  reapStale,
  releaseClaim,
} from "@/lib/queue/claim";

/** Arbitrary but fixed, so two runs of this script serialize against each other. */
const ADVISORY_LOCK_KEY = 8_421_337;

let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const workspaceId = newId("ws");
const templateId = newId("tpl");
const versionId = newId("tplv");
const runIds = [newId("run"), newId("run"), newId("run"), newId("run")];

async function setup() {
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `verify-${workspaceId}`,
    name: "verify",
  });
  await db.insert(templates).values({
    id: templateId,
    workspaceId,
    slug: `verify-${templateId}`,
    category: "spec",
  });
  await db.insert(templateVersions).values({
    id: versionId,
    templateId,
    version: 1,
    inputSchema: {
      fields: [{ type: "repo", name: "repo", required: true, publicOnly: false }],
    },
    toolPolicy: { allow: ["Read"], deny: [], confirm: [] },
    directives: "verify",
    deliverable: { filename: "spec.md", format: "markdown", sections: ["Summary"] },
    rubric: "verify",
    model: "claude-opus-5",
    effort: "xhigh",
  });
}

async function enqueue(runId: string) {
  await db.insert(runs).values({
    id: runId,
    workspaceId,
    templateVersionId: versionId,
    inputs: { repo: "/tmp/verify" },
    status: "queued",
  });
  await db.insert(runQueue).values({ runId });
}

async function teardown() {
  await db.delete(runQueue).where(inArray(runQueue.runId, runIds));
  await db.delete(runs).where(inArray(runs.id, runIds));
  await db.delete(templates).where(eq(templates.id, templateId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

/** Backdate a claim's heartbeat, standing in for a worker that stopped. */
async function staleHeartbeat(runId: string, secondsAgo: number) {
  await db
    .update(runQueue)
    .set({ lockedAt: new Date(Date.now() - secondsAgo * 1000) })
    .where(eq(runQueue.runId, runId));
}

async function main() {
  // Serializes concurrent copies of this verification. Deliberately not taken
  // by the worker or by enqueue: making production code acquire a lock for a
  // test's benefit is a worse trade than an isolated database.
  await db.execute(sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);

  // A moment-in-time check, not a barrier. Anything enqueued after it is still
  // fair game for claimNext below — see the note at the top of this file.
  const [busy] = await db
    .select({ count: sql<string>`count(*)` })
    .from(runQueue)
    .where(inArray(runQueue.state, ["pending", "claimed"]));

  if (Number(busy?.count ?? 0) > 0) {
    console.error(
      `FAIL  the queue has ${busy?.count} row(s) pending or claimed — refusing to run.`,
    );
    console.error(
      "      Stop the worker and let the queue drain first; this verification",
    );
    console.error(
      "      claims and reaps whatever it finds, including real runs.",
    );
    failures++;
    return;
  }

  await setup();

  // --- two workers contending for the same queue ----------------------------
  await enqueue(runIds[0]!);
  await enqueue(runIds[1]!);

  // Two claimNext calls in a Promise.all do NOT test this: they finish so
  // quickly that they never overlap, and that version passes with plain
  // FOR UPDATE. So the contention is made real — a transaction we control takes
  // the row lock and holds it while a genuine claimNext runs against it.
  let releaseHold = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let lockedRunId: string | undefined;

  const holder = db.transaction(async (tx) => {
    const rows = await tx.execute<{ runId: string }>(sql`
      SELECT "runId" FROM "runQueue"
       WHERE state = 'pending' AND "runAfter" <= now()
       ORDER BY "runAfter"
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    `);
    lockedRunId = rows[0]?.runId;
    // Hold the transaction open, and with it the row lock.
    await held;
  });

  // Let the holder acquire before the claimant tries.
  await new Promise((r) => setTimeout(r, 250));
  check("the holding transaction locked a row", lockedRunId !== undefined);

  try {

    // Without SKIP LOCKED this blocks on the held row until the holder commits,
    // so it is raced against a deadline: a claim that has to wait for an unrelated
    // worker's ten-minute run is a broken queue, not a slow one.
    const b = await Promise.race([
      claimNext(db, "worker-b"),
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3_000)),
    ]);

    check("a claim is not blocked by another worker's in-flight claim", b !== "blocked");
    check(
      "a contending worker takes a different run",
      b !== "blocked" && b !== null && b.runId !== lockedRunId,
      `locked ${lockedRunId}, claimed ${b === "blocked" ? "nothing" : b?.runId}`,
    );
  } finally {
    // Always, even if a check above threw. The holder keeps a row lock on
    // runQueue, and teardown deletes those rows — so leaving the transaction
    // open makes the whole verification hang on its own lock instead of
    // reporting FAIL. Awaiting it here also observes the promise, which is
    // otherwise an unhandled rejection if the holder itself fails.
    releaseHold();
    await holder.catch((error) => {
      failures++;
      console.error(`FAIL  the lock-holding transaction failed — ${error}`);
    });
  }

  // The row the holder locked was never claimed — its transaction only took a
  // lock — so it is still pending and can be claimed now.
  const a = await claimNext(db, "worker-a");
  check("the previously locked run is claimable once released", a?.runId === lockedRunId);
  check(
    "a claim carries what the worker needs to run it",
    a?.templateVersionId === versionId && a?.inputs.repo === "/tmp/verify",
  );

  const [claimedRun] = await db
    .select({ status: runs.status, startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, a!.runId));
  check(
    "claiming moves the run row in the same transaction",
    claimedRun?.status === "running" && claimedRun.startedAt !== null,
    `status ${claimedRun?.status}`,
  );

  check("an empty queue claims nothing", (await claimNext(db, "worker-c")) === null);

  // --- a heartbeat proves ownership, and only ownership ---------------------
  check("the owner can heartbeat", await heartbeat(db, a!.runId, "worker-a"));
  check(
    "a worker that does not own the claim cannot heartbeat",
    (await heartbeat(db, a!.runId, "worker-b")) === false,
  );

  // --- the reaper takes back what stopped beating ---------------------------
  await staleHeartbeat(a!.runId, 300);
  const reaped = await reapStale(db, 45);
  check(
    "a stale claim is requeued",
    reaped.length === 1 && reaped[0]!.runId === a!.runId && reaped[0]!.requeued,
    JSON.stringify(reaped),
  );

  const [requeued] = await db
    .select({ status: runs.status, startedAt: runs.startedAt })
    .from(runs)
    .where(eq(runs.id, a!.runId));
  check(
    "a requeued run stops looking like it is running",
    requeued?.status === "queued" && requeued.startedAt === null,
    `status ${requeued?.status}`,
  );

  check(
    "a heartbeat from the worker that lost its run returns false",
    (await heartbeat(db, a!.runId, "worker-a")) === false,
  );

  const reclaimed = await claimNext(db, "worker-d");
  check("a requeued run can be claimed again", reclaimed?.runId === a!.runId);
  check("the second claim counts as a second attempt", reclaimed?.attempts === 2);

  // --- a run that keeps killing its worker is eventually given up on -------
  await db
    .update(runQueue)
    .set({ attempts: MAX_ATTEMPTS })
    .where(eq(runQueue.runId, a!.runId));
  await staleHeartbeat(a!.runId, 300);
  const abandoned = await reapStale(db, 45);
  check(
    "past the attempt cap the run is failed rather than requeued forever",
    abandoned.length === 1 && abandoned[0]!.requeued === false,
    JSON.stringify(abandoned),
  );

  const [failed] = await db
    .select({ status: runs.status, error: runs.error })
    .from(runs)
    .where(eq(runs.id, a!.runId));
  check(
    "an abandoned run says so on the run row",
    failed?.status === "failed" && (failed.error ?? "").includes("abandoned"),
    `status ${failed?.status}, error ${failed?.error}`,
  );

  // --- a run whose log has begun is failed, not requeued --------------------
  // The dead worker's run.start is durable, and the appender resumes at
  // max(seq): requeueing would put a second run.start in the same append-only
  // log (issue #10). The reaper must settle it instead.
  await enqueue(runIds[3]!);
  const begun = await claimNext(db, "worker-g");
  check("claimed the run that will begin execution", begun?.runId === runIds[3]);
  await appendEvents(db, runIds[3]!, 0, [
    {
      type: "run.start",
      payload: { templateSlug: "verify", templateVersion: 1, inputs: {} },
    },
  ]);
  await staleHeartbeat(runIds[3]!, 300);
  const reapedBegun = await reapStale(db, 45);
  check(
    "a stale claim with a begun log is not requeued",
    reapedBegun.length === 1 &&
      reapedBegun[0]!.runId === runIds[3] &&
      reapedBegun[0]!.requeued === false,
    JSON.stringify(reapedBegun),
  );

  const [diedQueue] = await db
    .select({ state: runQueue.state })
    .from(runQueue)
    .where(eq(runQueue.runId, runIds[3]!));
  const [diedRun] = await db
    .select({ status: runs.status, error: runs.error })
    .from(runs)
    .where(eq(runs.id, runIds[3]!));
  check(
    "a begun run is settled failed on both rows",
    diedQueue?.state === "failed" &&
      diedRun?.status === "failed" &&
      (diedRun.error ?? "").includes("died"),
    `queue ${diedQueue?.state}, run ${diedRun?.status}, error ${diedRun?.error}`,
  );

  const startEvents = await db
    .select({ seq: runEvents.seq })
    .from(runEvents)
    .where(eq(runEvents.runId, runIds[3]!));
  check(
    "the log still holds exactly one run.start",
    startEvents.length === 1,
    `${startEvents.length} events`,
  );

  // --- a shutting-down worker gives its claim back --------------------------
  await enqueue(runIds[2]!);
  const shuttingDown = await claimNext(db, "worker-e");
  check("claimed the run to be released", shuttingDown?.runId === runIds[2]);
  await releaseClaim(db, runIds[2]!, "worker-e");

  const [released] = await db
    .select({ state: runQueue.state, attempts: runQueue.attempts })
    .from(runQueue)
    .where(eq(runQueue.runId, runIds[2]!));
  check(
    "a deliberate release requeues without burning an attempt",
    released?.state === "pending" && released.attempts === 0,
    `state ${released?.state}, attempts ${released?.attempts}`,
  );
  check(
    "a released run is immediately claimable",
    (await claimNext(db, "worker-f"))?.runId === runIds[2],
  );
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("FAIL  the verification itself threw", error);
} finally {
  // Always, even when main threw: a failed verification must not leave rows
  // behind that make the next run fail for a different reason.
  await teardown().catch((error) => {
    // A failed teardown is a failure. Reporting PASS while fixtures are still
    // in the database hands the next run a dirty starting state and blames it
    // for this one's mess.
    failures++;
    console.error("FAIL  teardown left fixtures behind —", error);
  });
}

console.log(failures === 0 ? "\nqueue-claim: PASS" : `\nqueue-claim: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
