import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { getSession } from "@/auth/session";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { requireGithubApp } from "@/env";
import { createInstallationToken } from "@/lib/github/app";
import { newId } from "@/lib/ids";
import { requireWorkspace } from "@/lib/workspaces/provision";

/**
 * Where GitHub sends someone after they install the App.
 *
 * GitHub appends `installation_id` and `setup_action`. Neither is a secret and
 * both are attacker-supplied, so the id is proved rather than believed: minting
 * a token for it requires the App's private key, and GitHub only issues one for
 * an installation that really exists. Recording an id we could not mint for
 * would let anyone attach someone else's installation to their own workspace.
 */
export async function GET(request: NextRequest) {
  const locale = request.nextUrl.searchParams.get("locale") ?? "en";
  const settings = new URL(`/${locale}/settings/github`, request.nextUrl.origin);

  const session = await getSession();
  if (!session) {
    return Response.redirect(new URL(`/${locale}/sign-in`, request.nextUrl.origin), 302);
  }

  const installationId = request.nextUrl.searchParams.get("installation_id");
  if (!installationId) {
    settings.searchParams.set("error", "missing-installation");
    return Response.redirect(settings, 302);
  }

  try {
    const app = requireGithubApp();

    // The proof. Also the first moment we learn which account it is on.
    const token = await createInstallationToken(app, installationId);
    const accountLogin = await installationAccountLogin(token.token);

    const workspaceId = await requireWorkspace(db, session.user);

    await db
      .insert(githubInstallations)
      .values({
        id: newId("ghi"),
        workspaceId,
        installationId,
        accountLogin,
        connectedByUserId: session.user.id,
      })
      // Reinstalling reuses the installation id. Moving it to the current
      // workspace is what someone reconnecting expects, and it keeps the
      // uniqueness constraint from turning a normal action into an error.
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: { workspaceId, accountLogin, connectedByUserId: session.user.id },
      });

    settings.searchParams.set("connected", accountLogin);
    return Response.redirect(settings, 302);
  } catch (error) {
    // The detail goes to the log; the page gets a code it can translate.
    console.error("[github] installation callback failed:", error);
    settings.searchParams.set("error", "install-failed");
    return Response.redirect(settings, 302);
  }
}

/** Which account the installation is on, from the token's own metadata. */
async function installationAccountLogin(token: string): Promise<string> {
  const response = await fetch("https://api.github.com/installation/repositories?per_page=1", {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "polymetis",
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return "unknown";

  const payload = (await response.json()) as { repositories?: { owner?: { login?: unknown } }[] };
  const login = payload.repositories?.[0]?.owner?.login;
  // An installation with no repositories selected yet is legitimate; it simply
  // has nothing to name itself after.
  return typeof login === "string" ? login : "unknown";
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) return new Response(null, { status: 401 });

  const installationId = request.nextUrl.searchParams.get("installation_id");
  if (!installationId) return new Response(null, { status: 400 });

  const workspaceId = await requireWorkspace(db, session.user);

  // Matched on both, and deleted by primary key. An installation id is not a
  // secret, so a query keyed on it alone would let anyone disconnect anyone
  // else's — and deleting by workspace alone would take every installation that
  // workspace has, not the one that was asked for.
  const [row] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(githubInstallations.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!row) return new Response(null, { status: 404 });

  await db.delete(githubInstallations).where(eq(githubInstallations.id, row.id));

  return new Response(null, { status: 204 });
}
