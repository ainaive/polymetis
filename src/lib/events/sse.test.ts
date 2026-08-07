import { describe, expect, test } from "bun:test";

import { isTerminalRunStatus } from "./fold";
import { parseCursor, sseComment, sseFrame } from "./sse";

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
