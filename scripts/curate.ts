/**
 * Promote a finished run into the public gallery, or take it back out.
 *
 * The gallery is curated by hand on purpose. Every card claims "this is a real
 * run against a real repository, watch the whole thing" — which is only worth
 * saying if someone read the deliverable first and decided it was worth
 * showing. This script enforces what can be checked automatically; the reading
 * is still yours.
 *
 *   DATABASE_URL=... bun run scripts/curate.ts list
 *   DATABASE_URL=... bun run scripts/curate.ts show    <runId>
 *   DATABASE_URL=... bun run scripts/curate.ts promote <runId>
 *   DATABASE_URL=... bun run scripts/curate.ts demote  <runId>
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { runArtifacts, runs } from "@/db/schema";
import { canCurate, type CurateCandidate } from "@/lib/runs/curate";

const [command, runId] = process.argv.slice(2);

async function candidate(id: string): Promise<CurateCandidate | null> {
  const [row] = await db
    .select({
      runId: runs.id,
      status: runs.status,
      inputs: runs.inputs,
      isDemo: runs.isDemo,
      // The outer column is written out as "runs"."id" rather than
      // interpolated. In a select-list template drizzle renders ${runs.id} as
      // the bare "id", which inside these subqueries binds to the *subquery's*
      // own id column — so every count came back zero for runs that plainly
      // had an artifact, with no error to notice.
      artifacts: sql<string>`(
        select count(*) from "runArtifacts" a where a."runId" = "runs"."id"
      )`,
      terminal: sql<string>`(
        select count(*) from "runEvents" e
        where e."runId" = "runs"."id" and e."type" = 'run.end'
      )`,
    })
    .from(runs)
    .where(eq(runs.id, id))
    .limit(1);

  if (!row) return null;

  return {
    runId: row.runId,
    status: row.status,
    repo: row.inputs.repo ?? null,
    hasArtifact: Number(row.artifacts) > 0,
    hasTerminalEvent: Number(row.terminal) > 0,
  };
}

async function list() {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      isDemo: runs.isDemo,
      visibility: runs.visibility,
      inputs: runs.inputs,
      tokens: sql<string>`${runs.inputTokens} + ${runs.outputTokens}
        + ${runs.cacheReadTokens} + ${runs.cacheCreationTokens}`,
      costUsd: runs.costUsd,
      bytes: sql<string>`coalesce((
        select sum(a."bytes") from "runArtifacts" a where a."runId" = "runs"."id"
      ), 0)`,
    })
    .from(runs)
    .where(eq(runs.status, "succeeded"))
    .orderBy(desc(runs.queuedAt))
    .limit(40);

  if (rows.length === 0) {
    console.log("no succeeded runs yet");
    return;
  }

  for (const row of rows) {
    const mark = row.isDemo ? "★" : " ";
    const repo = row.inputs.repo ?? "(none)";
    const decision = canCurate({
      runId: row.id,
      status: row.status,
      repo: row.inputs.repo ?? null,
      hasArtifact: Number(row.bytes) > 0,
      hasTerminalEvent: true,
    });
    const note = decision.ok ? "" : `  ← ${decision.detail}`;
    console.log(
      `${mark} ${row.id}  ${Number(row.tokens).toLocaleString().padStart(11)} tok  $${Number(row.costUsd).toFixed(2).padStart(6)}  ${String(row.bytes).padStart(6)}b  ${repo}${note}`,
    );
  }
  console.log("\n★ = in the gallery");
}

async function show(id: string) {
  const [row] = await db
    .select({
      inputs: runs.inputs,
      status: runs.status,
      path: runArtifacts.path,
      content: runArtifacts.content,
    })
    .from(runs)
    .leftJoin(runArtifacts, eq(runArtifacts.runId, runs.id))
    .where(eq(runs.id, id))
    .limit(1);

  if (!row) {
    console.error(`no run ${id}`);
    process.exit(1);
  }

  console.log(`repo   ${row.inputs.repo ?? "(none)"}`);
  console.log(`issue  ${row.inputs.issue ?? "(none)"}`);
  console.log(`status ${row.status}`);
  console.log(`\n--- ${row.path ?? "no deliverable"} ---\n`);
  console.log(row.content ?? "(nothing stored)");
}

async function promote(id: string) {
  const found = await candidate(id);
  if (!found) {
    console.error(`no run ${id}`);
    process.exit(1);
  }

  const decision = canCurate(found);
  if (!decision.ok) {
    console.error(`refused: ${decision.reason} — ${decision.detail}`);
    process.exit(1);
  }

  // isDemo and visibility move together. The gallery filters on both, so
  // setting one without the other yields a run that is either listed and
  // unreadable, or readable and invisible — each of which looks like a bug
  // from the outside.
  await db
    .update(runs)
    .set({ isDemo: true, visibility: "public" })
    .where(eq(runs.id, id));

  console.log(`promoted ${id} — public, in the gallery`);
}

async function demote(id: string) {
  const updated = await db
    .update(runs)
    .set({ isDemo: false })
    .where(and(eq(runs.id, id), eq(runs.isDemo, true)))
    .returning({ id: runs.id });

  if (updated.length === 0) {
    console.error(`${id} was not in the gallery`);
    process.exit(1);
  }

  // Visibility is left alone: a link someone already shared should keep
  // working after the run leaves the gallery.
  console.log(`demoted ${id} — still public by link, no longer listed`);
}

switch (command) {
  case "list":
    await list();
    break;
  case "show":
    if (!runId) {
      console.error("usage: curate.ts show <runId>");
      process.exit(1);
    }
    await show(runId);
    break;
  case "promote":
    if (!runId) {
      console.error("usage: curate.ts promote <runId>");
      process.exit(1);
    }
    await promote(runId);
    break;
  case "demote":
    if (!runId) {
      console.error("usage: curate.ts demote <runId>");
      process.exit(1);
    }
    await demote(runId);
    break;
  default:
    console.error("usage: curate.ts list | show <runId> | promote <runId> | demote <runId>");
    process.exit(1);
}

process.exit(0);
