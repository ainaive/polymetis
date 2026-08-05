import type {
  PayloadFor,
  RunEventInput,
  RunEventType,
} from "./schema";

/**
 * Pure derivations over a run's event stream.
 *
 * These are separated from the database layer on purpose: sequence assignment
 * and replay-timeline construction are the parts most likely to be subtly
 * wrong, and keeping them pure means they are unit-testable without Postgres
 * (an AGENTS.md rule) and reusable by both the worker and the replay player.
 */

/** A stored event: the validated input plus its position in the stream. */
export type StoredEvent = RunEventInput & {
  seq: number;
  ts: Date;
};

/**
 * Assign gap-free sequence numbers starting after `lastSeq`.
 *
 * Callers hold the run's queue lock, so they own the counter; the UNIQUE
 * (runId, seq) constraint is the backstop if that assumption is ever broken.
 */
export function assignSeq<T extends RunEventInput>(
  lastSeq: number,
  events: readonly T[],
): (T & { seq: number })[] {
  if (!Number.isInteger(lastSeq) || lastSeq < 0) {
    throw new RangeError(`lastSeq must be a non-negative integer, got ${lastSeq}`);
  }
  return events.map((event, i) => ({ ...event, seq: lastSeq + 1 + i }));
}

/**
 * Assert a stream is ordered, gap-free, and starts at 1. Used by the verify
 * scripts and by the replay loader — a gap means events were lost, and
 * silently rendering a stream with a hole in it is worse than refusing to.
 */
export function assertContiguous(events: readonly { seq: number }[]): void {
  for (let i = 0; i < events.length; i++) {
    const expected = i + 1;
    if (events[i].seq !== expected) {
      throw new Error(
        `run event stream is not contiguous: expected seq ${expected} at index ${i}, got ${events[i].seq}`,
      );
    }
  }
}

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** Sum every usage event. A partial run still folds to a real number. */
export function foldUsage(events: readonly RunEventInput[]): UsageTotals {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const event of events) {
    if (event.type !== "usage") continue;
    totals.inputTokens += event.payload.inputTokens;
    totals.outputTokens += event.payload.outputTokens;
    totals.costUsd += event.payload.costUsd;
  }
  // Costs arrive as small per-call deltas; re-round so the total does not
  // carry accumulated binary-float noise into the UI or the runs table.
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return totals;
}

export function eventsOfType<T extends RunEventType>(
  events: readonly RunEventInput[],
  type: T,
): PayloadFor<T>[] {
  const out: PayloadFor<T>[] = [];
  for (const event of events) {
    // The discriminated union guarantees payload matches type, but TypeScript
    // cannot follow that correlation through the generic T, so the narrowing
    // is asserted here rather than weakening the return type for callers.
    if (event.type === type) out.push(event.payload as PayloadFor<T>);
  }
  return out;
}

export type ReplayFrame = StoredEvent & {
  /** Milliseconds since the first event — drives the scrub bar. */
  offsetMs: number;
  /** Running cost at this point, so the readout can track the playhead. */
  costUsdSoFar: number;
};

export type ReplayStep = {
  index: number;
  label: string;
  seq: number;
  offsetMs: number;
};

export type ReplayTimeline = {
  frames: ReplayFrame[];
  steps: ReplayStep[];
  durationMs: number;
  totals: UsageTotals;
  toolCallCount: number;
  /** Final artifact content, if the run wrote one inline. */
  status: PayloadFor<"run.end">["status"] | "running";
};

/**
 * Build everything the replay player needs in one pass.
 *
 * Offsets are relative to the first event rather than absolute timestamps, so
 * a replay recorded at 3am renders identically to one recorded now, and the
 * scrub bar needs no timezone handling.
 */
export function buildTimeline(events: readonly StoredEvent[]): ReplayTimeline {
  if (events.length === 0) {
    return {
      frames: [],
      steps: [],
      durationMs: 0,
      totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      toolCallCount: 0,
      status: "running",
    };
  }

  const startMs = events[0].ts.getTime();
  const frames: ReplayFrame[] = [];
  const steps: ReplayStep[] = [];
  let costUsdSoFar = 0;
  let toolCallCount = 0;
  let status: ReplayTimeline["status"] = "running";

  for (const event of events) {
    if (event.type === "usage") {
      costUsdSoFar = Math.round((costUsdSoFar + event.payload.costUsd) * 1e6) / 1e6;
    }
    if (event.type === "tool.call") toolCallCount++;
    if (event.type === "run.end") status = event.payload.status;

    const offsetMs = event.ts.getTime() - startMs;
    frames.push({ ...event, offsetMs, costUsdSoFar });

    if (event.type === "step.start") {
      steps.push({
        index: event.payload.index,
        label: event.payload.label,
        seq: event.seq,
        offsetMs,
      });
    }
  }

  return {
    frames,
    steps,
    durationMs: frames[frames.length - 1].offsetMs,
    totals: foldUsage(events),
    toolCallCount,
    status,
  };
}

/** The frame index the playhead is on at `elapsedMs`. */
export function frameIndexAt(
  frames: readonly ReplayFrame[],
  elapsedMs: number,
): number {
  if (frames.length === 0) return -1;
  // Binary search for the last frame at or before elapsedMs.
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].offsetMs <= elapsedMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
