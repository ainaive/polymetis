import type { RunEventInput } from "@/lib/events/schema";
import { parseRunEvent } from "@/lib/events/schema";

/**
 * The golden run: a hand-authored event stream used to develop and test the
 * replay player and gallery without spending a single token.
 *
 * This is a FIXTURE, not a recording. The repository is real and the shape of
 * the run is faithful to what the issue-to-spec template does, but no agent
 * produced it. M4 replaces it with genuine recorded runs against real public
 * issues; until then it is what the UI is built and tested against, and it
 * doubles as executable documentation of the event vocabulary.
 *
 * Keeping it in src/lib means the tests, the seed script, and the replay
 * player all agree on one definition of what a well-formed run looks like.
 */

export type GoldenBeat = RunEventInput & {
  /** Milliseconds after the run started. */
  offsetMs: number;
};

export const GOLDEN_RUN_REPO = { owner: "honojs", name: "hono" };
export const GOLDEN_RUN_ISSUE = {
  ...GOLDEN_RUN_REPO,
  number: 3421,
  title: "RPC client should support streaming responses",
};

export const goldenRunBeats: GoldenBeat[] = [
  {
    offsetMs: 0,
    type: "run.start",
    payload: {
      templateSlug: "issue-to-spec",
      templateVersion: 1,
      inputs: {
        repo: "honojs/hono",
        issue: "https://github.com/honojs/hono/issues/3421",
        audience: "engineer",
      },
      repo: GOLDEN_RUN_REPO,
      issue: GOLDEN_RUN_ISSUE,
    },
  },

  // ---- step 0: understand the ask ----------------------------------------
  { offsetMs: 900, type: "step.start", payload: { index: 0, label: "Read the issue" } },
  {
    offsetMs: 1_400,
    type: "agent.message",
    payload: {
      text: "The issue asks for streaming responses in the RPC client. Before I can scope that I need to know how the client currently reads a response body, and whether the type inference layer assumes a fully-buffered JSON payload.",
    },
  },
  {
    offsetMs: 2_100,
    type: "tool.call",
    payload: { toolCallId: "c1", tool: "Glob", summary: "src/client/**/*.ts" },
  },
  {
    offsetMs: 2_800,
    type: "tool.result",
    payload: { toolCallId: "c1", ok: true, summary: "6 files", detail: "src/client/client.ts\nsrc/client/types.ts\nsrc/client/utils.ts" },
  },
  {
    offsetMs: 3_600,
    type: "usage",
    payload: { model: "claude-opus-5", inputTokens: 18_420, outputTokens: 412, costUsd: 0.1023 },
  },

  // ---- step 1: map the modules -------------------------------------------
  { offsetMs: 4_200, type: "step.start", payload: { index: 1, label: "Map the affected modules" } },
  {
    offsetMs: 5_000,
    type: "tool.call",
    payload: { toolCallId: "c2", tool: "Read", summary: "src/client/client.ts" },
  },
  {
    offsetMs: 6_100,
    type: "tool.result",
    payload: { toolCallId: "c2", ok: true, summary: "241 lines" },
  },
  {
    offsetMs: 7_000,
    type: "agent.message",
    payload: {
      text: "`hc()` builds a proxy whose leaf call runs `fetch` and then unconditionally awaits `res.json()`. That await is the whole problem: the body is consumed before the caller ever sees the Response.",
    },
  },
  {
    offsetMs: 8_200,
    type: "tool.call",
    payload: { toolCallId: "c3", tool: "Grep", summary: "res.json() across src/" },
  },
  {
    offsetMs: 9_000,
    type: "tool.result",
    payload: { toolCallId: "c3", ok: true, summary: "3 matches in 2 files", detail: "src/client/client.ts:118\nsrc/client/client.ts:164\nsrc/validator/validator.ts:52" },
  },
  {
    offsetMs: 10_400,
    type: "tool.call",
    payload: { toolCallId: "c4", tool: "Read", summary: "src/client/types.ts" },
  },
  {
    offsetMs: 11_600,
    type: "tool.result",
    payload: { toolCallId: "c4", ok: true, summary: "188 lines" },
  },
  {
    offsetMs: 12_900,
    type: "agent.message",
    payload: {
      text: "`ClientResponse<T>` is where the inference lives. It narrows on the handler's return type, so a streaming handler needs a distinct branch rather than a widened `T` — widening would degrade inference for every existing non-streaming call.",
    },
  },
  {
    offsetMs: 14_000,
    type: "usage",
    payload: { model: "claude-opus-5", inputTokens: 31_140, outputTokens: 903, costUsd: 0.1783 },
  },

  // ---- step 2: trace the current path ------------------------------------
  { offsetMs: 15_200, type: "step.start", payload: { index: 2, label: "Trace the response path" } },
  {
    offsetMs: 16_100,
    type: "tool.call",
    payload: { toolCallId: "c5", tool: "Grep", summary: "streamText|streamSSE in src/helper" },
  },
  {
    offsetMs: 17_000,
    type: "tool.result",
    payload: { toolCallId: "c5", ok: true, summary: "11 matches in 3 files", detail: "src/helper/streaming/stream.ts\nsrc/helper/streaming/sse.ts\nsrc/helper/streaming/index.ts" },
  },
  {
    offsetMs: 18_400,
    type: "tool.call",
    payload: { toolCallId: "c6", tool: "Read", summary: "src/helper/streaming/sse.ts" },
  },
  {
    offsetMs: 19_500,
    type: "tool.result",
    payload: { toolCallId: "c6", ok: true, summary: "96 lines" },
  },
  {
    offsetMs: 20_800,
    type: "agent.message",
    payload: {
      text: "The server side already streams properly — `streamSSE` sets the right headers and returns a `Response` with a `ReadableStream`. So this is a client-only change, which makes it considerably smaller than the issue implies.",
    },
  },
  {
    offsetMs: 22_000,
    type: "tool.call",
    payload: { toolCallId: "c7", tool: "Grep", summary: "ClientResponse in src/client" },
  },
  {
    offsetMs: 22_900,
    type: "tool.result",
    payload: { toolCallId: "c7", ok: true, summary: "8 matches in 2 files" },
  },
  {
    offsetMs: 24_100,
    type: "tool.call",
    payload: { toolCallId: "c8", tool: "Read", summary: "src/client/utils.ts" },
  },
  {
    offsetMs: 25_000,
    type: "tool.result",
    payload: { toolCallId: "c8", ok: true, summary: "74 lines" },
  },
  {
    offsetMs: 26_500,
    type: "usage",
    payload: { model: "claude-opus-5", inputTokens: 44_800, outputTokens: 1_140, costUsd: 0.2525 },
  },
  {
    offsetMs: 28_000,
    type: "agent.message",
    payload: {
      text: "One thing I could not settle from the code: there is no test covering a non-2xx streaming response, and the error path in `client.ts:164` also calls `res.json()`. I will flag that as an open question rather than assume the intended behaviour.",
    },
  },

  // ---- step 3: write the spec --------------------------------------------
  { offsetMs: 30_000, type: "step.start", payload: { index: 3, label: "Write the spec" } },
  {
    offsetMs: 31_500,
    type: "artifact.write",
    payload: {
      path: "implementation-spec.md",
      bytes: 620,
      section: "Problem",
      preview:
        "## Problem\n\nThe RPC client returns `ClientResponse<T>` whose leaf call awaits `res.json()` unconditionally (`src/client/client.ts:118`). A handler built with `streamSSE` therefore has its body consumed and buffered before the caller can read it, so streaming endpoints are unusable through `hc()` even though the server emits them correctly.",
    },
  },
  {
    offsetMs: 34_200,
    type: "artifact.write",
    payload: {
      path: "implementation-spec.md",
      bytes: 1_480,
      section: "Affected modules",
      preview:
        "## Affected modules\n\n- `src/client/client.ts` — the proxy leaf that performs the fetch and the two `res.json()` calls (lines 118 and 164, the second on the error path).\n- `src/client/types.ts` — `ClientResponse<T>`; needs a streaming branch rather than a widened `T`, so inference for existing calls is unchanged.\n- `src/client/utils.ts` — response helpers shared by both paths.\n- `src/helper/streaming/sse.ts` — read but NOT changed; confirms the server already emits a correct streaming `Response`.",
    },
  },
  {
    offsetMs: 38_000,
    type: "usage",
    payload: { model: "claude-opus-5", inputTokens: 52_300, outputTokens: 2_260, costUsd: 0.3181 },
  },
  {
    offsetMs: 39_500,
    type: "artifact.write",
    payload: {
      path: "implementation-spec.md",
      bytes: 2_390,
      section: "Approach",
      preview:
        "## Approach\n\nBranch on the response content type at the leaf instead of always parsing JSON. When the handler's return type is a stream, return the `Response` untouched and let the caller consume `res.body`. Keep the existing await for every other case so no current call site changes behaviour.",
    },
  },
  {
    offsetMs: 43_800,
    type: "artifact.write",
    payload: {
      path: "implementation-spec.md",
      bytes: 3_650,
      section: "Task breakdown",
      preview:
        "## Task breakdown\n\n1. **Add a streaming branch to `ClientResponse<T>`** (`src/client/types.ts`). Done when a `streamSSE` handler infers a response exposing `body` and existing non-streaming inference is unchanged — assert both with type tests.\n2. **Stop consuming the body for streaming responses** (`src/client/client.ts:118`). Done when a streaming endpoint yields chunks incrementally through `hc()`.\n3. **Fix the error path** (`src/client/client.ts:164`). Done when a non-2xx streaming response no longer throws inside `res.json()`.\n4. **Add integration coverage**. Done when a test drives `hc()` against a `streamSSE` route and asserts chunk-by-chunk arrival.",
    },
  },
  {
    offsetMs: 48_100,
    type: "artifact.write",
    payload: {
      path: "implementation-spec.md",
      bytes: 4_420,
      section: "Risks and open questions",
      preview:
        "## Risks and open questions\n\n- **Unresolved:** the intended behaviour for a non-2xx streaming response. `client.ts:164` currently calls `res.json()` on the error path and no test covers it. Needs a maintainer decision before task 3.\n- Changing `ClientResponse<T>` is public API surface; a widened type would silently degrade inference for every existing caller, which is why the spec uses a branch.\n- `src/validator/validator.ts:52` also calls `res.json()` but is not on the RPC client path — confirmed out of scope.",
    },
  },
  {
    offsetMs: 51_600,
    type: "artifact.write",
    payload: {
      path: "implementation-spec.md",
      bytes: 5_180,
      section: "Test plan",
      preview:
        "## Test plan\n\n- Type-level: assert a `streamSSE` handler infers a streaming response and a JSON handler's inference is byte-identical to today.\n- Integration: `hc()` against a `streamSSE` route, asserting chunks arrive before the response completes rather than all at once.\n- Regression: the existing client suite must pass unchanged — that is the signal that the branch did not disturb the buffered path.",
    },
  },
  {
    offsetMs: 54_000,
    type: "usage",
    payload: { model: "claude-opus-5", inputTokens: 58_900, outputTokens: 3_980, costUsd: 0.3940 },
  },
  {
    offsetMs: 55_200,
    type: "agent.message",
    payload: {
      text: "Spec written. Four tasks, each naming the files it touches. The one thing I could not determine from the code — error behaviour on a non-2xx streaming response — is recorded as an open question rather than guessed at.",
    },
  },
  {
    offsetMs: 56_000,
    type: "run.end",
    payload: { status: "succeeded", durationMs: 56_000 },
  },
];

/** The deliverable as it stands when the run finishes. */
export const goldenRunArtifact = {
  path: "implementation-spec.md",
  mime: "text/markdown",
  content: goldenRunBeats
    .filter((b) => b.type === "artifact.write")
    .map((b) => (b.type === "artifact.write" ? b.payload.preview : ""))
    .filter(Boolean)
    .join("\n\n"),
};

/**
 * Validate every beat against the event schema. Called by the seed script and
 * by tests: a fixture that does not satisfy the same validation the worker
 * applies would let the UI be built against events that can never occur.
 */
export function validatedGoldenRun(): GoldenBeat[] {
  return goldenRunBeats.map((beat) => {
    parseRunEvent({ type: beat.type, payload: beat.payload });
    return beat;
  });
}

export const GOLDEN_RUN_DURATION_MS = goldenRunBeats.at(-1)!.offsetMs;
export const GOLDEN_RUN_STEP_COUNT = goldenRunBeats.filter(
  (b) => b.type === "step.start",
).length;
