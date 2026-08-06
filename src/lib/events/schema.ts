import { z } from "zod";

/**
 * The closed set of run event types (ADR-0001).
 *
 * These payload shapes are effectively public API: replay renders events
 * recorded months ago, so a payload can gain optional fields but must never
 * repurpose or remove an existing one. Add a new event type instead.
 */

const repoRef = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});

const issueRef = repoRef.extend({
  number: z.number().int().positive(),
  title: z.string(),
});

/** The run began. Carries enough context for a replay to stand alone. */
export const runStartPayload = z.object({
  templateSlug: z.string().min(1),
  templateVersion: z.number().int().positive(),
  inputs: z.record(z.string(), z.string()),
  repo: repoRef.optional(),
  issue: issueRef.optional(),
});

/** A named phase of work, used as the replay timeline's chapter markers. */
export const stepStartPayload = z.object({
  index: z.number().int().nonnegative(),
  label: z.string().min(1),
});

/** The agent invoked a tool. `summary` is what the replay shows in the row. */
export const toolCallPayload = z.object({
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  summary: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const toolResultPayload = z.object({
  toolCallId: z.string().min(1),
  ok: z.boolean(),
  summary: z.string(),
  detail: z.string().optional(),
});

/** Agent narration between tool calls. */
export const agentMessagePayload = z.object({
  text: z.string(),
});

/** The deliverable, or a section of it, was written to the output directory. */
export const artifactWritePayload = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  section: z.string().optional(),
  preview: z.string().optional(),
});

/**
 * Token and cost accounting. Summed across a run to get its total.
 *
 * The cache fields are optional because they were added after the first runs
 * were recorded — ADR-0001 permits new optional fields but not repurposing
 * existing ones, so events written before this exist without them.
 *
 * They matter more than they look. A validation run reporting 24k output
 * tokens cost $2.89, which only reconciles once ~450k input tokens of cache
 * traffic are counted: `inputTokens` alone excludes cache reads and writes
 * entirely, so a run's token totals would understate reality by an order of
 * magnitude while its cost stayed correct. `costUsd` is always taken from the
 * SDK rather than derived from these counts.
 */
export const usagePayload = z.object({
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
});

export const errorPayload = z.object({
  message: z.string().min(1),
  fatal: z.boolean(),
});

export const runEndPayload = z.object({
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
  durationMs: z.number().int().nonnegative(),
});

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.start"), payload: runStartPayload }),
  z.object({ type: z.literal("step.start"), payload: stepStartPayload }),
  z.object({ type: z.literal("tool.call"), payload: toolCallPayload }),
  z.object({ type: z.literal("tool.result"), payload: toolResultPayload }),
  z.object({ type: z.literal("agent.message"), payload: agentMessagePayload }),
  z.object({ type: z.literal("artifact.write"), payload: artifactWritePayload }),
  z.object({ type: z.literal("usage"), payload: usagePayload }),
  z.object({ type: z.literal("error"), payload: errorPayload }),
  z.object({ type: z.literal("run.end"), payload: runEndPayload }),
]);

export const runEventTypes = [
  "run.start",
  "step.start",
  "tool.call",
  "tool.result",
  "agent.message",
  "artifact.write",
  "usage",
  "error",
  "run.end",
] as const;

export type RunEventType = (typeof runEventTypes)[number];

/** A validated event, before it is assigned a sequence number. */
export type RunEventInput = z.infer<typeof runEventSchema>;

/** The payload shape for one specific event type. */
export type PayloadFor<T extends RunEventType> = Extract<
  RunEventInput,
  { type: T }
>["payload"];

/** The union of every payload shape, as stored in run_event.payload. */
export type RunEventPayload = RunEventInput["payload"];

/**
 * Validate an event before it is appended. The worker calls this on every
 * event, so a malformed payload fails at write time rather than years later
 * when a replay tries to render it.
 */
export function parseRunEvent(value: unknown): RunEventInput {
  return runEventSchema.parse(value);
}

export function safeParseRunEvent(value: unknown) {
  return runEventSchema.safeParse(value);
}
