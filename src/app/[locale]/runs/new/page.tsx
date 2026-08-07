import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireSession } from "@/auth/require";
import { RunForm } from "@/components/runs/run-form";
import { listStartableTemplates } from "@/db/queries/templates";
import type { Locale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

export default async function NewRunPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSession(locale);

  const [t, templates] = await Promise.all([
    getTranslations("newRun"),
    listStartableTemplates(locale),
  ]);

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
            labels={{
              submit: t("submit"),
              submitting: t("submitting"),
              optional: t("optional"),
              errorHeading: t("errorHeading"),
              quotaAllowance: t("quotaAllowance"),
              quotaConcurrency: t("quotaConcurrency"),
              notSignedIn: t("notSignedIn"),
              unknownTemplate: t("unknownTemplate"),
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
