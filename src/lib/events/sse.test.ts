import { describe, expect, test } from "bun:test";

import { isTerminalRunStatus } from "./fold";
import { runEventTypes } from "./schema";
import {
  parseCursor,
  sseComment,
  sseFrame,
  sseStreamClosed,
  STREAM_CLOSED_EVENT,
} from "./sse";

const event = {
  seq: 12,
  ts: new Date("2026-08-07T10:00:00.000Z"),
  type: "agent.message" as const,
  payload: { text: "hello" },
};

describe("sseFrame", () => {
  const frame = sseFrame(event);

  test("carries the seq as the event id, which is the reconnect contract", () => {
    // A browser sends this back as Last-Event-ID, and readEvents takes exactly
    // this value as afterSeq. Anything else here loses events silently.
    expect(frame).toContain("id: 12");
  });

  test("names the event type so a client can listen selectively", () => {
    expect(frame).toContain("event: agent.message");
  });

  test("ends with the blank line that terminates a frame", () => {
    // Without the double newline the browser buffers the frame indefinitely.
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  test("carries the whole event as one JSON line", () => {
    const line = frame.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(line.slice(6))).toEqual({
      seq: 12,
      ts: "2026-08-07T10:00:00.000Z",
      type: "agent.message",
      payload: { text: "hello" },
    });
  });

  test("does not break framing on a payload containing newlines", () => {
    // A multi-line agent message is normal, and a raw newline in `data:` would
    // be read as a second field.
    const multi = sseFrame({ ...event, payload: { text: "one\ntwo\n\nthree" } });
    const dataLines = multi.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    expect(multi.split("\n\n")).toHaveLength(2);
  });
});

describe("sseComment", () => {
  test("is a comment frame a client ignores", () => {
    expect(sseComment("keepalive")).toBe(": keepalive\n\n");
  });
});

describe("sseStreamClosed", () => {
  test("names an event outside the run vocabulary", () => {
    // If this collided with a run event type the client's per-type listeners
    // would try to parse it as a log entry, and it has no seq to parse.
    expect(runEventTypes).not.toContain(STREAM_CLOSED_EVENT as never);
    expect(sseStreamClosed("failed")).toContain(`event: ${STREAM_CLOSED_EVENT}`);
  });

  test("carries the terminal status", () => {
    const line = sseStreamClosed("cancelled")
      .split("\n")
      .find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(line.slice(6))).toEqual({ status: "cancelled" });
  });

  test("sets no id, so the reconnect cursor stays on the last real event", () => {
    // An `id:` here would become the client's Last-Event-ID. This frame is not
    // in the log and has no seq, so it must not move the cursor.
    expect(sseStreamClosed("failed")).not.toContain("id:");
  });

  test("is one complete frame", () => {
    expect(sseStreamClosed("failed").endsWith("\n\n")).toBe(true);
    expect(sseStreamClosed("failed").split("\n\n")).toHaveLength(2);
  });
});

describe("parseCursor", () => {
  test("prefers Last-Event-ID, which is what a reconnecting browser sends", () => {
    expect(parseCursor("12", "3")).toBe(12);
  });

  test("falls back to ?after for a first connection", () => {
    expect(parseCursor(null, "3")).toBe(3);
  });

  test("starts from the beginning when there is no cursor", () => {
    expect(parseCursor(null, null)).toBe(0);
  });

  test("starts from the beginning rather than guessing at nonsense", () => {
    // Resuming from the wrong place drops events with no sign it happened.
    expect(parseCursor("abc", null)).toBe(0);
    expect(parseCursor("-4", null)).toBe(0);
    expect(parseCursor("", null)).toBe(0);
  });
});

describe("isTerminalRunStatus", () => {
  test("every run.end status is terminal", () => {
    for (const status of ["succeeded", "failed", "cancelled", "timed_out"]) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  test("a run still in the queue or running is not", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });
});

describe("parseCursor rejects values that are only nearly numbers", () => {
  test("a numeric prefix is not a cursor", () => {
    // parseInt("12junk") is 12. Resuming from a cursor that is nearly right
    // silently skips events; starting over only repeats them.
    expect(parseCursor("12junk", null)).toBe(0);
  });

  test("a decimal is not a cursor", () => {
    expect(parseCursor("1.5", null)).toBe(0);
  });

  test("a value past the safe integer range is not a cursor", () => {
    // Number("9007199254740993") is 9007199254740992 — not what was sent.
    expect(parseCursor("9007199254740993", null)).toBe(0);
  });

  test("whitespace and signs are not cursors", () => {
    expect(parseCursor(" 12", null)).toBe(0);
    expect(parseCursor("+12", null)).toBe(0);
  });

  test("a plain unsigned integer still is", () => {
    expect(parseCursor("12", null)).toBe(12);
    expect(parseCursor("0", null)).toBe(0);
  });

  test("a bad Last-Event-ID falls through to ?after rather than to zero", () => {
    // Losing a usable cursor because the other one was junk would replay the
    // whole run into a client that already rendered it.
    expect(parseCursor("junk", "7")).toBe(7);
  });
});
