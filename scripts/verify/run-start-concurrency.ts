/**
 * PASS/FAIL verification that the concurrency cap holds under contention (M3b).
 *
 * The unit test stubs the count; this races real transactions. Reading the
 * in-flight total outside the transaction is a read-then-write race, and the
 * failure is silent — a workspace simply runs more than it is allowed.
 *
 *   DATABASE_URL=... bun run scripts/verify/run-start-concurrency.ts
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  runQueue,
  runs,
  templateVersions,
  templates,
  users,
  workspaces,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { startRunForWorkspace } from "@/lib/runs/start";
import { issueToSpecInputSchema } from "@/lib/templates/issue-to-spec";

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
const MAX = 3;
const userId = newId("ws").replace("ws_", "usr_");

async function setup() {
  // A real row: runs.userId is a foreign key, so a made-up id fails the insert
  // rather than the cap, and the whole race would go untested.
  await db.insert(users).values({
    id: userId,
    email: `verify-${userId}@example.invalid`,
    emailVerified: false,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `verify-conc-${workspaceId}`,
    name: "concurrency",
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
    inputSchema: issueToSpecInputSchema,
    toolPolicy: { allow: ["Read"], deny: [], confirm: [] },
    directives: "verify",
    deliverable: { filename: "spec.md", format: "markdown", sections: ["Summary"] },
    rubric: "verify",
    model: "claude-opus-5",
    effort: "xhigh",
  });
}

async function teardown() {
  const owned = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId));
  const ids = owned.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(runQueue).where(inArray(runQueue.runId, ids));
    await db.delete(runs).where(inArray(runs.id, ids));
  }
  await db.delete(templates).where(eq(templates.id, templateId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.id, userId));
}

async function main() {
  await setup();

  const attempt = () =>
    startRunForWorkspace(db, {
      workspaceId,
      userId,
      template: { versionId, inputSchema: issueToSpecInputSchema },
      submitted: {
        repo: "octocat/Hello-World",
        issue: "https://github.com/octocat/Hello-World/issues/1",
        audience: "engineer",
      },
      // Every caller sees an empty workspace: this is the stale read the
      // transaction has to correct for.
      usage: { usedTokens: 0, allowanceTokens: 20_000_000, inFlight: 0 },
      maxConcurrent: MAX,
    });

  // Ten at once, all believing there is room for another.
  const results = await Promise.all(Array.from({ length: 10 }, attempt));
  const started = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok).length;

  check(
    `at most ${MAX} of ten concurrent starts succeed`,
    started <= MAX,
    `${started} started`,
  );
  check("the rest are refused rather than erroring", refused === 10 - started);

  const [live] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId));
  void live;

  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId));
  check(
    "the database holds exactly the runs that were reported started",
    rows.length === started,
    `${rows.length} rows for ${started} reported`,
  );

  const queued = await db
    .select({ runId: runQueue.runId })
    .from(runQueue)
    .where(inArray(runQueue.runId, rows.map((r) => r.id)));
  check(
    "every started run has a queue row",
    queued.length === rows.length,
    `${queued.length} queue rows for ${rows.length} runs`,
  );
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

console.log(
  failures === 0 ? "\nrun-start-concurrency: PASS" : `\nrun-start-concurrency: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
