import type { StoredEvent } from "./fold";

/**
 * Server-sent-event framing for the run event log.
 *
 * Kept apart from the route so the wire format can be asserted without a
 * server: the `id:` field is the reconnect contract, and a browser that
 * reconnects sends the last one it saw back as `Last-Event-ID`. Getting that
 * wrong loses events silently, which is the worst way for a live view to fail.
 */

/** How long between "nothing happened" comments, to keep proxies from closing. */
export const SSE_KEEPALIVE_MS = 20_000;

/** How often the log is checked for new events while a run is live. */
export const SSE_POLL_MS = 1_000;

/**
 * Stop streaming after this long even if the run has not ended. A connection
 * held open for a day is a leak, and the client reconnects with its cursor.
 */
export const SSE_MAX_DURATION_MS = 30 * 60_000;

export function sseFrame(event: StoredEvent): string {
  // seq, not a timestamp: it is the log's own gap-free cursor, and readEvents
  // takes exactly this value back as `afterSeq`.
  return [
    `id: ${event.seq}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify({
      seq: event.seq,
      ts: event.ts.toISOString(),
      type: event.type,
      payload: event.payload,
    })}`,
    "",
    "",
  ].join("\n");
}

/** A comment frame. Clients ignore it; intermediaries see traffic. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * How often a quiet stream re-checks whether the run has finished.
 *
 * Slower than `SSE_POLL_MS` on purpose: it is a second query per cycle, and the
 * poll rate is already the cost of this endpoint. Only a stream with nothing
 * new to send asks — while events are arriving the run is evidently alive.
 */
export const SSE_STATUS_POLL_MS = 5_000;

/**
 * Ends a stream for a run that finished without a `run.end` event in its log.
 *
 * A run reaches a terminal status with no terminal event more often than it
 * sounds: `settleRun` writes one for any failure before the agent started
 * (clone refused, private repo, missing template), and the reaper writes one
 * for a run it gave up on. Neither appends `run.end`, deliberately — inventing
 * a terminal event on a dead appender's behalf risks a second one in an
 * append-only log.
 *
 * So the reader has to notice instead, and it has to say so out loud. A bare
 * close is indistinguishable from a dropped connection, and EventSource would
 * reconnect against a run that will never speak again.
 *
 * This frame carries no `id:`. The client's reconnect cursor must stay on the
 * last real event; this one is not in the log and has no seq. Its name is
 * deliberately outside `runEventTypes` so it can never be read as a run event.
 */
export const STREAM_CLOSED_EVENT = "stream.closed";

export function sseStreamClosed(status: string): string {
  return [
    `event: ${STREAM_CLOSED_EVENT}`,
    `data: ${JSON.stringify({ status })}`,
    "",
    "",
  ].join("\n");
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` is what the browser's own EventSource sends on reconnect and
 * therefore wins; `?after=` is for a first connection that already rendered
 * events server-side, so the client does not receive them twice.
 */
export function parseCursor(lastEventId: string | null, after: string | null): number {
  for (const candidate of [lastEventId, after]) {
    if (candidate === null) continue;
    // The whole string must be an unsigned integer. parseInt takes prefixes, so
    // "12junk" resolves to 12 and "1.5" to 1 — a cursor that is nearly right is
    // worse than none, because it resumes from the wrong place and drops events
    // with no sign that it happened. Safe-integer bounded too: past 2^53 the
    // parsed value is not the number that was sent.
    if (!/^\d+$/.test(candidate)) continue;
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 0;
}
