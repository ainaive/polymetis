import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { safeParseRunEvent } from "@/lib/events/schema";

import { createEventMapper, summarizeToolInput } from "./map";

/**
 * SDK messages carry a lot of transport metadata the mapper never reads
 * (uuid, session_id, parent_tool_use_id, timings). These builders supply only
 * the fields under test and cast, so the fixtures stay legible — the cast is
 * the point at which we assert "the mapper depends on nothing else".
 */
const assistant = (content: unknown[]): SDKMessage =>
  ({ type: "assistant", message: { content } }) as unknown as SDKMessage;

const user = (content: unknown[]): SDKMessage =>
  ({ type: "user", message: { content } }) as unknown as SDKMessage;

const result = (over: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    duration_ms: 1_234,
    num_turns: 3,
    total_cost_usd: 0.5,
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 28,
        outputTokens: 24_182,
        cacheReadInputTokens: 380_000,
        cacheCreationInputTokens: 70_000,
        costUSD: 2.8862,
      },
    },
    ...over,
  }) as unknown as SDKMessage;

const mapper = () => createEventMapper({ deliverableFilename: "implementation-spec.md" });

describe("assistant messages", () => {
  test("text blocks become agent messages", () => {
    const events = mapper().map(assistant([{ type: "text", text: "  Reading the issue.  " }]));
    expect(events).toEqual([
      { type: "agent.message", payload: { text: "Reading the issue." } },
    ]);
  });

  test("empty text blocks are dropped rather than rendering as blank rows", () => {
    expect(mapper().map(assistant([{ type: "text", text: "   " }]))).toEqual([]);
  });

  test("tool_use becomes a tool call with a legible summary", () => {
    const events = mapper().map(
      assistant([
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/src/a.ts" } },
      ]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool.call",
      payload: { toolCallId: "t1", tool: "Read", summary: "/w/src/a.ts" },
    });
  });

  test("thinking blocks are ignored", () => {
    expect(mapper().map(assistant([{ type: "thinking", thinking: "hmm" }]))).toEqual([]);
  });

  test("one message can produce several events, in order", () => {
    const events = mapper().map(
      assistant([
        { type: "text", text: "Now I will look." },
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "res.json" } },
      ]),
    );
    expect(events.map((e) => e.type)).toEqual(["agent.message", "tool.call"]);
  });

  test("a malformed message yields nothing instead of throwing", () => {
    expect(mapper().map({ type: "assistant" } as unknown as SDKMessage)).toEqual([]);
  });
});

describe("tool results", () => {
  test("a successful result is ok", () => {
    const events = mapper().map(
      user([{ type: "tool_result", tool_use_id: "t1", content: "12 lines" }]),
    );
    expect(events[0]).toMatchObject({
      type: "tool.result",
      payload: { toolCallId: "t1", ok: true, summary: "12 lines" },
    });
  });

  test("an errored result is marked not ok", () => {
    const events = mapper().map(
      user([
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: "ENOENT: no such file",
        },
      ]),
    );
    expect(events[0]).toMatchObject({
      type: "tool.result",
      payload: { ok: false, summary: "ENOENT: no such file" },
    });
  });

  test("multi-line output keeps the first line as the summary and the rest as detail", () => {
    const events = mapper().map(
      user([{ type: "tool_result", tool_use_id: "t1", content: "3 matches\na.ts\nb.ts" }]),
    );
    expect(events[0]).toMatchObject({
      type: "tool.result",
      payload: { summary: "3 matches", detail: "3 matches\na.ts\nb.ts" },
    });
  });

  test("block-shaped tool content is flattened", () => {
    const events = mapper().map(
      user([
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [{ type: "text", text: "6 files" }],
        },
      ]),
    );
    expect(events[0]).toMatchObject({ payload: { summary: "6 files" } });
  });
});

describe("the deliverable", () => {
  test("a successful write of the deliverable emits an artifact", () => {
    const m = mapper();
    m.map(
      assistant([
        {
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: "/workspace/implementation-spec.md", content: "# Spec\n\nbody" },
        },
      ]),
    );
    const events = m.map(user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }]));

    expect(events.map((e) => e.type)).toEqual(["tool.result", "artifact.write"]);
    expect(events[1]).toMatchObject({
      type: "artifact.write",
      payload: { path: "implementation-spec.md", bytes: 12, preview: "# Spec\n\nbody" },
    });
  });

  test("a failed write emits no artifact — the deliverable does not exist", () => {
    const m = mapper();
    m.map(
      assistant([
        {
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: "/workspace/implementation-spec.md", content: "x" },
        },
      ]),
    );
    const events = m.map(
      user([
        { type: "tool_result", tool_use_id: "w1", is_error: true, content: "EACCES" },
      ]),
    );
    expect(events.map((e) => e.type)).toEqual(["tool.result"]);
  });

  test("writes to other files are not treated as the deliverable", () => {
    const m = mapper();
    m.map(
      assistant([
        {
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: "/workspace/scratch.md", content: "notes" },
        },
      ]),
    );
    const events = m.map(user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }]));
    expect(events.map((e) => e.type)).toEqual(["tool.result"]);
  });

  test("a pending write is not re-reported on a later unrelated result", () => {
    const m = mapper();
    m.map(
      assistant([
        {
          type: "tool_use",
          id: "w1",
          name: "Write",
          input: { file_path: "/workspace/implementation-spec.md", content: "x" },
        },
      ]),
    );
    m.map(user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }]));
    const again = m.map(user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }]));
    expect(again.map((e) => e.type)).toEqual(["tool.result"]);
  });
});

describe("the result message", () => {
  test("emits usage carrying cache traffic, then run.end", () => {
    const events = mapper().map(result());
    expect(events.map((e) => e.type)).toEqual(["usage", "run.end"]);
    expect(events[0]).toMatchObject({
      type: "usage",
      payload: {
        model: "claude-opus-5",
        inputTokens: 28,
        cacheReadTokens: 380_000,
        cacheCreationTokens: 70_000,
        costUsd: 2.8862,
      },
    });
    expect(events[1]).toMatchObject({
      type: "run.end",
      payload: { status: "succeeded", durationMs: 1_234 },
    });
  });

  test("one usage event per model when the run used more than one", () => {
    const events = mapper().map(
      result({
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            costUSD: 0.1,
          },
          "claude-haiku-4-5": {
            inputTokens: 5,
            outputTokens: 6,
            cacheReadInputTokens: 7,
            cacheCreationInputTokens: 8,
            costUSD: 0.2,
          },
        },
      }),
    );
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
  });

  test("a turn-limit failure reports an error and a failed run", () => {
    const events = mapper().map(result({ subtype: "error_max_turns", errors: [] }));
    expect(events.map((e) => e.type)).toEqual(["usage", "error", "run.end"]);
    expect(events[1]).toMatchObject({
      type: "error",
      payload: { message: "The agent hit its turn limit before finishing.", fatal: true },
    });
    expect(events[2]).toMatchObject({ payload: { status: "failed" } });
  });

  test("reported errors are preferred over the generic message", () => {
    const events = mapper().map(
      result({ subtype: "error_during_execution", errors: ["disk full", "aborted"] }),
    );
    expect(events[1]).toMatchObject({ payload: { message: "disk full; aborted" } });
  });

  test("usage is still recorded when the run failed — a partial run costs money", () => {
    const events = mapper().map(result({ subtype: "error_during_execution", errors: ["x"] }));
    expect(events[0].type).toBe("usage");
  });
});

describe("everything the mapper produces", () => {
  test("validates against the event schema", () => {
    // The driver appends these straight to the log, where parseRunEvent runs.
    // Anything the mapper can emit must survive that, or a real run would fail
    // mid-flight rather than at test time.
    const m = mapper();
    const produced = [
      ...m.map(assistant([{ type: "text", text: "hello" }])),
      ...m.map(
        assistant([
          {
            type: "tool_use",
            id: "w1",
            name: "Write",
            input: { file_path: "/w/implementation-spec.md", content: "body" },
          },
        ]),
      ),
      ...m.map(user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }])),
      ...m.map(result({ subtype: "error_max_turns", errors: [] })),
    ];

    expect(produced.length).toBeGreaterThan(0);
    for (const event of produced) {
      const parsed = safeParseRunEvent(event);
      expect(parsed.success, `${event.type} failed validation`).toBe(true);
    }
  });
});

describe("summarizeToolInput", () => {
  test("prefers the most specific field available", () => {
    expect(summarizeToolInput("Read", { file_path: "a.ts" })).toBe("a.ts");
    expect(summarizeToolInput("Grep", { pattern: "foo" })).toBe("foo");
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  test("falls back to the tool name when nothing is recognisable", () => {
    expect(summarizeToolInput("MysteryTool", { unknown: 1 })).toBe("MysteryTool");
  });

  test("collapses a multi-line value to its first line", () => {
    expect(summarizeToolInput("Bash", { command: "one\ntwo" })).toBe("one");
  });
});
