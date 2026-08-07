/**
 * PASS/FAIL verification that a run's visibility is enforced (M3b).
 *
 * The unit tests cover the predicate; this covers the thing that actually
 * matters — that the query real readers go through applies it. M3a shipped with
 * neither the replay page nor the SSE route checking, so this is the regression
 * that must never come back.
 *
 *   DATABASE_URL=... bun run scripts/verify/run-access.ts
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { getReplay } from "@/db/queries/runs";
import {
  runs,
  templateI18n,
  templateVersions,
  templates,
  workspaces,
} from "@/db/schema";
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

const ownerWorkspace = newId("ws");
const strangerWorkspace = newId("ws");
const templateId = newId("tpl");
const versionId = newId("tplv");
const runIds = {
  private: newId("run"),
  unlisted: newId("run"),
  public: newId("run"),
  orphanPrivate: newId("run"),
};

async function setup() {
  for (const [id, slug] of [
    [ownerWorkspace, "owner"],
    [strangerWorkspace, "stranger"],
  ] as const) {
    await db.insert(workspaces).values({ id, slug: `verify-${slug}-${id}`, name: slug });
  }

  await db.insert(templates).values({
    id: templateId,
    workspaceId: ownerWorkspace,
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
  // getReplay inner-joins the localized copy, so it has to exist.
  await db.insert(templateI18n).values({
    templateVersionId: versionId,
    locale: "en",
    title: "verify",
    summary: "verify",
  });

  for (const [key, visibility, workspaceId] of [
    ["private", "private", ownerWorkspace],
    ["unlisted", "unlisted", ownerWorkspace],
    ["public", "public", ownerWorkspace],
    ["orphanPrivate", "private", null],
  ] as const) {
    await db.insert(runs).values({
      id: runIds[key],
      workspaceId,
      templateVersionId: versionId,
      inputs: {},
      status: "succeeded",
      visibility,
    });
  }
}

async function teardown() {
  await db.delete(runs).where(inArray(runs.id, Object.values(runIds)));
  await db.delete(templates).where(eq(templates.id, templateId));
  await db
    .delete(workspaces)
    .where(inArray(workspaces.id, [ownerWorkspace, strangerWorkspace]));
}

const asOwner = { workspaceId: ownerWorkspace };
const asStranger = { workspaceId: strangerWorkspace };
const asSignedOut = { workspaceId: null };

async function main() {
  await setup();

  // --- private ------------------------------------------------------------
  check(
    "the owning workspace can read its own private run",
    (await getReplay(runIds.private, "en", asOwner)) !== null,
  );
  check(
    "another workspace cannot read a private run",
    (await getReplay(runIds.private, "en", asStranger)) === null,
  );
  check(
    "a signed-out reader cannot read a private run",
    (await getReplay(runIds.private, "en", asSignedOut)) === null,
  );
  check(
    "the default viewer is signed out, so a caller that forgets one reads nothing",
    // getReplay's viewer defaults to no workspace. A page that forgets to pass
    // one must fail closed rather than silently return a private run.
    (await getReplay(runIds.private, "en")) === null,
  );
  check(
    "a private run nobody owns is readable by nobody",
    (await getReplay(runIds.orphanPrivate, "en", asOwner)) === null &&
      (await getReplay(runIds.orphanPrivate, "en", asSignedOut)) === null,
  );

  // --- unlisted and public ------------------------------------------------
  check(
    "an unlisted run is readable by link, signed out",
    (await getReplay(runIds.unlisted, "en", asSignedOut)) !== null,
  );
  check(
    "a public run is readable by anyone",
    (await getReplay(runIds.public, "en", asStranger)) !== null,
  );

  // --- the gallery is unaffected ------------------------------------------
  const { listGallery } = await import("@/db/queries/runs");
  const gallery = await listGallery("en");
  check(
    "the gallery lists none of these runs",
    !gallery.some((entry) => Object.values(runIds).includes(entry.runId)),
    // It filters to public + isDemo; none of these are demos.
    gallery.map((entry) => entry.runId).join(","),
  );
}

try {
  await main();
} catch (error) {
  failures++;
  console.error("FAIL  the verification itself threw", error);
} finally {
  await teardown().catch((error) => console.error("teardown failed", error));
}

console.log(failures === 0 ? "\nrun-access: PASS" : `\nrun-access: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
