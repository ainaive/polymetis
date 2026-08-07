import { eq } from "drizzle-orm";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireSession } from "@/auth/require";
import { DisconnectInstallationButton } from "@/components/settings/disconnect-installation";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { env, githubAppConfigured } from "@/env";
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

  // GitHub appends installation_id to whatever callback URL the App declares;
  // the locale rides along so the callback can send people back to the page
  // they started from rather than always to English.
  const installUrl = githubAppConfigured
    ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(locale)}`
    : null;

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
          {query.error === "missing-installation" ? t("errorMissing") : t("errorFailed")}
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
