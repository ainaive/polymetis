/**
 * PASS/FAIL verification for the append-only run event log (ADR-0001).
 *
 * These are the properties Postgres has to enforce and unit tests cannot see:
 * the uniqueness backstop actually rejects a duplicate seq, and the SSE
 * reconnect cursor returns exactly the missed events. Run in CI.
 *
 *   DATABASE_URL=... bun run scripts/verify/run-event-ordering.ts
 */
import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  runQueue,
  runs,
  templateVersions,
  templates,
  workspaces,
} from "@/db/schema";
import { appendEvents, lastSeq, readEvents } from "@/lib/events/store";
import { newId } from "@/lib/ids";

let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectRejection(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, "expected a rejection, but the write succeeded");
  } catch {
    check(name, true);
  }
}

const workspaceId = newId("ws");
const templateId = newId("tpl");
const versionId = newId("tplv");
const runId = newId("run");

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
    inputSchema: { fields: [{ type: "repo", name: "repo", required: true, publicOnly: false }] },
    toolPolicy: { allow: ["Read"], deny: [], confirm: [] },
    directives: "verify",
    deliverable: { filename: "spec.md", format: "markdown", sections: ["Summary"] },
    rubric: "verify",
    model: "claude-opus-5",
    effort: "xhigh",
  });
  await db.insert(runs).values({
    id: runId,
    workspaceId,
    templateVersionId: versionId,
    inputs: {},
  });
}

async function teardown() {
  // runEvents, runQueue and runs cascade from the workspace/template chain.
  await db.delete(runQueue).where(eq(runQueue.runId, runId));
  await db.delete(runs).where(eq(runs.id, runId));
  await db.delete(templates).where(eq(templates.id, templateId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

async function main() {
  await setup();

  // --- contiguous assignment ------------------------------------------------
  const afterFirst = await appendEvents(db, runId, 0, [
    {
      type: "run.start",
      payload: { templateSlug: "verify", templateVersion: 1, inputs: {} },
    },
    { type: "step.start", payload: { index: 0, label: "one" } },
    { type: "agent.message", payload: { text: "hello" } },
  ]);
  check("appendEvents returns the last assigned seq", afterFirst === 3, `got ${afterFirst}`);
  check("lastSeq agrees with the appender", (await lastSeq(db, runId)) === 3);

  const all = await readEvents(db, runId);
  check(
    "events read back in seq order with no gaps",
    all.map((e) => e.seq).join(",") === "1,2,3",
    all.map((e) => e.seq).join(","),
  );

  // --- the uniqueness backstop ---------------------------------------------
  await expectRejection(
    "UNIQUE (runId, seq) rejects a replayed seq range",
    // Appending "after 0" again re-uses seq 1..3 — exactly what a buggy
    // appender that lost its counter would do.
    () =>
      appendEvents(db, runId, 0, [
        { type: "agent.message", payload: { text: "duplicate" } },
      ]),
  );

  const afterDuplicateAttempt = await lastSeq(db, runId);
  check(
    "a rejected append leaves the log untouched",
    afterDuplicateAttempt === 3,
    `lastSeq is ${afterDuplicateAttempt}`,
  );

  // --- validation happens at write time ------------------------------------
  await expectRejection("a malformed payload is rejected before it is stored", () =>
    appendEvents(db, runId, 3, [
      // costUsd must be non-negative.
      {
        type: "usage",
        payload: {
          model: "claude-opus-5",
          inputTokens: 1,
          outputTokens: 1,
          costUsd: -5,
        },
      } as never,
    ]),
  );
  check(
    "a rejected malformed append wrote nothing",
    (await lastSeq(db, runId)) === 3,
  );

  // --- the reconnect cursor -------------------------------------------------
  await appendEvents(db, runId, 3, [
    { type: "tool.call", payload: { toolCallId: "t1", tool: "Read", summary: "a.ts" } },
    { type: "tool.result", payload: { toolCallId: "t1", ok: true, summary: "12 lines" } },
    { type: "run.end", payload: { status: "succeeded", durationMs: 1234 } },
  ]);

  const missed = await readEvents(db, runId, { afterSeq: 3 });
  check(
    "readEvents(afterSeq) returns exactly the events a client missed",
    missed.map((e) => e.seq).join(",") === "4,5,6",
    missed.map((e) => e.seq).join(","),
  );
  check(
    "reconnecting at the head returns nothing rather than replaying",
    (await readEvents(db, runId, { afterSeq: 6 })).length === 0,
  );

  // --- concurrent appenders -------------------------------------------------
  // Two workers holding the same stale counter must not both succeed: that is
  // the scenario the unique constraint exists to catch.
  const results = await Promise.allSettled([
    appendEvents(db, runId, 6, [{ type: "agent.message", payload: { text: "A" } }]),
    appendEvents(db, runId, 6, [{ type: "agent.message", payload: { text: "B" } }]),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  check(
    "two appenders racing on the same seq: exactly one wins",
    fulfilled === 1,
    `${fulfilled} succeeded`,
  );

  const finalCount = (await readEvents(db, runId)).length;
  check("the log holds exactly the accepted events", finalCount === 7, `got ${finalCount}`);
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("FAIL  unexpected error", error);
} finally {
  await teardown();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
