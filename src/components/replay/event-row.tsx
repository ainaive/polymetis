"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FileText,
  Flag,
  MessageSquare,
  Play,
  Receipt,
  Wrench,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";

import type { ReplayFrame } from "@/lib/events/fold";
import type { RunEventType } from "@/lib/events/schema";
import { cn } from "@/lib/utils";

const ICONS: Record<RunEventType, typeof Play> = {
  "run.start": Play,
  "step.start": Flag,
  "tool.call": Wrench,
  "tool.result": CheckCircle2,
  "agent.message": MessageSquare,
  "artifact.write": FileText,
  usage: Receipt,
  error: AlertTriangle,
  "run.end": CircleDot,
};

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** One event in the stream. Kept dumb so the player owns all timing state. */
function EventRowImpl({ frame }: { frame: ReplayFrame }) {
  const failed =
    (frame.type === "tool.result" && !frame.payload.ok) || frame.type === "error";
  const Icon = failed ? XCircle : ICONS[frame.type];

  return (
    <li className="flex gap-3 py-2.5">
      <span className="text-muted-foreground/60 w-10 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums">
        {formatElapsed(frame.offsetMs)}
      </span>
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          failed ? "text-destructive" : "text-muted-foreground",
          frame.type === "step.start" && "text-foreground",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-sm">
        <EventBody frame={frame} />
      </div>
    </li>
  );
}

function EventBody({ frame }: { frame: ReplayFrame }) {
  // Read from the catalog rather than hardcoding English: the event stream is
  // the bulk of the replay page's text, and a localized frame around an
  // English stream is the worst of both. Messages use whole-sentence ICU
  // patterns with tags, not word fragments, so word order stays correct in
  // each locale.
  const t = useTranslations("replay.event");
  // The same catalog RunStatusBadge reads: run.end carries the raw enum value,
  // which is English in every locale, so it is translated before interpolation
  // rather than rendered as-is. (The page header badge was fixed for exactly
  // this; this row had the same leak.)
  const tStatus = useTranslations("dashboard.status");

  switch (frame.type) {
    case "run.start": {
      const target = frame.payload.issue
        ? `${frame.payload.issue.owner}/${frame.payload.issue.name}#${frame.payload.issue.number}`
        : null;
      return (
        <p className="text-muted-foreground">
          {target
            ? t.rich("runStartOn", {
                template: frame.payload.templateSlug,
                target,
                code: (chunks) => <Mono>{chunks}</Mono>,
              })
            : t.rich("runStart", {
                template: frame.payload.templateSlug,
                code: (chunks) => <Mono>{chunks}</Mono>,
              })}
        </p>
      );
    }

    case "step.start":
      return <p className="font-medium">{frame.payload.label}</p>;

    case "tool.call":
      return (
        <p className="text-muted-foreground">
          <span className="text-foreground font-medium">{frame.payload.tool}</span>{" "}
          <Mono>{frame.payload.summary}</Mono>
        </p>
      );

    case "tool.result":
      return (
        <p className={cn("text-muted-foreground", !frame.payload.ok && "text-destructive")}>
          {frame.payload.summary}
          {frame.payload.detail ? (
            <span className="text-muted-foreground/70 mt-1 block font-mono text-xs whitespace-pre-wrap">
              {frame.payload.detail}
            </span>
          ) : null}
        </p>
      );

    case "agent.message":
      return <p className="text-pretty">{frame.payload.text}</p>;

    case "artifact.write":
      return (
        <p className="text-muted-foreground">
          {t.rich("artifactWrite", {
            target: frame.payload.section ?? frame.payload.path,
            bytes: frame.payload.bytes,
            name: (chunks) => (
              <span className="text-foreground font-medium">{chunks}</span>
            ),
          })}
        </p>
      );

    case "usage":
      return (
        <p className="text-muted-foreground/80 tabular-nums">
          {t("usage", {
            // Cache traffic included: on an agentic run it is most of the
            // tokens, and a row claiming otherwise understates by orders of
            // magnitude.
            tokens:
              frame.payload.inputTokens +
              (frame.payload.cacheReadTokens ?? 0) +
              (frame.payload.cacheCreationTokens ?? 0) +
              frame.payload.outputTokens,
            cost: frame.payload.costUsd.toFixed(4),
          })}
        </p>
      );

    case "error":
      return <p className="text-destructive">{frame.payload.message}</p>;

    case "run.end":
      return (
        <p className="text-muted-foreground">
          {t.rich("runEnd", {
            status: tStatus(frame.payload.status),
            duration: formatElapsed(frame.payload.durationMs),
            name: (chunks) => (
              <span className="text-foreground font-medium">{chunks}</span>
            ),
          })}
        </p>
      );
  }
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{children}</code>
  );
}

/**
 * Compared by seq, not by identity.
 *
 * buildTimeline rebuilds every frame object whenever the event list changes, so
 * the default shallow compare never matches and a live run re-renders all of
 * its rows on each new event — each of which calls useTranslations. The log is
 * append-only (ADR-0001), so a given seq's frame content can never change:
 * offsetMs and costUsdSoFar depend only on events at or before it.
 */
export const EventRow = memo(EventRowImpl, (a, b) => a.frame.seq === b.frame.seq);
