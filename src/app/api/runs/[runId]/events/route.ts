import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { currentViewer } from "@/auth/viewer";
import { db } from "@/db";
import { runs } from "@/db/schema";
import {
  parseCursor,
  SSE_KEEPALIVE_MS,
  SSE_MAX_DURATION_MS,
  SSE_POLL_MS,
  sseComment,
  sseFrame,
} from "@/lib/events/sse";
import { readEvents } from "@/lib/events/store";
import { canViewRun } from "@/lib/runs/access";

/**
 * Streams a run's events as they are appended.
 *
 * The append-only log is the only source of truth (ADR-0001), so this polls it
 * rather than subscribing to the worker. That means no cross-process channel to
 * keep correct, no dedicated Postgres connection per viewer, and a reconnect
 * that is just a cursor — the same read path the finished replay uses. A real
 * run averaged about half an event per second, so the poll is not the cost.
 * LISTEN/NOTIFY is the upgrade if viewer counts ever make it one.
 */

// Never prerendered or cached: it is an open connection to live data.
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/runs/[runId]/events">,
) {
  const { runId } = await ctx.params;

  const [run] = await db
    .select({
      status: runs.status,
      visibility: runs.visibility,
      workspaceId: runs.workspaceId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  // The same predicate the replay page uses. If these two disagreed, the one
  // that allows more would be a way around the one that allows less — and a
  // live stream of a private run is the more revealing of the two.
  if (!run || !canViewRun(run, await currentViewer())) {
    // 404 rather than 403, and no body: whether a run exists is information,
    // and EventSource reports the status on its own.
    return new Response(null, { status: 404 });
  }

  const cursor = parseCursor(
    request.headers.get("last-event-id"),
    request.nextUrl.searchParams.get("after"),
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const startedAt = Date.now();
      let seq = cursor;
      let lastWrite = Date.now();
      let closed = false;

      const send = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
        lastWrite = Date.now();
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      // A client that navigates away aborts the request; without this the poll
      // would keep querying for a reader that no longer exists.
      request.signal.addEventListener("abort", finish);

      // Flush something immediately. A stream whose first byte waits for the
      // first event leaves the client showing "connecting" for as long as the
      // agent is quiet — and EventSource does not fire `open` until headers and
      // some body have actually arrived through every buffer in between.
      send(sseComment("open"));

      try {
        while (!closed && !request.signal.aborted) {
          const events = await readEvents(db, runId, { afterSeq: seq });

          for (const event of events) {
            send(sseFrame(event));
            seq = event.seq;
            if (event.type === "run.end") {
              // The log is terminal. Close rather than poll forever for events
              // that by definition cannot arrive.
              finish();
              return;
            }
          }

          if (Date.now() - lastWrite > SSE_KEEPALIVE_MS) {
            send(sseComment("keepalive"));
          }

          if (Date.now() - startedAt > SSE_MAX_DURATION_MS) {
            // The client reconnects with its cursor and loses nothing. A
            // connection held open indefinitely is a leak on every hop.
            finish();
            return;
          }

          await sleep(SSE_POLL_MS, request.signal);
        }
      } catch (error) {
        // Opaque on the wire, detailed in the log. A database error message
        // reaches every reader of this endpoint, and replay URLs are meant to
        // be shared.
        console.error(`[sse] ${runId} stream failed:`, error);
        if (!closed) {
          send(sseComment("stream-error"));
          finish();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // A cached event stream is a stream that never updates.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx buffers proxied responses by default, which holds every frame
      // until the run ends — the exact opposite of the point.
      "x-accel-buffering": "no",
    },
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      resolve();
    }
  });
}

