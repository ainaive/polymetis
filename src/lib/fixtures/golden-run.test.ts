import { describe, expect, test } from "bun:test";

import { buildTimeline, type StoredEvent } from "@/lib/events/fold";
import { safeParseRunEvent } from "@/lib/events/schema";
import { issueToSpecDeliverable } from "@/lib/templates/issue-to-spec";

import {
  GOLDEN_RUN_DURATION_MS,
  GOLDEN_RUN_STEP_COUNT,
  goldenRunArtifact,
  goldenRunBeats,
  validatedGoldenRun,
} from "./golden-run";

const asStored = (): StoredEvent[] =>
  goldenRunBeats.map((beat, i) => {
    const { offsetMs, ...event } = beat;
    return { ...event, seq: i + 1, ts: new Date(offsetMs) } as StoredEvent;
  });

describe("the golden run fixture", () => {
  test("every beat satisfies the same validation the worker applies", () => {
    // A fixture that could not survive appendEvents would let the UI be built
    // against events that can never actually occur.
    for (const beat of goldenRunBeats) {
      const { offsetMs, ...event } = beat;
      const result = safeParseRunEvent(event);
      expect(
        result.success,
        `beat at ${offsetMs}ms (${beat.type}) failed validation`,
      ).toBe(true);
    }
    expect(validatedGoldenRun()).toHaveLength(goldenRunBeats.length);
  });

  test("offsets never go backwards", () => {
    for (let i = 1; i < goldenRunBeats.length; i++) {
      expect(goldenRunBeats[i].offsetMs).toBeGreaterThanOrEqual(
        goldenRunBeats[i - 1].offsetMs,
      );
    }
  });

  test("opens with run.start and closes with run.end", () => {
    expect(goldenRunBeats[0].type).toBe("run.start");
    expect(goldenRunBeats.at(-1)!.type).toBe("run.end");
  });

  test("declares a duration matching its own last offset", () => {
    const end = goldenRunBeats.at(-1)!;
    expect(end.type).toBe("run.end");
    if (end.type !== "run.end") throw new Error("unreachable");
    expect(end.payload.durationMs).toBe(GOLDEN_RUN_DURATION_MS);
  });

  test("every tool.result matches a preceding tool.call", () => {
    const opened = new Set<string>();
    for (const beat of goldenRunBeats) {
      if (beat.type === "tool.call") opened.add(beat.payload.toolCallId);
      if (beat.type === "tool.result") {
        expect(
          opened.has(beat.payload.toolCallId),
          `tool.result ${beat.payload.toolCallId} has no preceding call`,
        ).toBe(true);
      }
    }
  });

  test("builds a timeline the player can render", () => {
    const timeline = buildTimeline(asStored());
    expect(timeline.frames).toHaveLength(goldenRunBeats.length);
    expect(timeline.steps).toHaveLength(GOLDEN_RUN_STEP_COUNT);
    expect(timeline.durationMs).toBe(GOLDEN_RUN_DURATION_MS);
    expect(timeline.status).toBe("succeeded");
    expect(timeline.toolCallCount).toBeGreaterThan(0);
    expect(timeline.totals.costUsd).toBeGreaterThan(0);
  });

  test("cost only ever increases along the playhead", () => {
    const { frames } = buildTimeline(asStored());
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].costUsdSoFar).toBeGreaterThanOrEqual(
        frames[i - 1].costUsdSoFar,
      );
    }
  });

  test("the artifact contains every section the deliverable contract requires", () => {
    // This is the test that keeps the fixture honest: if the template's
    // contract gains a section, the fixture has to grow one too, or the
    // replay player would be developed against a deliverable the real
    // template would never produce.
    for (const section of issueToSpecDeliverable.sections) {
      expect(
        goldenRunArtifact.content.includes(`## ${section}`),
        `artifact is missing the "${section}" section`,
      ).toBe(true);
    }
  });

  test("artifact.write events name the file the deliverable declares", () => {
    for (const beat of goldenRunBeats) {
      if (beat.type !== "artifact.write") continue;
      expect(beat.payload.path).toBe(issueToSpecDeliverable.filename);
    }
  });
});
