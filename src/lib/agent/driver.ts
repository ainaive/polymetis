import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

import type { DbClient } from "@/db";
import { foldUsage, type UsageTotals } from "@/lib/events/fold";
import type { PayloadFor, RunEventInput } from "@/lib/events/schema";
import { RunEventAppender } from "@/lib/events/store";
import type { Deliverable, ToolPolicy } from "@/lib/templates/contract";

import { createEventMapper } from "./map";

/**
 * Runs one template against one prepared workdir and records what happened.
 *
 * Everything the agent does happens in whatever `spawn` puts it in — normally a
 * container (ADR-0003). This module owns the translation from "a template
 * version plus inputs" to an SDK invocation, and nothing else: the queue,
 * the sandbox, and the credential proxy are all somebody else's problem.
 */

export type RunnableTemplate = {
  slug: string;
  version: number;
  directives: string;
  deliverable: Deliverable;
  toolPolicy: ToolPolicy;
  model: string;
  effort: string;
};

export type RunAgentOptions = {
  runId: string;
  /** Prepared workdir: the repo is already checked out here (ADR-0002). */
  workdir: string;
  template: RunnableTemplate;
  inputs: Record<string, string>;
  /** The issue text, already fetched host-side. */
  issue: string;
  repo?: { owner: string; name: string };
  issueRef?: { owner: string; name: string; number: number; title: string };
  /** Supplied by the sandbox; omitted means the SDK spawns locally. */
  spawn?: Options["spawnClaudeCodeProcess"];
  /** Extra environment for the agent process — the proxy's base URL, mainly. */
  env?: Record<string, string | undefined>;
  maxTurns?: number;
  /** Wall-clock ceiling. Zero or below disables it. */
  timeoutSeconds?: number;
  abortController?: AbortController;
  /** Called after each batch is durably appended, for live progress. */
  onEvents?: (events: RunEventInput[], lastSeq: number) => void;
};

export type RunAgentResult = {
  status: PayloadFor<"run.end">["status"];
  totals: UsageTotals;
  lastSeq: number;
};

const DEFAULT_MAX_TURNS = 120;

/**
 * The prompt is the template's directives plus the concrete task. Kept separate
 * so it can be asserted on without running an agent — the directives are part
 * of the versioned contract, and a change to how they are framed is a change
 * to what the template means.
 */
export function buildPrompt(options: {
  directives: string;
  deliverable: Deliverable;
  issue: string;
}): string {
  return `${options.directives}

---

The repository is at the current working directory. Here is the issue:

${options.issue}

Write your deliverable to ${options.deliverable.filename} in the repository root.`;
}

export async function runAgent(
  db: DbClient,
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const {
    runId,
    workdir,
    template,
    inputs,
    issue,
    repo,
    issueRef,
    spawn,
    env,
    maxTurns = DEFAULT_MAX_TURNS,
    timeoutSeconds = 0,
    abortController = new AbortController(),
    onEvents,
  } = options;

  const startedAtMs = Date.now();
  const elapsed = () => Date.now() - startedAtMs;

  // Distinguishes "the user cancelled" from "we ran out of time" — both abort
  // the same controller, so the reason has to be recorded when it is known.
  let timedOut = false;
  const timeout =
    timeoutSeconds > 0
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, timeoutSeconds * 1_000)
      : null;

  const appender = await RunEventAppender.open(db, runId);
  const collected: RunEventInput[] = [];

  /** True once a terminal event is durably in the log — see the catch below. */
  let sawRunEnd = false;

  const emit = async (events: RunEventInput[]) => {
    if (events.length === 0) return;
    const lastSeq = await appender.append(...events);
    // After the append, never before: an event that failed to persist is not
    // part of the run, and counting it would report totals the log cannot show.
    collected.push(...events);
    if (events.some((event) => event.type === "run.end")) sawRunEnd = true;
    try {
      onEvents?.(events, lastSeq);
    } catch {
      // Live progress is a notification, not part of the record. A subscriber
      // that throws must not fail a run whose events are already durable — and
      // must not throw past the flag above, which would make the catch below
      // append a second terminal event.
    }
  };

  // run.start carries what the SDK cannot know: which template version this
  // was, and what it was pointed at. A replay has to stand alone.
  await emit([
    {
      type: "run.start",
      payload: {
        templateSlug: template.slug,
        templateVersion: template.version,
        inputs,
        ...(repo ? { repo } : {}),
        ...(issueRef ? { issue: issueRef } : {}),
      },
    },
  ]);

  const mapper = createEventMapper({
    deliverableFilename: template.deliverable.filename,
  });

  /** The run's outcome, read back from the log rather than tracked alongside it. */
  const settle = (): RunAgentResult => {
    const end = collected.findLast((event) => event.type === "run.end");
    return {
      status: end?.type === "run.end" ? end.payload.status : "failed",
      totals: foldUsage(collected),
      lastSeq: appender.lastSeq,
    };
  };

  try {
    const response = query({
      prompt: buildPrompt({
        directives: template.directives,
        deliverable: template.deliverable,
        issue,
      }),
      options: {
        cwd: workdir,
        model: template.model,
        effort: template.effort as Options["effort"],
        // The template's tool policy is enforced, not advisory.
        allowedTools: [...template.toolPolicy.allow],
        disallowedTools: [...template.toolPolicy.deny],
        // Never inherit developer or project config: a run must depend only on
        // the template contract, and the sandbox has no such config anyway.
        settingSources: [],
        permissionMode: "bypassPermissions",
        // Token-level deltas would flood an append-only log for no replay
        // benefit; events stay at message granularity.
        includePartialMessages: false,
        maxTurns,
        ...(spawn ? { spawnClaudeCodeProcess: spawn } : {}),
        ...(env ? { env } : {}),
        abortController,
      },
    });

    for await (const message of response) {
      await emit(mapper.map(message));
    }
  } catch (error) {
    // The SDK throws on transport failures and on abort. Either way the run is
    // over, and the log must say so rather than ending mid-stream — a replay
    // with no terminal event is indistinguishable from one still running.
    //
    // Unless it already said so. The SDK can throw during teardown, after the
    // result message was mapped and appended. Appending a second run.end would
    // be permanent — runEvents is append-only — and would flip a succeeded run
    // to failed for every consumer that reads the last one. The run's outcome
    // is whatever the log already recorded; a teardown failure is a footnote to
    // it, not a different ending.
    const message = error instanceof Error ? error.message : String(error);
    const aborted = abortController.signal.aborted;

    if (sawRunEnd) {
      try {
        await emit([
          {
            type: "error",
            payload: { message: `After the run ended: ${message}`, fatal: false },
          },
        ]);
      } catch {
        // The log is already terminal and correct. If the footnote cannot be
        // written — the database being unreachable is the likeliest reason the
        // stream threw at all — that is not worth failing a finished run over.
      }
      return settle();
    }

    await emit([
      {
        type: "error",
        payload: {
          message: timedOut
            ? `The run exceeded its ${timeoutSeconds}s limit and was stopped.`
            : message,
          fatal: true,
        },
      },
      {
        type: "run.end",
        payload: {
          status: timedOut ? "timed_out" : aborted ? "cancelled" : "failed",
          // A real elapsed time, not zero: a run that dies after ten minutes
          // rendering "Finished failed in 0:00" hides the fact most worth
          // knowing about it.
          durationMs: elapsed(),
        },
      },
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  // A stream that ends without a result message leaves the log open. Close it
  // rather than letting the reaper decide later.
  if (!sawRunEnd) {
    await emit([
      {
        type: "error",
        payload: { message: "The agent stream ended without a result.", fatal: true },
      },
      { type: "run.end", payload: { status: "failed", durationMs: elapsed() } },
    ]);
  }

  return settle();
}
