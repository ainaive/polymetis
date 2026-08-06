/**
 * Counts tokens flowing through the credential proxy.
 *
 * The proxy needs its own count because the agent's self-report arrives only
 * at the end of a run — too late to stop a runaway one. This is a circuit
 * breaker, not accounting: it trips on tokens, which it observes exactly, and
 * deliberately does not compute cost. A dollar ceiling here would need a
 * pricing table duplicated from the SDK and free to drift out of step with it;
 * the authoritative cost stays the SDK's `total_cost_usd`.
 */

export type ObservedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export const EMPTY_USAGE: ObservedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function totalTokens(usage: ObservedUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens
  );
}

export function addUsage(a: ObservedUsage, b: ObservedUsage): ObservedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Read a usage object off any shape that carries one. */
export function readUsage(value: unknown): ObservedUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const num = (key: string) => (typeof usage[key] === "number" ? usage[key] : 0);
  const known = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];
  if (!known.some((key) => typeof usage[key] === "number")) return null;
  return {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cacheReadTokens: num("cache_read_input_tokens"),
    cacheCreationTokens: num("cache_creation_input_tokens"),
  };
}

/**
 * Incremental scanner over a response body, streaming or not.
 *
 * Streaming responses report usage twice: `message_start` carries the input
 * side and `message_delta` the running output count. Taking the maximum of
 * each field rather than summing avoids double-counting a running total that
 * is re-sent on every delta.
 */
export class UsageMeter {
  private buffer = "";
  private current: ObservedUsage = { ...EMPTY_USAGE };
  private completed: ObservedUsage = { ...EMPTY_USAGE };

  /** Feed a chunk of the response body. Safe to call with partial lines. */
  push(chunk: string): void {
    this.buffer += chunk;

    // SSE frames are line-delimited; keep the trailing partial line.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      this.absorb(payload);
    }
  }

  /** Call once the body has ended; handles a non-streaming JSON response. */
  end(): void {
    const remainder = this.buffer.trim();
    this.buffer = "";
    if (remainder) {
      // Either a trailing SSE line without its newline, or a whole JSON body.
      this.absorb(
        remainder.startsWith("data:")
          ? remainder.slice("data:".length).trim()
          : remainder,
      );
    }
    this.completed = addUsage(this.completed, this.current);
    this.current = { ...EMPTY_USAGE };
  }

  private absorb(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Partial or non-JSON frames are expected; ignore rather than fail a
      // request because a keep-alive comment did not parse.
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    const node = parsed as Record<string, unknown>;
    const usage =
      readUsage(node.usage) ??
      readUsage((node.message as Record<string, unknown> | undefined)?.usage);
    if (!usage) return;

    // Within one response, each field is a running total that is re-sent, so
    // take the high-water mark instead of accumulating.
    this.current = {
      inputTokens: Math.max(this.current.inputTokens, usage.inputTokens),
      outputTokens: Math.max(this.current.outputTokens, usage.outputTokens),
      cacheReadTokens: Math.max(this.current.cacheReadTokens, usage.cacheReadTokens),
      cacheCreationTokens: Math.max(
        this.current.cacheCreationTokens,
        usage.cacheCreationTokens,
      ),
    };
  }

  /** Everything counted so far, including the response in flight. */
  get total(): ObservedUsage {
    return addUsage(this.completed, this.current);
  }
}
