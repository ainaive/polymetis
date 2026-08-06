import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { PayloadFor, RunEventInput } from "@/lib/events/schema";

/**
 * Translates the Agent SDK's message stream into our run event log.
 *
 * This is the only place that knows the SDK's message shapes. Keeping it free
 * of I/O means the whole mapping — including the awkward cases, like a tool
 * that fails or a run that ends on a turn limit — is testable from recorded
 * message fixtures with no subprocess, no container, and no network.
 *
 * A little state is unavoidable: a tool call and its result arrive as two
 * separate messages, so recognising "the agent finished writing the
 * deliverable" means remembering the call. The state is per-run and lives
 * here rather than in the driver.
 */

/** Longest artifact preview stored on an event. The full file goes to runArtifacts. */
const PREVIEW_LIMIT = 4_000;
/** Tool result summaries are for a replay row, not an archive. */
const SUMMARY_LIMIT = 300;

export type MapperContext = {
  /** Used to recognise a write of the deliverable rather than a scratch file. */
  deliverableFilename: string;
};

type PendingWrite = { path: string; bytes: number; preview: string };

export type EventMapper = {
  /** Zero or more run events for one SDK message, in order. */
  map(message: SDKMessage): RunEventInput[];
};

export function createEventMapper(ctx: MapperContext): EventMapper {
  // toolCallId -> the write we will report once its result confirms success.
  const pendingWrites = new Map<string, PendingWrite>();

  return {
    map(message: SDKMessage): RunEventInput[] {
      switch (message.type) {
        case "assistant":
          return mapAssistant(message, ctx, pendingWrites);
        case "user":
          return mapUser(message, pendingWrites);
        case "result":
          return mapResult(message);
        default:
          // Everything else — status, partial, hooks, retries — is deliberately
          // dropped. The log records what the agent did, not how the harness
          // felt while doing it.
          return [];
      }
    },
  };
}

function mapAssistant(
  message: Extract<SDKMessage, { type: "assistant" }>,
  ctx: MapperContext,
  pendingWrites: Map<string, PendingWrite>,
): RunEventInput[] {
  const events: RunEventInput[] = [];
  const content = message.message?.content;
  if (!Array.isArray(content)) return events;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text.trim() : "";
      // Empty text blocks are common between tool calls; they would render as
      // blank rows in the replay.
      if (text) events.push({ type: "agent.message", payload: { text } });
      continue;
    }

    if (block.type === "tool_use") {
      const input = (block.input ?? {}) as Record<string, unknown>;
      events.push({
        type: "tool.call",
        payload: {
          toolCallId: block.id,
          tool: block.name,
          summary: summarizeToolInput(block.name, input),
          args: input,
        },
      });

      const write = asDeliverableWrite(block.name, input, ctx.deliverableFilename);
      if (write) pendingWrites.set(block.id, write);
    }
  }

  return events;
}

function mapUser(
  message: Extract<SDKMessage, { type: "user" }>,
  pendingWrites: Map<string, PendingWrite>,
): RunEventInput[] {
  const events: RunEventInput[] = [];
  const content = message.message?.content;
  if (!Array.isArray(content)) return events;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "tool_result") continue;

    const toolCallId = block.tool_use_id;
    const ok = block.is_error !== true;
    const text = toolResultText(block.content);

    events.push({
      type: "tool.result",
      payload: {
        toolCallId,
        ok,
        summary: truncate(firstLine(text), SUMMARY_LIMIT),
        ...(text.includes("\n") ? { detail: truncate(text, SUMMARY_LIMIT * 4) } : {}),
      },
    });

    // Report the artifact only once the write actually succeeded — emitting it
    // at call time would claim a deliverable exists when the tool errored.
    const pending = pendingWrites.get(toolCallId);
    if (pending) {
      pendingWrites.delete(toolCallId);
      if (ok) {
        events.push({
          type: "artifact.write",
          payload: {
            path: pending.path,
            bytes: pending.bytes,
            preview: pending.preview,
          },
        });
      }
    }
  }

  return events;
}

function mapResult(
  message: Extract<SDKMessage, { type: "result" }>,
): RunEventInput[] {
  const events: RunEventInput[] = [];

  // One usage event per model. A run that falls back to another model produces
  // two, and both are folded into the run's totals.
  for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
    events.push({
      type: "usage",
      payload: {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        costUsd: usage.costUSD,
      },
    });
  }

  if (message.subtype !== "success") {
    events.push({
      type: "error",
      payload: {
        message: describeFailure(message),
        fatal: true,
      },
    });
  }

  events.push({
    type: "run.end",
    payload: {
      status: runStatusFor(message.subtype),
      durationMs: message.duration_ms,
    },
  });

  return events;
}

function runStatusFor(
  subtype: Extract<SDKMessage, { type: "result" }>["subtype"],
): PayloadFor<"run.end">["status"] {
  switch (subtype) {
    case "success":
      return "succeeded";
    default:
      // Turn limits, budget limits and execution errors are all "the run did
      // not produce its deliverable". Wall-clock timeouts and cancellation are
      // decided by the worker, which is what enforces them, and it overrides
      // this when it terminates the run itself.
      return "failed";
  }
}

function describeFailure(
  message: Extract<SDKMessage, { type: "result"; subtype: string }>,
): string {
  const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
  if (errors.length > 0) return truncate(errors.join("; "), SUMMARY_LIMIT * 4);
  switch (message.subtype) {
    case "error_max_turns":
      return "The agent hit its turn limit before finishing.";
    case "error_max_budget_usd":
      return "The agent hit its cost limit before finishing.";
    default:
      return `The run failed (${message.subtype}).`;
  }
}

/** A one-line description of what a tool call is doing, for the replay row. */
export function summarizeToolInput(
  tool: string,
  input: Record<string, unknown>,
): string {
  const candidates = [
    input.file_path,
    input.pattern,
    input.path,
    input.command,
    input.url,
    input.query,
    input.prompt,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return truncate(firstLine(value.trim()), SUMMARY_LIMIT);
    }
  }
  return tool;
}

function asDeliverableWrite(
  tool: string,
  input: Record<string, unknown>,
  deliverableFilename: string,
): PendingWrite | null {
  if (tool !== "Write") return null;
  const path = typeof input.file_path === "string" ? input.file_path : null;
  const content = typeof input.content === "string" ? input.content : null;
  if (!path || content === null) return null;
  // Match on the basename: the agent writes an absolute path inside the
  // sandbox, and the template contract only declares a filename.
  if (basename(path) !== deliverableFilename) return null;

  return {
    path: basename(path),
    bytes: new TextEncoder().encode(content).length,
    preview: truncate(content, PREVIEW_LIMIT),
  };
}

/** Tool results arrive as a string or as content blocks depending on the tool. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n")
    .trim();
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index === -1 ? text : text.slice(0, index);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
