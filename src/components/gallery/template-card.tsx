import { Clock, GitBranch, PlayCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { GalleryEntry } from "@/db/queries/runs";
import { Link } from "@/i18n/navigation";

export type GalleryCardLabels = {
  watchReplay: string;
  runIt: string;
  runItSoon: string;
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
    <article className="group hover:border-foreground/20 relative flex flex-col gap-3 rounded-xl border p-5 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
          {entry.category}
        </Badge>
        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
          ${Number(entry.costUsd).toFixed(2)}
        </span>
      </div>

      <div className="flex-1">
        {/* The whole card is the replay link; the overlay keeps one tab stop
            while leaving the nested elements selectable. */}
        <h2 className="text-base font-semibold tracking-tight">
          <Link href={`/runs/${entry.runId}`} className="after:absolute after:inset-0">
            {entry.title}
          </Link>
        </h2>
        <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
          {entry.summary}
        </p>
      </div>

      <dl className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
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
        <span className="text-foreground text-sm font-medium">
          {labels.watchReplay} →
        </span>
        {/* Running a template needs an account and a connected repo, which
            arrive in M3. Shown as unavailable rather than hidden, so the card
            communicates what the product will do. */}
        <span className="text-muted-foreground/50 ml-auto text-xs" aria-disabled>
          {labels.runItSoon}
        </span>
      </div>
    </article>
  );
}
