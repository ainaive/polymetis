import { getTranslations, setRequestLocale } from "next-intl/server";

import { TemplateCard } from "@/components/gallery/template-card";
import { listGallery } from "@/db/queries/runs";
import type { Locale } from "@/i18n/routing";

/**
 * Rendered per request rather than prerendered.
 *
 * The gallery reads curated runs from Postgres. Prerendering it would bake the
 * database contents into the build — a newly seeded run would not appear until
 * the next deploy, and the build itself would need a reachable database, which
 * makes CI depend on one for no good reason.
 *
 * When gallery traffic justifies it, the right move is caching this with an
 * explicit revalidation window, not returning to build-time rendering.
 */
export const dynamic = "force-dynamic";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("home");
  const entries = await listGallery(locale);

  return (
    <main className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
      <section className="max-w-3xl">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          {t("tagline")}
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          {t("headline")}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-2xl text-lg text-pretty">
          {t("subhead")}
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-muted-foreground mb-4 text-xs font-medium tracking-wide uppercase">
          {t("galleryHeading")}
        </h2>

        {entries.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed px-5 py-10 text-center text-sm">
            {t("galleryEmpty")}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((entry) => (
              <TemplateCard
                key={entry.runId}
                entry={entry}
                labels={{
                  watchReplay: t("watchReplay"),
                  runIt: t("runOnMyRepo"),
                  runItSoon: t("runOnMyRepoSoon"),
                  events: t("events"),
                }}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
