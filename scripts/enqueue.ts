/**
 * Queue a run for the worker to pick up.
 *
 * This is what makes the run loop exercisable before any UI exists — M3b's
 * "start run" action replaces it with the same two inserts behind a form.
 *
 *   DATABASE_URL=... bun run scripts/enqueue.ts <repo-url|path> [issue-file]
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { runQueue, runs, templateVersions, templates } from "@/db/schema";
import { newId } from "@/lib/ids";
import { classifyRepoSource } from "@/lib/runner/workdir";
import { ISSUE_TO_SPEC_SLUG } from "@/lib/templates/issue-to-spec";

const args = process.argv.slice(2).filter((arg) => arg !== "--public");
const isPublic = process.argv.includes("--public");
const repo = args[0];
const issuePath = args[1];
if (!repo) {
  console.error(
    "usage: bun run scripts/enqueue.ts <repo-url|path> [issue-file] [--public]",
  );
  process.exit(1);
}

// Fail here rather than in the worker: an unusable repo should be a message on
// the terminal you typed into, not a failed run someone has to go read.
classifyRepoSource(repo);

const issue = issuePath
  ? await Bun.file(issuePath).text()
  : `Title: Support deployment without a long-running worker process

The scheduler currently needs a separate always-on worker process. That rules
out hosting platforms that cannot keep a process alive and only offer scheduled
HTTP invocations. Work out what has to change, and what else in the app is
affected by not having a persistent process.`;

// The version the run pins — highest published, resolved once here so the run
// row records exactly which contract it ran under.
const [version] = await db
  .select({ id: templateVersions.id, version: templateVersions.version })
  .from(templateVersions)
  .innerJoin(templates, eq(templateVersions.templateId, templates.id))
  .where(
    and(eq(templates.slug, ISSUE_TO_SPEC_SLUG), isNotNull(templateVersions.publishedAt)),
  )
  .orderBy(desc(templateVersions.version))
  .limit(1);

if (!version) {
  console.error(`no published ${ISSUE_TO_SPEC_SLUG} template — run: bun run seed`);
  process.exit(1);
}

const runId = newId("run");

await db.transaction(async (tx) => {
  await tx.insert(runs).values({
    id: runId,
    templateVersionId: version.id,
    // `issue` is the text the agent is given; `issueSource` is where it came
    // from. A replay has to stand alone, and "(built-in sample)" is the first
    // thing to rule out when one looks wrong.
    inputs: {
      repo,
      issue,
      issueSource: issuePath ?? "(built-in sample)",
      audience: "engineer",
    },
    status: "queued",
    // Unlisted unless asked otherwise: reachable by its link, listed nowhere.
    // Not private, because a private run needs an owning workspace to be
    // readable at all and a script has no session to belong to — and not
    // public, because `inputs` stores the issue text verbatim and publishing
    // someone's issue by default is not a mistake they can take back.
    visibility: isPublic ? "public" : "unlisted",
  });
  // Same transaction: a run row with no queue row is a run nothing will ever
  // pick up, and it would sit as "queued" forever.
  await tx.insert(runQueue).values({ runId });
});

console.log(`queued ${runId}`);
console.log(`repo   ${repo}`);
console.log(`visible ${isPublic ? "public" : "unlisted"}`);
console.log(`watch  /en/runs/${runId}`);

process.exit(0);
