import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { ReplayPlayer } from "@/components/replay/replay-player";
import { Badge } from "@/components/ui/badge";
import { getReplay } from "@/db/queries/runs";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";

type Props = { params: Promise<{ locale: Locale; runId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, runId } = await params;
  const replay = await getReplay(runId, locale);
  if (!replay) return {};
  return {
    title: `${replay.template.title} — Polymetis`,
    description: replay.template.summary,
  };
}

export default async function ReplayPage({ params }: Props) {
  const { locale, runId } = await params;
  setRequestLocale(locale);

  const replay = await getReplay(runId, locale);
  if (!replay) notFound();

  const t = await getTranslations("replay");
  const durationMs =
    replay.run.startedAt && replay.run.endedAt
      ? replay.run.endedAt.getTime() - replay.run.startedAt.getTime()
      : 0;

  return (
    <div className="mx-auto flex h-dvh max-w-7xl flex-col gap-4 px-4 py-5">
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
          <Badge
            variant={replay.run.status === "succeeded" ? "secondary" : "destructive"}
          >
            {replay.run.status}
          </Badge>
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {(replay.run.inputTokens + replay.run.outputTokens).toLocaleString()}{" "}
            {t("tokens")} · ${Number(replay.run.costUsd).toFixed(4)} ·{" "}
            {Math.round(durationMs / 1000)}s
          </span>
        </div>
      </header>

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
        }}
      />
    </div>
  );
}
