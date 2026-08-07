"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useFormatter } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import {
  buildTimeline,
  totalInputTokens,
  type StoredEvent,
} from "@/lib/events/fold";
import { runEventTypes } from "@/lib/events/schema";
import { STREAM_CLOSED_EVENT } from "@/lib/events/sse";
import { cn } from "@/lib/utils";

import { EventRow, formatElapsed } from "./event-row";

/**
 * A run that is still executing.
 *
 * Deliberately not the replay player: a live run has no known duration, so a
 * scrub bar has nothing to scrub over and a speed control has nothing to speed
 * up. This is a tail — events arrive, the view follows them — and when the run
 * ends the page reloads into the player, which is built for a finished
 * timeline.
 */

export type LiveLabels = {
  connecting: string;
  live: string;
  ended: string;
  waiting: string;
  reconnecting: string;
  replayFromStart: string;
  tokens: string;
};

type Connection = "connecting" | "open" | "reconnecting" | "ended";

export function LiveRun({
  runId,
  initialEvents,
  labels,
}: {
  runId: string;
  /** Events already in the log when the page rendered. */
  initialEvents: StoredEvent[];
  labels: LiveLabels;
}) {
  const router = useRouter();
  // The route locale, not the browser's. toLocaleString() with no argument
  // reads navigator's default, so a /zh reader gets whatever grouping their
  // browser happens to use — the same bug already fixed on the replay header.
  const format = useFormatter();
  const [events, setEvents] = useState<StoredEvent[]>(initialEvents);
  const [connection, setConnection] = useState<Connection>("connecting");

  // The cursor lives in a ref because the effect below must not re-run when it
  // moves — reconnecting on every event would reopen the stream continuously.
  const cursor = useRef(initialEvents.at(-1)?.seq ?? 0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${runId}/events?after=${cursor.current}`);

    source.onopen = () => setConnection("open");

    const receive = (message: MessageEvent<string>) => {
      const event = parseEvent(message.data);
      if (!event) return;
      // Out-of-order or repeated frames are dropped rather than rendered: on
      // reconnect the browser resends Last-Event-ID, and a server that
      // over-delivers by one would otherwise duplicate a row.
      if (event.seq <= cursor.current) return;
      cursor.current = event.seq;
      setEvents((current) => [...current, event]);

      if (event.type === "run.end") {
        setConnection("ended");
        source.close();
      }
    };

    // One listener per event type, not `onmessage`. Every frame carries an
    // `event:` field, and EventSource routes those to a listener of that name —
    // `onmessage` receives only unnamed events, so a handler set there sees
    // nothing at all while the connection looks perfectly healthy.
    for (const type of runEventTypes) source.addEventListener(type, receive);

    // The run finished without a run.end in its log — a failure before the
    // agent started, or a run the reaper gave up on. The server has to say so,
    // because a bare close is indistinguishable from a dropped connection and
    // EventSource would reconnect against a run that will never speak again.
    const streamClosed = () => {
      setConnection("ended");
      source.close();
    };
    source.addEventListener(STREAM_CLOSED_EVENT, streamClosed);

    source.onerror = () => {
      // EventSource reconnects on its own; this only reports it. The server
      // also closes the stream deliberately after run.end and at its duration
      // cap, and both arrive here as an error on a closed source.
      setConnection((state) =>
        state === "ended" || source.readyState === EventSource.CLOSED
          ? state
          : "reconnecting",
      );
    };

    return () => {
      for (const type of runEventTypes) source.removeEventListener(type, receive);
      source.removeEventListener(STREAM_CLOSED_EVENT, streamClosed);
      source.close();
    };
  }, [runId]);

  const timeline = useMemo(() => buildTimeline(events), [events]);

  // Follow the tail. Reading scroll position in a layout effect would fight the
  // browser; this runs after paint, which is when the new row exists.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [timeline.frames.length]);

  const startedMs = events[0]?.ts.getTime();

  const reload = useCallback(() => router.refresh(), [router]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={connection === "ended" ? "secondary" : "outline"}>
          <span
            className={cn(
              "mr-1.5 inline-block size-1.5 rounded-full",
              connection === "open" && "bg-emerald-500 animate-pulse",
              connection === "connecting" && "bg-muted-foreground",
              connection === "reconnecting" && "bg-amber-500 animate-pulse",
              connection === "ended" && "bg-muted-foreground",
            )}
            aria-hidden
          />
          {LABEL_FOR[connection](labels)}
        </Badge>

        <LiveElapsed
          startedMs={startedMs}
          frozenMs={connection === "ended" ? timeline.durationMs : null}
          floorMs={timeline.durationMs}
        />

        {timeline.totals.outputTokens > 0 || totalInputTokens(timeline.totals) > 0 ? (
          <span className="text-muted-foreground font-mono tabular-nums">
            {format.number(
              totalInputTokens(timeline.totals) + timeline.totals.outputTokens,
            )}{" "}
            {labels.tokens}
          </span>
        ) : null}

        {connection === "ended" ? (
          <Button size="sm" variant="secondary" onClick={reload} className="ml-auto h-7">
            <RefreshCw className="size-3" />
            {labels.replayFromStart}
          </Button>
        ) : null}
      </div>

      <ol
        ref={listRef}
        className="divide-border/50 min-h-0 flex-1 divide-y overflow-y-auto pr-1"
      >
        {timeline.frames.map((frame) => (
          <EventRow key={frame.seq} frame={frame} />
        ))}
      </ol>

      {timeline.frames.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {labels.waiting}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The ticking clock, in its own component so its state does not belong to
 * LiveRun.
 *
 * A second-by-second setState on the parent re-renders every event row, and
 * each row calls useTranslations — which on a run of a few hundred events is
 * enough to peg the tab. Isolating the tick keeps the cost proportional to what
 * actually changed.
 */
function LiveElapsed({
  startedMs,
  frozenMs,
  floorMs,
}: {
  startedMs: number | undefined;
  /** Set once the run has ended: the final duration, which no longer moves. */
  frozenMs: number | null;
  /** The last event's offset, so the clock never reads behind the stream. */
  floorMs: number;
}) {
  // Null until the first tick after mount. Date.now() in the initial render is
  // a hydration mismatch by construction: the server and the client read
  // different clocks, React discards the server HTML, and the error it logs
  // buries whatever else is wrong on the page.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (frozenMs !== null) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [frozenMs]);

  // Before the first tick, the last event's offset — derived from the log, so
  // the server and the client agree on it.
  const elapsed =
    frozenMs ??
    (now !== null && startedMs !== undefined ? Math.max(now - startedMs, floorMs) : floorMs);

  return (
    <span className="text-muted-foreground font-mono tabular-nums">
      {formatElapsed(elapsed)}
    </span>
  );
}

const LABEL_FOR: Record<Connection, (l: LiveLabels) => string> = {
  connecting: (l) => l.connecting,
  open: (l) => l.live,
  reconnecting: (l) => l.reconnecting,
  ended: (l) => l.ended,
};

/**
 * Turn one SSE `data:` line back into a stored event.
 *
 * Anything unparseable is dropped rather than thrown: a live view that blanks
 * because one frame was malformed is worse than one missing a row.
 */
function parseEvent(data: string): StoredEvent | null {
  try {
    const raw = JSON.parse(data) as {
      seq: number;
      ts: string;
      type: string;
      payload: unknown;
    };
    if (typeof raw.seq !== "number" || typeof raw.type !== "string") return null;
    return {
      seq: raw.seq,
      ts: new Date(raw.ts),
      type: raw.type,
      payload: raw.payload,
    } as StoredEvent;
  } catch {
    return null;
  }
}
