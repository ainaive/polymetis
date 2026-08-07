import { and, eq, ne } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { getSession } from "@/auth/session";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { env, requireGithubApp } from "@/env";
import { routing } from "@/i18n/routing";
import {
  createInstallationToken,
  exchangeUserCode,
  userCanAccessInstallation,
} from "@/lib/github/app";
import { verifyInstallState } from "@/lib/github/install-state";
import { newId } from "@/lib/ids";
import { requireWorkspace } from "@/lib/workspaces/provision";

/**
 * Where GitHub sends someone after they install the App.
 *
 * Everything in the query string is attacker-supplied, including
 * `installation_id`. Three separate things therefore have to be established
 * before anything is written:
 *
 *  1. **Who is asking** — a signed `state` this server issued to this session.
 *  2. **That they can administer that installation** — checked against the
 *     user's own `/user/installations`, not inferred. Minting an installation
 *     token proves only that the installation exists and our App is on it,
 *     which is true of every other customer's installation too. An earlier
 *     version of this file used that as the proof and said so in a comment;
 *     it would have let anyone attach someone else's installation to their own
 *     workspace.
 *  3. **That it is not already someone else's** — first claim wins.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const session = await getSession();
  if (!session) {
    return redirectTo(request, "en", "/sign-in");
  }

  const state = verifyInstallState(
    params.get("state"),
    env.BETTER_AUTH_SECRET,
    Date.now(),
  );

  // No usable state: someone installed the App from GitHub's own page rather
  // than from ours, or the link is stale. Not an error, and not something to
  // act on either — they can connect from settings, which issues a fresh one.
  if (!state) {
    return redirectTo(request, "en", "/settings/github", { error: "no-state" });
  }

  const locale = safeLocale(state.locale);

  if (state.userId !== session.user.id) {
    // The install was started by someone else in this browser.
    return redirectTo(request, locale, "/settings/github", { error: "wrong-user" });
  }

  const installationId = params.get("installation_id");
  const code = params.get("code");
  if (!installationId) {
    return redirectTo(request, locale, "/settings/github", {
      error: "missing-installation",
    });
  }

  try {
    const app = requireGithubApp();

    // Fail closed. Without the OAuth code there is no way to tell whose
    // installation this is, and guessing is the whole vulnerability.
    if (!code) {
      return redirectTo(request, locale, "/settings/github", { error: "no-code" });
    }

    const userToken = await exchangeUserCode(app.clientId, app.clientSecret, code);
    if (!(await userCanAccessInstallation(userToken, installationId))) {
      return redirectTo(request, locale, "/settings/github", { error: "not-yours" });
    }

    const workspaceId = await requireWorkspace(db, session.user);

    // First claim wins. Reconnecting your own installation is normal; moving
    // one that another workspace already holds is a takeover, and the person
    // who holds it has to disconnect first.
    const [heldElsewhere] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.installationId, installationId),
          ne(githubInstallations.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (heldElsewhere) {
      return redirectTo(request, locale, "/settings/github", { error: "already-claimed" });
    }

    // Only now, and only to learn the account name for display.
    const installationToken = await createInstallationToken(app, installationId);
    const accountLogin = await installationAccountLogin(installationToken.token);

    await db
      .insert(githubInstallations)
      .values({
        id: newId("ghi"),
        workspaceId,
        installationId,
        accountLogin,
        connectedByUserId: session.user.id,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: { workspaceId, accountLogin, connectedByUserId: session.user.id },
      });

    return redirectTo(request, locale, "/settings/github", { connected: accountLogin });
  } catch (error) {
    // The detail goes to the log; the page gets a code it can translate.
    console.error("[github] installation callback failed:", error);
    return redirectTo(request, locale, "/settings/github", { error: "install-failed" });
  }
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

/**
 * A redirect that cannot leave this site.
 *
 * `new URL("//attacker.example/x", origin)` resolves to attacker.example — a
 * protocol-relative path in the first segment escapes the origin entirely. The
 * locale is therefore taken from the signed state and checked against the
 * configured set rather than interpolated from a query parameter.
 */
function redirectTo(
  request: NextRequest,
  locale: string,
  path: string,
  query: Record<string, string> = {},
): Response {
  const url = new URL(request.nextUrl.origin);
  url.pathname = `/${safeLocale(locale)}${path}`;
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return Response.redirect(url, 302);
}

function safeLocale(value: string): string {
  return (routing.locales as readonly string[]).includes(value)
    ? value
    : routing.defaultLocale;
}

/** Which account the installation is on, from the token's own metadata. */
async function installationAccountLogin(token: string): Promise<string> {
  const response = await fetch(
    "https://api.github.com/installation/repositories?per_page=1",
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "polymetis",
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) return "unknown";

  const payload = (await response.json()) as {
    repositories?: { owner?: { login?: unknown } }[];
  };
  const login = payload.repositories?.[0]?.owner?.login;
  // An installation with no repositories selected yet is legitimate; it simply
  // has nothing to name itself after.
  return typeof login === "string" ? login : "unknown";
}
