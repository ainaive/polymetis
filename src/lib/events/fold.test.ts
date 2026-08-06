import { describe, expect, test } from "bun:test";

import {
  advancePlayhead,
  assertContiguous,
  assignSeq,
  buildTimeline,
  eventsOfType,
  foldUsage,
  frameIndexAt,
  MAX_FRAME_DELTA_MS,
  totalInputTokens,
  type StoredEvent,
} from "./fold";
import { safeParseRunEvent } from "./schema";

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));

function usage(costUsd: number, seq: number, ms: number): StoredEvent {
  return {
    seq,
    ts: at(ms),
    type: "usage",
    payload: { model: "claude-opus-5", inputTokens: 10, outputTokens: 5, costUsd },
  };
}

describe("assignSeq", () => {
  test("numbers a batch contiguously after the last seq", () => {
    const numbered = assignSeq(0, [
      { type: "agent.message", payload: { text: "a" } },
      { type: "agent.message", payload: { text: "b" } },
    ]);
    expect(numbered.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("continues from a non-zero last seq without leaving a gap", () => {
    const numbered = assignSeq(7, [
      { type: "agent.message", payload: { text: "a" } },
      { type: "agent.message", payload: { text: "b" } },
    ]);
    expect(numbered.map((e) => e.seq)).toEqual([8, 9]);
  });

  test("returns nothing for an empty batch rather than burning a seq", () => {
    expect(assignSeq(3, [])).toEqual([]);
  });

  test("rejects a negative or fractional last seq", () => {
    expect(() => assignSeq(-1, [])).toThrow(RangeError);
    expect(() => assignSeq(1.5, [])).toThrow(RangeError);
  });
});

describe("assertContiguous", () => {
  test("accepts a stream starting at 1 with no gaps", () => {
    expect(() => assertContiguous([{ seq: 1 }, { seq: 2 }, { seq: 3 }])).not.toThrow();
  });

  test("rejects a gap, because rendering a stream with a hole hides data loss", () => {
    expect(() => assertContiguous([{ seq: 1 }, { seq: 3 }])).toThrow(/not contiguous/);
  });

  test("rejects a stream that does not start at 1", () => {
    expect(() => assertContiguous([{ seq: 2 }, { seq: 3 }])).toThrow(/not contiguous/);
  });

  test("rejects duplicates", () => {
    expect(() => assertContiguous([{ seq: 1 }, { seq: 1 }])).toThrow(/not contiguous/);
  });
});

describe("foldUsage", () => {
  test("sums tokens and cost across usage events, ignoring other types", () => {
    const totals = foldUsage([
      { type: "agent.message", payload: { text: "ignored" } },
      usage(0.25, 1, 0),
      usage(0.75, 2, 10),
    ]);
    expect(totals).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 1,
    });
  });

  test("does not accumulate float drift across many small deltas", () => {
    // 0.1 + 0.2 is famously not 0.3 in binary floating point; ten of them
    // must still land on exactly 1 rather than 0.9999999999999999.
    const events = Array.from({ length: 10 }, (_, i) => usage(0.1, i + 1, i));
    expect(foldUsage(events).costUsd).toBe(1);
  });

  test("a run with no usage events folds to zero, not NaN", () => {
    expect(foldUsage([]).costUsd).toBe(0);
  });

  test("sums cache traffic, which dominates an agentic run", () => {
    const totals = foldUsage([
      {
        type: "usage",
        payload: {
          model: "claude-opus-5",
          inputTokens: 28,
          outputTokens: 24_182,
          cacheReadTokens: 380_000,
          cacheCreationTokens: 70_000,
          costUsd: 2.8862,
        },
      },
    ]);
    // The shape that motivated these fields: reporting inputTokens alone would
    // claim this run read 28 tokens when it actually read 450,028.
    expect(totals.inputTokens).toBe(28);
    expect(totalInputTokens(totals)).toBe(450_028);
  });

  test("events recorded before the cache fields existed still fold", () => {
    // ADR-0001 allows adding optional fields but not repurposing existing
    // ones, so older events legitimately lack these and must not produce NaN.
    const totals = foldUsage([
      {
        type: "usage",
        payload: {
          model: "claude-opus-5",
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.5,
        },
      },
    ]);
    expect(totals.cacheReadTokens).toBe(0);
    expect(totals.cacheCreationTokens).toBe(0);
    expect(totalInputTokens(totals)).toBe(100);
  });
});

describe("buildTimeline", () => {
  const events: StoredEvent[] = [
    {
      seq: 1,
      ts: at(0),
      type: "run.start",
      payload: { templateSlug: "issue-to-spec", templateVersion: 1, inputs: {} },
    },
    { seq: 2, ts: at(100), type: "step.start", payload: { index: 0, label: "Read the issue" } },
    {
      seq: 3,
      ts: at(150),
      type: "tool.call",
      payload: { toolCallId: "t1", tool: "Read", summary: "README.md" },
    },
    usage(0.4, 4, 200),
    { seq: 5, ts: at(300), type: "step.start", payload: { index: 1, label: "Map the module" } },
    usage(0.6, 6, 400),
    { seq: 7, ts: at(500), type: "run.end", payload: { status: "succeeded", durationMs: 500 } },
  ];

  test("offsets are relative to the first event, not wall-clock time", () => {
    const timeline = buildTimeline(events);
    expect(timeline.frames[0].offsetMs).toBe(0);
    expect(timeline.frames.at(-1)!.offsetMs).toBe(500);
    expect(timeline.durationMs).toBe(500);
  });

  test("cost accumulates along the playhead so the readout can track it", () => {
    const timeline = buildTimeline(events);
    // Before any usage event.
    expect(timeline.frames[2].costUsdSoFar).toBe(0);
    // After the first.
    expect(timeline.frames[3].costUsdSoFar).toBe(0.4);
    // After the second.
    expect(timeline.frames[5].costUsdSoFar).toBe(1);
    expect(timeline.totals.costUsd).toBe(1);
  });

  test("collects steps as timeline chapter markers", () => {
    const timeline = buildTimeline(events);
    expect(timeline.steps.map((s) => s.label)).toEqual([
      "Read the issue",
      "Map the module",
    ]);
    expect(timeline.steps[1].offsetMs).toBe(300);
  });

  test("counts tool calls and reads the terminal status", () => {
    const timeline = buildTimeline(events);
    expect(timeline.toolCallCount).toBe(1);
    expect(timeline.status).toBe("succeeded");
  });

  test("a stream with no run.end is still in progress", () => {
    const timeline = buildTimeline(events.slice(0, -1));
    expect(timeline.status).toBe("running");
  });

  test("an empty stream produces an empty timeline rather than throwing", () => {
    const timeline = buildTimeline([]);
    expect(timeline.frames).toEqual([]);
    expect(timeline.durationMs).toBe(0);
    expect(timeline.status).toBe("running");
  });
});

describe("frameIndexAt", () => {
  const timeline = buildTimeline([
    { seq: 1, ts: at(0), type: "agent.message", payload: { text: "a" } },
    { seq: 2, ts: at(100), type: "agent.message", payload: { text: "b" } },
    { seq: 3, ts: at(200), type: "agent.message", payload: { text: "c" } },
  ]);

  test("lands on the last frame at or before the playhead", () => {
    expect(frameIndexAt(timeline.frames, 0)).toBe(0);
    expect(frameIndexAt(timeline.frames, 99)).toBe(0);
    expect(frameIndexAt(timeline.frames, 100)).toBe(1);
    expect(frameIndexAt(timeline.frames, 250)).toBe(2);
  });

  test("returns -1 before the first frame, so nothing renders at t<0", () => {
    expect(frameIndexAt(timeline.frames, -1)).toBe(-1);
  });

  test("returns -1 for an empty timeline", () => {
    expect(frameIndexAt([], 100)).toBe(-1);
  });
});

describe("advancePlayhead", () => {
  test("advances by the frame delta scaled by speed", () => {
    expect(advancePlayhead(0, 16, 1, 10_000).elapsedMs).toBe(16);
    expect(advancePlayhead(0, 16, 4, 10_000).elapsedMs).toBe(64);
  });

  test("clamps a huge delta from a tab returning from the background", () => {
    // Browsers serve no animation frames to a hidden tab, so the first frame
    // after returning carries the whole hidden period. Without the clamp a
    // 30-second absence would jump the playhead 30 seconds into the run.
    const { elapsedMs, ended } = advancePlayhead(0, 30_000, 1, 60_000);
    expect(elapsedMs).toBe(MAX_FRAME_DELTA_MS);
    expect(ended).toBe(false);
  });

  test("the clamp still applies at high speed", () => {
    expect(advancePlayhead(0, 30_000, 8, 600_000).elapsedMs).toBe(
      MAX_FRAME_DELTA_MS * 8,
    );
  });

  test("stops exactly at the end rather than overshooting", () => {
    const { elapsedMs, ended } = advancePlayhead(9_900, 200, 8, 10_000);
    expect(elapsedMs).toBe(10_000);
    expect(ended).toBe(true);
  });

  test("treats a negative delta as zero rather than rewinding", () => {
    expect(advancePlayhead(500, -100, 1, 10_000).elapsedMs).toBe(500);
  });

  test("a zero-duration run ends immediately instead of looping forever", () => {
    expect(advancePlayhead(0, 16, 1, 0)).toEqual({ elapsedMs: 0, ended: true });
  });
});

describe("eventsOfType", () => {
  test("returns only the matching payloads, typed to that event", () => {
    const steps = eventsOfType(
      [
        { type: "step.start", payload: { index: 0, label: "first" } },
        { type: "agent.message", payload: { text: "noise" } },
        { type: "step.start", payload: { index: 1, label: "second" } },
      ],
      "step.start",
    );
    // If the return type were widened to the payload union this would not
    // compile, which is the point of the assertion inside eventsOfType.
    expect(steps.map((s) => s.label)).toEqual(["first", "second"]);
  });

  test("returns an empty array when no event of that type occurred", () => {
    expect(eventsOfType([{ type: "agent.message", payload: { text: "x" } }], "usage")).toEqual(
      [],
    );
  });
});

describe("event validation", () => {
  test("rejects an unknown event type", () => {
    expect(safeParseRunEvent({ type: "nope", payload: {} }).success).toBe(false);
  });

  test("rejects a payload belonging to a different event type", () => {
    const wrong = safeParseRunEvent({
      type: "usage",
      payload: { text: "this is an agent.message payload" },
    });
    expect(wrong.success).toBe(false);
  });

  test("rejects a negative cost", () => {
    const negative = safeParseRunEvent({
      type: "usage",
      payload: {
        model: "claude-opus-5",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: -1,
      },
    });
    expect(negative.success).toBe(false);
  });

  test("accepts a well-formed event", () => {
    expect(
      safeParseRunEvent({
        type: "run.end",
        payload: { status: "succeeded", durationMs: 1000 },
      }).success,
    ).toBe(true);
  });
});
