import { eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireSession } from "@/auth/require";
import { DisconnectInstallationButton } from "@/components/settings/disconnect-installation";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { env, githubAppConfigured } from "@/env";
import { signInstallState } from "@/lib/github/install-state";
import type { Locale } from "@/i18n/routing";
import { requireWorkspace } from "@/lib/workspaces/provision";

export const dynamic = "force-dynamic";

export default async function GithubSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession(locale);

  const [t, workspaceId, query] = await Promise.all([
    getTranslations("githubSettings"),
    requireWorkspace(db, session.user),
    searchParams,
  ]);

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId))
    .limit(1);

  const installUrl = buildInstallUrl(session.user.id, locale);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{t("subtitle")}</p>

      {query.connected ? (
        <p className="mt-4 text-sm text-emerald-600">
          {t("connectedTo", { account: query.connected })}
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {t(ERROR_KEYS[query.error] ?? "errorFailed")}
        </p>
      ) : null}

      <div className="border-border/60 mt-6 rounded-lg border p-4">
        {!githubAppConfigured ? (
          // Said plainly rather than hidden: an operator who has not registered
          // the App should see why the button is absent.
          <p className="text-muted-foreground text-sm">{t("notConfigured")}</p>
        ) : installation ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{installation.accountLogin}</p>
              <p className="text-muted-foreground text-xs">{t("connectedHint")}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={installUrl!} rel="noreferrer">
                  {t("manage")}
                </a>
              </Button>
              <DisconnectInstallationButton
                installationId={installation.installationId}
                label={t("disconnect")}
                failedLabel={t("disconnectFailed")}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">{t("notConnected")}</p>
            <Button asChild size="sm">
              <a href={installUrl!} rel="noreferrer">
                {t("connect")}
              </a>
            </Button>
          </div>
        )}
      </div>

      <p className="text-muted-foreground mt-4 text-xs">{t("scopeNote")}</p>
    </div>
  );
}

/**
 * The App's install link, carrying a signed state bound to this session.
 *
 * The callback will not act on an installation without one, because everything
 * else GitHub sends it is attacker-supplied. Built outside the component
 * because it reads the clock, which a component body must not do — the same
 * rule that catches time-dependent rendering before it becomes a hydration
 * mismatch.
 */
function buildInstallUrl(userId: string, locale: Locale): string | null {
  if (!githubAppConfigured) return null;

  const state = signInstallState(
    { userId, locale },
    env.BETTER_AUTH_SECRET,
    Date.now(),
  );
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * Callback failure codes, mapped to what a person can do about them.
 *
 * Anything unrecognised falls back to the generic message rather than being
 * rendered raw — a query parameter is attacker-controlled text.
 */
const ERROR_KEYS: Record<string, string> = {
  "missing-installation": "errorMissing",
  "no-state": "errorNoState",
  "wrong-user": "errorWrongUser",
  "no-code": "errorNoCode",
  "not-yours": "errorNotYours",
  "already-claimed": "errorAlreadyClaimed",
  "install-failed": "errorFailed",
};
