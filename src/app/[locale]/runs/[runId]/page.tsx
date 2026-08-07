import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { cache } from "react";

import { RunStatusBadge } from "@/components/dashboard/run-status-badge";
import { LiveRun } from "@/components/replay/live-run";
import { ReplayPlayer } from "@/components/replay/replay-player";
import { Badge } from "@/components/ui/badge";
import { currentViewer } from "@/auth/viewer";
import { getReplay } from "@/db/queries/runs";
import { isTerminalRunStatus } from "@/lib/events/fold";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

type Props = { params: Promise<{ locale: Locale; runId: string }> };

// generateMetadata and the page body both need the replay, and getReplay reads
// the run's entire event log — uncached, every request materialized it twice.
// The wrapper lives here rather than beside getReplay because src/db is kept
// react-free by the import boundary.
const loadReplay = cache(async (runId: string, locale: Locale) =>
  getReplay(runId, locale, await currentViewer()),
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, runId } = await params;
  // The same viewer check: a page title is content, and returning one for a run
  // the reader cannot open would leak the template and repository through a
  // link preview.
  const replay = await loadReplay(runId, locale);
  if (!replay) return {};
  return {
    title: `${replay.template.title} — Polymetis`,
    description: replay.template.summary,
  };
}

export default async function ReplayPage({ params }: Props) {
  const { locale, runId } = await params;
  setRequestLocale(locale);

  const replay = await loadReplay(runId, locale);
  if (!replay) notFound();

  const t = await getTranslations("replay");
  // Formatted against the request locale, not the server's. toLocaleString()
  // with no argument reads the host's default, so a zh reader would get whatever
  // grouping the machine happens to run — and the same page would render
  // differently in dev and in production.
  const format = await getFormatter();
  // Not terminal means the log can still grow, which is the only thing that
  // decides between the tail and the player.
  const live = !isTerminalRunStatus(replay.run.status);
  const durationMs =
    replay.run.startedAt && replay.run.endedAt
      ? replay.run.endedAt.getTime() - replay.run.startedAt.getTime()
      : 0;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground mb-1.5 inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeft className="size-3" />
            {t("backToGallery")}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">
            {replay.template.title}
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {Object.entries(replay.run.inputs).map(([key, value], i) => (
              <span key={key}>
                {i > 0 ? " · " : ""}
                <span className="text-muted-foreground/60">{key}:</span> {value}
              </span>
            ))}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {replay.run.isDemo ? (
            <Badge variant="outline">{t("demoRun")}</Badge>
          ) : null}
          {/* The same badge the dashboard uses. This printed the raw database
              value, which is English in every locale — on the one page built to
              be shared. */}
          <RunStatusBadge status={replay.run.status} />
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {t("usageLine", {
              tokens: format.number(
                replay.run.inputTokens +
                  replay.run.cacheReadTokens +
                  replay.run.cacheCreationTokens +
                  replay.run.outputTokens,
              ),
              cost: Number(replay.run.costUsd).toFixed(4),
              seconds: Math.round(durationMs / 1000),
            })}
          </span>
        </div>
      </header>

      {replay.run.purgedAt ? (
        // Said, not shown as an empty player. A replay with no events renders
        // as a run that did nothing, which is a different and wrong claim.
        <div className="border-border/60 rounded-lg border border-dashed px-6 py-16 text-center">
          <p className="text-muted-foreground text-sm">
            {t("purged", {
              date: format.dateTime(replay.run.purgedAt, { dateStyle: "medium" }),
            })}
          </p>
        </div>
      ) : live ? (
        // A run that has not finished has no duration to scrub over, so it gets
        // a tail rather than the player. router.refresh() swaps in the player
        // once run.end arrives.
        <LiveRun
          runId={replay.run.id}
          initialEvents={replay.events}
          labels={{
            connecting: t("liveConnecting"),
            live: t("liveBadge"),
            ended: t("liveEnded"),
            waiting: t("liveWaiting"),
            reconnecting: t("liveReconnecting"),
            replayFromStart: t("replayFromStart"),
            tokens: t("tokens"),
          }}
        />
      ) : (
        <ReplayPlayer
          events={replay.events}
          artifact={replay.artifact}
          labels={{
            play: t("play"),
            pause: t("pause"),
            restart: t("restart"),
            speed: t("speed"),
            elapsed: t("elapsed"),
            cost: t("cost"),
            steps: t("steps"),
            filter: t("filter"),
            deliverable: t("deliverable"),
            emptyDeliverable: t("emptyDeliverable"),
            liveBadge: t("liveBadge"),
            finished: t("finished"),
          }}
        />
      )}
    </div>
  );
}
