import { Plus } from "lucide-react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";

import { requireSession } from "@/auth/require";
import { RunStatusBadge } from "@/components/dashboard/run-status-badge";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { listWorkspaceRuns, workspaceUsage } from "@/db/queries/dashboard";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { requireWorkspace } from "@/lib/workspaces/provision";

// The signed-in view of live data; never prerendered or cached.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await requireSession(locale);

  // requireWorkspace, not workspaceForUser: an account that predates the
  // sign-up hook would otherwise land on a dashboard that cannot load.
  const workspaceId = await requireWorkspace(db, session.user);

  const [t, format, runs, usage] = await Promise.all([
    getTranslations("dashboard"),
    getFormatter(),
    listWorkspaceRuns(workspaceId, locale),
    workspaceUsage(workspaceId, new Date()),
  ]);

  const remaining = Math.max(0, usage.allowanceTokens - usage.usedTokens);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("allowance", {
              remaining: format.number(remaining),
              allowance: format.number(usage.allowanceTokens),
            })}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/runs/new">
            <Plus className="size-4" aria-hidden />
            {t("newRun")}
          </Link>
        </Button>
      </header>

      {runs.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed px-6 py-16 text-center">
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
          <Button asChild variant="secondary" size="sm" className="mt-4">
            <Link href="/runs/new">{t("newRun")}</Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-border/60 divide-y">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                href={`/runs/${run.id}`}
                className="hover:bg-muted/40 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded px-2 py-3"
              >
                <RunStatusBadge status={run.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{run.title}</span>
                  {run.repo ? (
                    <span className="text-muted-foreground block truncate font-mono text-xs">
                      {run.repo}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                  {format.number(run.totalTokens)} {t("tokens")}
                  {run.durationMs !== null
                    ? ` · ${Math.round(run.durationMs / 1000)}s`
                    : ""}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {format.dateTime(run.queuedAt, { dateStyle: "medium" })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
