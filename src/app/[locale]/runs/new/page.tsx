import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireSession } from "@/auth/require";
import { RunForm } from "@/components/runs/run-form";
import { db } from "@/db";
import { installationForWorkspace } from "@/db/queries/github";
import { listStartableTemplates } from "@/db/queries/templates";
import { githubAppConfigured, requireGithubApp } from "@/env";
import { InstallationTokens, listInstallationRepos } from "@/lib/github/app";
import type { Locale } from "@/i18n/routing";
import { requireWorkspace } from "@/lib/workspaces/provision";

export const dynamic = "force-dynamic";

export default async function NewRunPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession(locale);

  const [t, templates, workspaceId] = await Promise.all([
    getTranslations("newRun"),
    listStartableTemplates(locale),
    requireWorkspace(db, session.user),
  ]);

  const repos = await connectedRepos(workspaceId);

  // One template in v1. When there are several this becomes a picker; until
  // then, rendering a chooser with a single option is noise.
  const template = templates[0];

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>

      {!template ? (
        <p className="text-muted-foreground mt-2 text-sm">{t("noTemplates")}</p>
      ) : (
        <>
          <p className="text-muted-foreground mt-1 mb-6 text-sm">{template.summary}</p>
          <RunForm
            locale={locale}
            template={template}
            repos={repos}
            labels={{
              submit: t("submit"),
              submitting: t("submitting"),
              optional: t("optional"),
              errorHeading: t("errorHeading"),
              quotaAllowance: t("quotaAllowance"),
              quotaConcurrency: t("quotaConcurrency"),
              notSignedIn: t("notSignedIn"),
              unknownTemplate: t("unknownTemplate"),
              requestFailed: t("requestFailed"),
              fields: {
                repo: t("fields.repo"),
                issue: t("fields.issue"),
                audience: t("fields.audience"),
              },
              hints: {
                repo: t("hints.repo"),
                issue: t("hints.issue"),
              },
            }}
          />
        </>
      )}
    </div>
  );
}


/**
 * The repositories this workspace can reach, for the picker.
 *
 * Returns none rather than throwing when GitHub is unreachable or the App was
 * uninstalled: the form still works with a typed-in public URL, and a settings
 * problem should not make it impossible to start any run at all.
 */
async function connectedRepos(workspaceId: string): Promise<string[]> {
  if (!githubAppConfigured) return [];

  try {
    const installationId = await installationForWorkspace(db, workspaceId);
    if (!installationId) return [];

    const tokens = new InstallationTokens(requireGithubApp());
    const repos = await listInstallationRepos(await tokens.get(installationId));
    return repos.map((repo) => repo.fullName).sort();
  } catch (error) {
    console.error("[github] could not list installation repositories:", error);
    return [];
  }
}
