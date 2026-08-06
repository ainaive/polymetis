import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import type { RunEventInput } from "@/lib/events/schema";
import {
  issueToSpecDeliverable,
  issueToSpecDirectives,
  issueToSpecToolPolicy,
} from "@/lib/templates/issue-to-spec";

import { buildPrompt, runAgent } from "./driver";

describe("buildPrompt", () => {
  const prompt = buildPrompt({
    directives: issueToSpecDirectives,
    deliverable: issueToSpecDeliverable,
    issue: "Title: Support X\n\nSome body.",
  });

  test("leads with the template's directives verbatim", () => {
    // The directives are part of the versioned contract. Reframing or
    // truncating them here would silently change what a template means
    // without producing a new template version.
    expect(prompt.startsWith(issueToSpecDirectives)).toBe(true);
  });

  test("includes the issue text", () => {
    expect(prompt).toContain("Title: Support X");
    expect(prompt).toContain("Some body.");
  });

  test("names the deliverable the contract declares", () => {
    expect(prompt).toContain(issueToSpecDeliverable.filename);
  });

  test("does not name a path outside the workdir", () => {
    // The agent writes inside the sandbox; an absolute host path in the prompt
    // would either fail or, worse, escape the workdir.
    expect(prompt).not.toContain("/Users/");
    expect(prompt).not.toContain("/private/");
  });
});

describe("the run timeout", () => {
  /**
   * Collects appended events instead of writing to Postgres. runAgent only
   * uses the client to open an appender and insert, so a stub keeps this a
   * unit test — an AGENTS.md rule, and the timeout is otherwise impractical to
   * exercise.
   */
  function stubDb(sink: RunEventInput[]) {
    return {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ max: 0 }]) }),
      }),
      insert: () => ({
        values: (rows: { type: string; payload: unknown }[]) => {
          for (const row of rows) sink.push(row as unknown as RunEventInput);
          return Promise.resolve();
        },
      }),
    } as never;
  }

  const template = {
    slug: "issue-to-spec",
    version: 1,
    directives: issueToSpecDirectives,
    deliverable: issueToSpecDeliverable,
    toolPolicy: issueToSpecToolPolicy,
    model: "claude-opus-5",
    effort: "low",
  };

  test("a run that never finishes is stopped and settled as timed_out", async () => {
    const events: RunEventInput[] = [];

    const result = await runAgent(stubDb(events), {
      runId: "run_timeout_test",
      workdir: process.cwd(),
      template,
      inputs: {},
      issue: "irrelevant",
      timeoutSeconds: 1,
      // A process that reads stdin forever and says nothing: the SDK waits on
      // a protocol handshake that never comes, which is what a hung agent
      // looks like from here.
      spawn: () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] }),
    });

    expect(result.status).toBe("timed_out");

    const end = events.findLast((e) => e.type === "run.end");
    expect(end?.type === "run.end" && end.payload.status).toBe("timed_out");
    // The defect this replaces: every error path reported zero, so a run that
    // died after ten minutes rendered "Finished failed in 0:00".
    expect(end?.type === "run.end" && end.payload.durationMs).toBeGreaterThan(0);

    const error = events.find((e) => e.type === "error");
    expect(error?.type === "error" && error.payload.message).toContain("1s limit");
  }, 20_000);
});
