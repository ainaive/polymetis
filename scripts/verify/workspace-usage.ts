/**
 * PASS/FAIL verification for workspace usage and quota inputs (M3b).
 *
 * checkQuota is unit-tested; what needs a database is the query that feeds it.
 * Getting the period boundary or the in-flight count wrong does not fail
 * loudly — it silently lets a workspace spend more than its allowance, or
 * refuses one that has spent nothing.
 *
 *   DATABASE_URL=... bun run scripts/verify/workspace-usage.ts
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { currentPeriodStart, workspaceUsage } from "@/db/queries/dashboard";
import { runs, templateVersions, templates, workspaces } from "@/db/schema";
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

const workspaceId = newId("ws");
const templateId = newId("tpl");
const versionId = newId("tplv");
const runIds = [newId("run"), newId("run"), newId("run"), newId("run")];

const NOW = new Date();
const periodStart = currentPeriodStart(NOW);
/** A day inside the current period, and one comfortably before it. */
const thisPeriod = new Date(periodStart.getTime() + 60_000);
const lastPeriod = new Date(periodStart.getTime() - 86_400_000);

async function setup() {
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `verify-usage-${workspaceId}`,
    name: "usage",
    monthlyTokenAllowance: 1_000_000,
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

  // Two settled runs this period, one settled last period, one still running.
  const rows: {
    id: string;
    queuedAt: Date;
    status: "succeeded" | "running";
    tokens: number;
  }[] = [
    { id: runIds[0]!, queuedAt: thisPeriod, status: "succeeded", tokens: 100 },
    { id: runIds[1]!, queuedAt: thisPeriod, status: "succeeded", tokens: 250 },
    { id: runIds[2]!, queuedAt: lastPeriod, status: "succeeded", tokens: 999_000 },
    { id: runIds[3]!, queuedAt: thisPeriod, status: "running", tokens: 0 },
  ];

  for (const row of rows) {
    await db.insert(runs).values({
      id: row.id,
      workspaceId,
      templateVersionId: versionId,
      inputs: {},
      status: row.status,
      queuedAt: row.queuedAt,
      // Spread across the four columns, because usage has to sum all of them:
      // cache traffic is most of a real run's tokens.
      inputTokens: row.tokens,
      outputTokens: row.tokens,
      cacheReadTokens: row.tokens,
      cacheCreationTokens: row.tokens,
    });
  }
}

async function teardown() {
  await db.delete(runs).where(inArray(runs.id, runIds));
  await db.delete(templates).where(eq(templates.id, templateId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

async function main() {
  await setup();

  const usage = await workspaceUsage(workspaceId, NOW);

  check(
    "usage sums all four token columns",
    // (100 + 250) across four columns each.
    usage.usedTokens === (100 + 250) * 4,
    `got ${usage.usedTokens}`,
  );
  check(
    "last period's spend is not counted against this month",
    // The 999,000-token run would exhaust the allowance on its own.
    usage.usedTokens < 1_000_000,
    `got ${usage.usedTokens}`,
  );
  check(
    "the allowance comes from the workspace",
    usage.allowanceTokens === 1_000_000,
    `got ${usage.allowanceTokens}`,
  );
  check(
    "a running run counts as in flight",
    usage.inFlight === 1,
    `got ${usage.inFlight}`,
  );
  check(
    "the period starts at the first of the month, UTC",
    usage.periodStart.toISOString().endsWith("-01T00:00:00.000Z"),
    usage.periodStart.toISOString(),
  );

  // A workspace with no runs at all must read as zero, not as nothing.
  const emptyId = newId("ws");
  await db.insert(workspaces).values({
    id: emptyId,
    slug: `verify-empty-${emptyId}`,
    name: "empty",
  });
  const empty = await workspaceUsage(emptyId, NOW);
  check(
    "a workspace with no runs reports zero rather than failing",
    empty.usedTokens === 0 && empty.inFlight === 0 && empty.allowanceTokens > 0,
    JSON.stringify(empty),
  );
  await db.delete(workspaces).where(eq(workspaces.id, emptyId));
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("FAIL  the verification itself threw", error);
} finally {
  await teardown().catch((error) => console.error("teardown failed", error));
}

console.log(
  failures === 0 ? "\nworkspace-usage: PASS" : `\nworkspace-usage: ${failures} FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
