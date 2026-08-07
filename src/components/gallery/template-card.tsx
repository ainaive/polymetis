import { ArrowUpRight, Clock, GitBranch, PlayCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { GalleryEntry } from "@/db/queries/runs";
import { Link } from "@/i18n/navigation";

export type GalleryCardLabels = {
  watchReplay: string;
  runIt: string;
  events: string;
};

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function TemplateCard({
  entry,
  labels,
}: {
  entry: GalleryEntry;
  labels: GalleryCardLabels;
}) {
  return (
    <article className="group hover:border-foreground/25 flex flex-col gap-3 rounded-xl border p-5 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
          {entry.category}
        </Badge>
        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
          ${Number(entry.costUsd).toFixed(2)}
        </span>
      </div>

      <div>
        <h3 className="text-base font-semibold tracking-tight">{entry.title}</h3>
        {entry.issue ? (
          <p className="text-muted-foreground mt-0.5 font-mono text-xs">{entry.issue}</p>
        ) : null}
      </div>

      {/*
        The deliverable, not another number about the run. Everything else on
        this card describes how the run went; this is the only part that shows
        what it produced, which is the thing being sold.
      */}
      {entry.preview ? (
        <p className="bg-muted/40 text-muted-foreground line-clamp-4 rounded-md px-3 py-2.5 text-[13px] leading-relaxed text-pretty">
          {entry.preview}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm text-pretty">{entry.summary}</p>
      )}

      <dl className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {entry.repo ? (
          <div className="flex items-center gap-1.5">
            <GitBranch className="size-3" aria-hidden />
            <dd className="font-mono">{entry.repo}</dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <Clock className="size-3" aria-hidden />
          <dd className="tabular-nums">{formatDuration(entry.durationMs)}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <PlayCircle className="size-3" aria-hidden />
          <dd className="tabular-nums">
            {entry.eventCount} {labels.events}
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-3 border-t pt-3">
        <Link
          href={`/runs/${entry.runId}`}
          className="text-foreground hover:text-foreground/80 text-sm font-medium"
        >
          {labels.watchReplay} →
        </Link>
        {/*
          A working link now that /runs/new exists. It carried a disabled
          "arrives in M3" label for two milestones after M3 shipped — the
          homepage's whole job is to send people here.
        */}
        <Link
          href={`/runs/new?template=${entry.templateSlug}`}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-0.5 text-xs"
        >
          {labels.runIt}
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>
    </article>
  );
}
