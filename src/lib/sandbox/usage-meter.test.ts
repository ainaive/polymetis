import { describe, expect, test } from "bun:test";

import { readUsage, totalTokens, UsageMeter } from "./usage-meter";

const sse = (...frames: object[]) =>
  frames.map((f) => `event: x\ndata: ${JSON.stringify(f)}\n\n`).join("");

describe("readUsage", () => {
  test("reads the Anthropic usage shape", () => {
    expect(
      readUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    });
  });

  test("treats absent fields as zero rather than NaN", () => {
    expect(readUsage({ output_tokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  test("returns null for anything that is not a usage object", () => {
    expect(readUsage(null)).toBeNull();
    expect(readUsage({ unrelated: 1 })).toBeNull();
    expect(readUsage("usage")).toBeNull();
  });
});

describe("UsageMeter over a streaming response", () => {
  test("counts input from message_start and output from message_delta", () => {
    const meter = new UsageMeter();
    meter.push(
      sse(
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 4_000,
              cache_creation_input_tokens: 500,
            },
          },
        },
        { type: "message_delta", usage: { output_tokens: 40 } },
        { type: "message_delta", usage: { output_tokens: 90 } },
      ),
    );
    meter.end();

    // output_tokens is a running total re-sent on every delta: summing would
    // report 130 for a response that produced 90.
    expect(meter.total).toEqual({
      inputTokens: 100,
      outputTokens: 90,
      cacheReadTokens: 4_000,
      cacheCreationTokens: 500,
    });
    expect(totalTokens(meter.total)).toBe(4_690);
  });

  test("survives chunk boundaries that split a frame mid-line", () => {
    const body = sse(
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "message_delta", usage: { output_tokens: 11 } },
    );
    const meter = new UsageMeter();
    // Byte-at-a-time is the worst case a network can hand us.
    for (const char of body) meter.push(char);
    meter.end();
    expect(meter.total.inputTokens).toBe(7);
    expect(meter.total.outputTokens).toBe(11);
  });

  test("ignores keep-alive comments and the DONE sentinel", () => {
    const meter = new UsageMeter();
    meter.push(": ping\n\ndata: [DONE]\n\n");
    meter.end();
    expect(totalTokens(meter.total)).toBe(0);
  });

  test("ignores frames that are not valid JSON rather than failing", () => {
    const meter = new UsageMeter();
    meter.push("data: {not json\n\n");
    meter.end();
    expect(totalTokens(meter.total)).toBe(0);
  });

  test("accumulates across separate responses", () => {
    const meter = new UsageMeter();
    meter.push(sse({ type: "message_delta", usage: { output_tokens: 10 } }));
    meter.end();
    meter.push(sse({ type: "message_delta", usage: { output_tokens: 25 } }));
    meter.end();
    // Two requests through the same proxy: 10 then 25, not max(10, 25).
    expect(meter.total.outputTokens).toBe(35);
  });
});

describe("UsageMeter over a non-streaming response", () => {
  test("reads usage from a whole JSON body", () => {
    const meter = new UsageMeter();
    meter.push(
      JSON.stringify({
        type: "message",
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    );
    meter.end();
    expect(meter.total.inputTokens).toBe(12);
    expect(meter.total.outputTokens).toBe(34);
  });

  test("a body carrying no usage counts nothing", () => {
    const meter = new UsageMeter();
    meter.push(JSON.stringify({ type: "error", error: { message: "nope" } }));
    meter.end();
    expect(totalTokens(meter.total)).toBe(0);
  });
});

describe("the running total during a response", () => {
  test("is visible before the response ends, so a breaker can trip mid-flight", () => {
    const meter = new UsageMeter();
    meter.push(sse({ type: "message_delta", usage: { output_tokens: 5_000 } }));
    // No end() yet — this is the whole point of a circuit breaker.
    expect(meter.total.outputTokens).toBe(5_000);
  });
});
