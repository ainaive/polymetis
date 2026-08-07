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
 * Where to resume from.
 *
 * `Last-Event-ID` is what the browser's own EventSource sends on reconnect and
 * therefore wins; `?after=` is for a first connection that already rendered
 * events server-side, so the client does not receive them twice.
 */
export function parseCursor(lastEventId: string | null, after: string | null): number {
  for (const candidate of [lastEventId, after]) {
    if (candidate === null) continue;
    const parsed = Number.parseInt(candidate, 10);
    // Anything unparseable means start from the beginning rather than guess:
    // resuming from the wrong place drops events with no sign that it happened.
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}
