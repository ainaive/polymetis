"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  advancePlayhead,
  buildTimeline,
  frameIndexAt,
  type ReplayFrame,
  type StoredEvent,
} from "@/lib/events/fold";
import type { RunEventType } from "@/lib/events/schema";
import { cn } from "@/lib/utils";

import { EventRow, formatElapsed } from "./event-row";

const SPEEDS = [1, 2, 4, 8] as const;

/** Event types the filter chips expose. Ordered by how often they matter. */
const FILTERABLE: RunEventType[] = [
  "step.start",
  "agent.message",
  "tool.call",
  "tool.result",
  "artifact.write",
  "usage",
];

export type ReplayLabels = {
  play: string;
  pause: string;
  restart: string;
  speed: string;
  elapsed: string;
  cost: string;
  steps: string;
  filter: string;
  deliverable: string;
  emptyDeliverable: string;
  liveBadge: string;
  finished: string;
};

export function ReplayPlayer({
  events,
  artifact,
  labels,
}: {
  events: StoredEvent[];
  artifact: { path: string; content: string | null } | null;
  labels: ReplayLabels;
}) {
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const { frames, steps, durationMs } = timeline;

  // Localized like every other string on this page — the chips printed the raw
  // event type, which is English in every locale. Catalog keys cannot contain
  // dots, so the type maps onto an underscored key.
  const tEventType = useTranslations("replay.eventType");

  const [elapsedMs, setElapsedMs] = useState(durationMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
  const [hidden, setHidden] = useState<ReadonlySet<RunEventType>>(new Set());

  // The loop reads the playhead from a ref rather than from state, so the
  // rAF callback never has to derive the next value inside a state updater.
  // Updaters must be pure; calling setPlaying from inside one re-enters
  // render and, with React's double-invocation of updaters, spins into an
  // infinite loop that freezes the tab.
  const elapsedRef = useRef(durationMs);
  const seek = useCallback((ms: number) => {
    elapsedRef.current = ms;
    setElapsedMs(ms);
  }, []);

  // Drive the playhead from rAF deltas rather than an interval: an interval
  // drifts under load and throttles in a background tab, which would desync
  // the playhead from the events being rendered.
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      lastTickRef.current = null;
      return;
    }

    const tick = (now: number) => {
      const last = lastTickRef.current;
      lastTickRef.current = now;
      if (last !== null) {
        const { elapsedMs: next, ended } = advancePlayhead(
          elapsedRef.current,
          now - last,
          speed,
          durationMs,
        );
        // Both calls happen in a plain event callback, never inside a state
        // updater or an effect body.
        seek(next);
        if (ended) {
          setPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = null;
    };
  }, [playing, speed, durationMs, seek]);

  const cursor = frameIndexAt(frames, elapsedMs);
  const visible = useMemo(
    () => frames.slice(0, cursor + 1).filter((f) => !hidden.has(f.type)),
    [frames, cursor, hidden],
  );

  const costSoFar = cursor >= 0 ? frames[cursor].costUsdSoFar : 0;
  const atEnd = elapsedMs >= durationMs;

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Pressing play at the end restarts, rather than sitting on a dead button.
    if (elapsedMs >= durationMs) seek(0);
    setPlaying(true);
  }, [playing, elapsedMs, durationMs, seek]);

  const restart = useCallback(() => {
    seek(0);
    setPlaying(true);
  }, [seek]);

  const toggleType = useCallback((type: RunEventType) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  // Keep the newest visible event in view while playing, but leave the user's
  // scroll position alone when they are reading a paused replay.
  const streamRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!playing || !streamRef.current) return;
    streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [visible.length, playing]);

  // Only the artifact sections written by the playhead — the deliverable
  // should visibly assemble itself as the run proceeds.
  const artifactSoFar = useMemo(
    () =>
      frames
        .slice(0, cursor + 1)
        .filter((f): f is ReplayFrame & { type: "artifact.write" } =>
          f.type === "artifact.write",
        )
        .map((f) => f.payload.preview)
        .filter(Boolean)
        .join("\n\n"),
    [frames, cursor],
  );

  const deliverable = atEnd && artifact?.content ? artifact.content : artifactSoFar;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_1fr]">
        {/* Event stream */}
        <section className="flex min-h-0 flex-col rounded-lg border">
          <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
            <span className="text-muted-foreground mr-1 text-xs font-medium">
              {labels.filter}
            </span>
            {FILTERABLE.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                aria-pressed={!hidden.has(type)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  hidden.has(type)
                    ? "text-muted-foreground/50 border-dashed"
                    : "bg-secondary text-secondary-foreground",
                )}
              >
                {tEventType(type.replace(".", "_"))}
              </button>
            ))}
          </div>
          <ol
            ref={streamRef}
            className="min-h-0 flex-1 divide-y overflow-y-auto px-3 py-1"
          >
            {visible.map((frame) => (
              <EventRow key={frame.seq} frame={frame} />
            ))}
          </ol>
        </section>

        {/* Deliverable */}
        <section className="flex min-h-0 flex-col rounded-lg border">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-medium">{labels.deliverable}</span>
            {artifact ? (
              <code className="text-muted-foreground font-mono text-[11px]">
                {artifact.path}
              </code>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* While scrubbing, the panel assembles the per-section previews
                recorded in artifact.write events. At the end it switches to
                the stored artifact, which is the authoritative file — the
                previews are snapshots and can be truncated. */}
            {deliverable ? (
              <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {deliverable}
              </pre>
            ) : (
              <p className="text-muted-foreground/60 text-sm">
                {labels.emptyDeliverable}
              </p>
            )}
          </div>
        </section>
      </div>

      {/* Transport */}
      <div className="rounded-lg border px-3 py-3">
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="secondary"
            onClick={togglePlay}
            aria-label={playing ? labels.pause : labels.play}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={restart}
            aria-label={labels.restart}
          >
            <RotateCcw className="size-4" />
          </Button>

          <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
            {formatElapsed(elapsedMs)} / {formatElapsed(durationMs)}
          </span>

          <div className="relative flex-1">
            <input
              type="range"
              min={0}
              max={durationMs}
              // "any" rather than a fixed step: a step of 100 caps the slider
              // at floor(durationMs/100)*100, so on a run of 609,782ms the end
              // is unreachable by 82ms and the final events — including every
              // usage event — never render. Only shows up on a duration that
              // is not a round multiple of the step.
              step="any"
              value={elapsedMs}
              onChange={(e) => {
                setPlaying(false);
                seek(Number(e.target.value));
              }}
              aria-label={labels.elapsed}
              className="accent-foreground w-full"
            />
            {/* Step markers, so the scrub bar shows the run's structure. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
              {steps.map((step) => (
                <span
                  key={step.seq}
                  className="bg-foreground/30 absolute top-1/2 h-2 w-px -translate-y-1/2"
                  style={{
                    left: `${durationMs > 0 ? (step.offsetMs / durationMs) * 100 : 0}%`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="flex shrink-0 gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                aria-pressed={speed === s}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
                  speed === s
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground",
                )}
              >
                {s}×
              </button>
            ))}
          </div>

          <Badge variant="secondary" className="shrink-0 font-mono tabular-nums">
            ${costSoFar.toFixed(4)}
          </Badge>
        </div>

        {/* Chapter markers */}
        {steps.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {steps.map((step) => {
              const active =
                cursor >= 0 && frames[cursor].offsetMs >= step.offsetMs;
              return (
                <button
                  key={step.seq}
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    seek(step.offsetMs);
                  }}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    active
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Announce completion. This must not reuse labels.elapsed — that is the
          scrub control's accessible name, so a screen reader would hear a
          control name where a status is expected. */}
      <span className="sr-only" aria-live="polite">
        {atEnd ? labels.finished : null}
      </span>
    </div>
  );
}
