import { describe, expect, test } from "bun:test";

import { canCurate, type CurateCandidate } from "./curate";

const good = (over: Partial<CurateCandidate> = {}): CurateCandidate => ({
  runId: "run_1",
  status: "succeeded",
  repo: "https://github.com/honojs/hono.git",
  hasArtifact: true,
  hasTerminalEvent: true,
  ...over,
});

describe("canCurate", () => {
  test("accepts a finished run against a public repository", () => {
    expect(canCurate(good())).toEqual({ ok: true });
  });

  test("refuses a run that did not succeed", () => {
    for (const status of ["failed", "timed_out", "cancelled", "running", "queued"]) {
      expect(canCurate(good({ status })).ok).toBe(false);
    }
  });

  test("refuses a run whose log never ended", () => {
    // The run row can say succeeded while the log says otherwise, and the log
    // is what a visitor watches — a replay with no run.end never stops.
    expect(canCurate(good({ hasTerminalEvent: false }))).toMatchObject({
      ok: false,
      reason: "no-terminal-event",
    });
  });

  test("refuses a run with no deliverable", () => {
    // The deliverable is the thing being advertised; a replay without one
    // demonstrates the opposite of the claim.
    expect(canCurate(good({ hasArtifact: false }))).toMatchObject({
      ok: false,
      reason: "no-artifact",
    });
  });

  test("refuses a run against a local path", () => {
    // "Run this on your own repo" sits beneath every card. A demo pointing at
    // a directory on one laptop is an invitation nobody can accept.
    expect(canCurate(good({ repo: "/private/tmp/scratch/repo-copy" }))).toMatchObject({
      ok: false,
      reason: "not-reproducible",
    });
  });

  test("refuses a run with no repository at all", () => {
    expect(canCurate(good({ repo: null }))).toMatchObject({
      ok: false,
      reason: "no-repo",
    });
  });

  test("refuses a repository the worker itself would not clone", () => {
    // The same guard the run path applies, so a demo cannot advertise
    // something that would fail if a visitor tried it.
    expect(canCurate(good({ repo: "https://169.254.169.254/x.git" }))).toMatchObject({
      ok: false,
      reason: "not-reproducible",
    });
  });

  test("explains each refusal in terms of the run, not the rule", () => {
    const decision = canCurate(good({ status: "timed_out" }));
    expect(decision.ok === false && decision.detail).toContain("timed_out");
  });
});
