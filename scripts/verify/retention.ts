/**
 * PASS/FAIL verification for run retention (M5).
 *
 * This is the one operation in the system that deletes, and it deletes from a
 * log ADR-0001 calls append-only. The unit tests cover the policy; this covers
 * the thing that would actually be catastrophic — purging something it should
 * have spared, or leaving a log half-deleted.
 *
 *   DATABASE_URL=... bun run scripts/verify/retention.ts
 *
 * **Run this against a database nothing else is using.** It calls
 * purgeExpiredRuns with dryRun:false, and that selects across the whole `runs`
 * table rather than only the fixtures below — so pointed at a development
 * database it permanently deletes the log and artifacts of every private run
 * older than ninety days, in one transaction, with nothing to undo it. The
 * check that exactly one run was purged then fails too, which means the
 * destruction is discovered only after it happened.
 *
 * Two mitigations, and it is worth being clear about what each does. A session
 * advisory lock stops two copies of this verification colliding. A preflight
 * count refuses to start when the database holds any run this script did not
 * create. Neither closes the window: a run created *after* the count is still
 * inside the purge's reach, because nothing outside this file takes that lock.
 * An isolated database is the only real guarantee, which is what CI uses.
 */
import { eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  runArtifacts,
  runEvents,
  runs,
  templateVersions,
  templates,
  workspaces,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { purgeExpiredRuns } from "@/lib/runs/retention";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const workspaceId = newId("ws");
const templateId = newId("tpl");
const versionId = newId("tplv");

const NOW = new Date();
const OLD = new Date(NOW.getTime() - 200 * 86_400_000);
const RECENT = new Date(NOW.getTime() - 3 * 86_400_000);

/** Every combination that must survive, and the one that must not. */
const fixtures = [
  { key: "oldPrivate", visibility: "private", isDemo: false, at: OLD, survives: false },
  { key: "oldPublic", visibility: "public", isDemo: false, at: OLD, survives: true },
  { key: "oldUnlisted", visibility: "unlisted", isDemo: false, at: OLD, survives: true },
  { key: "oldDemo", visibility: "public", isDemo: true, at: OLD, survives: true },
  // A demo marked private: isDemo has to win, because the two flags coming
  // apart is a bug this must not compound by deleting the gallery.
  { key: "oldPrivateDemo", visibility: "private", isDemo: true, at: OLD, survives: true },
  { key: "recentPrivate", visibility: "private", isDemo: false, at: RECENT, survives: true },
  // Old, private, and still going. Its appender holds a seq counter: deleting
  // under it would not stop the writes, and the next append would resume from
  // a number with nothing beneath it — a log with a gap.
  {
    key: "oldRunning",
    visibility: "private",
    isDemo: false,
    at: OLD,
    survives: true,
    status: "running",
  },
  { key: "oldQueued", visibility: "private", isDemo: false, at: OLD, survives: true, status: "queued" },
] as const;

const runIds: Record<string, string> = {};
for (const f of fixtures) runIds[f.key] = newId("run");

async function setup() {
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `verify-ret-${workspaceId}`,
    name: "retention",
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

  for (const f of fixtures) {
    const id = runIds[f.key]!;
    await db.insert(runs).values({
      id,
      workspaceId,
      templateVersionId: versionId,
      inputs: {},
      status: "status" in f ? f.status : "succeeded",
      visibility: f.visibility,
      isDemo: f.isDemo,
      queuedAt: f.at,
    });
    await db.insert(runEvents).values([
      {
        runId: id,
        seq: 1,
        type: "run.start",
        payload: { templateSlug: "verify", templateVersion: 1, inputs: {} },
      },
      { runId: id, seq: 2, type: "run.end", payload: { status: "succeeded", durationMs: 1 } },
    ]);
    await db.insert(runArtifacts).values({
      id: newId("art"),
      runId: id,
      path: "spec.md",
      mime: "text/markdown",
      bytes: 5,
      content: "hello",
    });
  }
}

async function teardown() {
  const ids = Object.values(runIds);
  await db.delete(runEvents).where(inArray(runEvents.runId, ids));
  await db.delete(runArtifacts).where(inArray(runArtifacts.runId, ids));
  await db.delete(runs).where(inArray(runs.id, ids));
  await db.delete(templates).where(eq(templates.id, templateId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

async function counts(runId: string) {
  const [row] = await db
    .select({
      events: sql<string>`(
        select count(*) from "runEvents" e where e."runId" = "runs"."id"
      )`,
      artifacts: sql<string>`(
        select count(*) from "runArtifacts" a where a."runId" = "runs"."id"
      )`,
      purgedAt: runs.purgedAt,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  return {
    events: Number(row?.events ?? -1),
    artifacts: Number(row?.artifacts ?? -1),
    purgedAt: row?.purgedAt ?? null,
  };
}

/** Arbitrary but fixed, so two runs of this script serialize against each other. */
const ADVISORY_LOCK_KEY = 8_421_338;

async function main() {
  await db.execute(sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);

  // A moment-in-time check, not a barrier. Anything created after it is still
  // inside the purge's reach — see the note at the top of this file.
  const [existing] = await db.select({ count: sql<string>`count(*)` }).from(runs);

  if (Number(existing?.count ?? 0) > 0) {
    console.error(
      `FAIL  the database holds ${existing?.count} run(s) — refusing to run.`,
    );
    console.error(
      "      This verification purges for real, across the whole runs table,",
    );
    console.error(
      "      and a whole-log deletion cannot be undone. Point DATABASE_URL at a",
    );
    console.error("      disposable database.");
    failures++;
    return;
  }

  await setup();

  // --- the dry run must not write ------------------------------------------
  const before = await Promise.all(fixtures.map((f) => counts(runIds[f.key]!)));
  const dry = await purgeExpiredRuns(db, { retentionDays: 90, now: NOW, dryRun: true });
  const afterDry = await Promise.all(fixtures.map((f) => counts(runIds[f.key]!)));

  check(
    "a dry run reports what it would remove",
    dry.purged.length === 1 && dry.purged[0]!.runId === runIds.oldPrivate,
    dry.purged.map((p) => p.runId).join(","),
  );
  check(
    "a dry run changes nothing",
    JSON.stringify(before) === JSON.stringify(afterDry),
  );

  // --- zero disables, rather than meaning "purge everything" ---------------
  const disabled = await purgeExpiredRuns(db, {
    retentionDays: 0,
    now: NOW,
    dryRun: false,
  });
  check(
    "RETENTION_DAYS=0 disables retention rather than purging everything",
    disabled.purged.length === 0,
  );
  check(
    "and it really wrote nothing",
    (await counts(runIds.oldPrivate!)).events === 2,
  );

  // --- the real thing ------------------------------------------------------
  const applied = await purgeExpiredRuns(db, {
    retentionDays: 90,
    now: NOW,
    dryRun: false,
  });
  check("applying removes exactly one run's log", applied.purged.length === 1);

  for (const f of fixtures) {
    const after = await counts(runIds[f.key]!);
    if (f.survives) {
      check(
        `${f.key} keeps its log`,
        after.events === 2 && after.artifacts === 1 && after.purgedAt === null,
        `events=${after.events} artifacts=${after.artifacts} purgedAt=${after.purgedAt}`,
      );
    } else {
      check(
        `${f.key} loses its log entirely, and keeps its row`,
        after.events === 0 && after.artifacts === 0 && after.purgedAt !== null,
        `events=${after.events} artifacts=${after.artifacts} purgedAt=${after.purgedAt}`,
      );
    }
  }

  // --- idempotence ---------------------------------------------------------
  const again = await purgeExpiredRuns(db, {
    retentionDays: 90,
    now: NOW,
    dryRun: false,
  });
  check("a purged run is not selected a second time", again.purged.length === 0);
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("FAIL  the verification itself threw", error);
} finally {
  await teardown().catch((error) => {
    // A failed teardown is a failure. Reporting PASS while fixtures are still
    // in the database hands the next run a dirty starting state and blames it
    // for this one's mess.
    failures++;
    console.error("FAIL  teardown left fixtures behind —", error);
  });
}

console.log(failures === 0 ? "\nretention: PASS" : `\nretention: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
