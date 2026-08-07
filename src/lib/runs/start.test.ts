import { describe, expect, test } from "bun:test";

import type { Db } from "@/db";
import { issueToSpecInputSchema } from "@/lib/templates/issue-to-spec";

import { startRunForWorkspace, type StartRunInput } from "./start";

type Captured = { runs: Record<string, unknown>[]; queue: Record<string, unknown>[] };

/**
 * Records the two inserts instead of performing them, and answers the
 * in-flight count the transaction re-checks under its lock.
 */
function stubDb(captured: Captured, liveRuns = 0) {
  const tx = {
    select: () => ({
      from: () => ({
        // The workspace lock: .where().for("update")
        where: (..._args: unknown[]) => {
          const result = Promise.resolve([{ count: String(liveRuns) }]);
          return Object.assign(result, { for: () => Promise.resolve([{ id: "ws_1" }]) });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        // The run row carries a status; the queue row is only a runId.
        (("status" in row) ? captured.runs : captured.queue).push(row);
        void table;
        return Promise.resolve();
      },
    }),
  };
  return {
    transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  } as unknown as Db;
}

const base = (over: Partial<StartRunInput> = {}): StartRunInput => ({
  workspaceId: "ws_1",
  userId: "user_1",
  template: { versionId: "tplv_1", inputSchema: issueToSpecInputSchema },
  submitted: {
    repo: "anthropics/claude-code",
    issue: "https://github.com/anthropics/claude-code/issues/12",
    audience: "engineer",
  },
  usage: { usedTokens: 0, allowanceTokens: 20_000_000, inFlight: 0 },
  maxConcurrent: 3,
  ...over,
});

const capture = (): Captured => ({ runs: [], queue: [] });

describe("startRunForWorkspace", () => {
  test("queues a run owned by the workspace", async () => {
    const c = capture();
    const result = await startRunForWorkspace(stubDb(c), base());

    expect(result.ok).toBe(true);
    expect(c.runs[0]).toMatchObject({
      workspaceId: "ws_1",
      userId: "user_1",
      templateVersionId: "tplv_1",
      status: "queued",
      // Private now that a run has an owner who can read it.
      visibility: "private",
    });
    expect(c.queue).toHaveLength(1);
  });

  test("converts owner/name into the URL the worker clones", async () => {
    // The contract validates `owner/name`; classifyRepoSource wants https. If
    // this conversion were missing the worker would reject its own run.
    const c = capture();
    await startRunForWorkspace(stubDb(c), base());

    expect((c.runs[0]!.inputs as Record<string, string>).repo).toBe(
      "https://github.com/anthropics/claude-code.git",
    );
  });

  test("accepts a GitHub URL as well as a short reference", async () => {
    const c = capture();
    await startRunForWorkspace(
      stubDb(c),
      base({
        submitted: {
          repo: "https://github.com/anthropics/claude-code",
          issue: "https://github.com/anthropics/claude-code/issues/12",
          audience: "engineer",
        },
      }),
    );

    expect((c.runs[0]!.inputs as Record<string, string>).repo).toBe(
      "https://github.com/anthropics/claude-code.git",
    );
  });

  test("reports the template's own field errors", async () => {
    const c = capture();
    const result = await startRunForWorkspace(
      stubDb(c),
      base({ submitted: { repo: "not a repo", issue: "", audience: "engineer" } }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join(" ")).toContain("repo");
    expect(c.runs).toHaveLength(0);
  });

  test("writes nothing when the workspace is over its allowance", async () => {
    const c = capture();
    const result = await startRunForWorkspace(
      stubDb(c),
      base({ usage: { usedTokens: 20_000_000, allowanceTokens: 20_000_000, inFlight: 0 } }),
    );

    expect(result).toEqual({ ok: false, errors: ["quota-allowance"] });
    expect(c.runs).toHaveLength(0);
    expect(c.queue).toHaveLength(0);
  });

  test("writes nothing when too many runs are already in flight", async () => {
    const c = capture();
    const result = await startRunForWorkspace(
      stubDb(c),
      base({ usage: { usedTokens: 0, allowanceTokens: 20_000_000, inFlight: 3 } }),
    );

    expect(result).toEqual({ ok: false, errors: ["quota-concurrency"] });
    expect(c.runs).toHaveLength(0);
  });

  test("checks quota before field validation", async () => {
    // Being over the limit is not something a better repository name fixes, so
    // an over-quota workspace gets one clear answer rather than a list of
    // corrections that will not help.
    const c = capture();
    const result = await startRunForWorkspace(
      stubDb(c),
      base({
        submitted: { repo: "nonsense", issue: "", audience: "engineer" },
        usage: { usedTokens: 1, allowanceTokens: 1, inFlight: 0 },
      }),
    );

    expect(result).toEqual({ ok: false, errors: ["quota-allowance"] });
  });

  test("refuses a repository the worker itself would refuse", async () => {
    // The SSRF guard, applied at the form rather than discovered as a failed
    // run twenty seconds later.
    const c = capture();
    const result = await startRunForWorkspace(
      stubDb(c),
      base({
        submitted: {
          repo: "https://169.254.169.254/latest.git",
          issue: "https://github.com/o/r/issues/1",
          audience: "engineer",
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(c.runs).toHaveLength(0);
  });
});

describe("the concurrency cap under contention", () => {
  test("is re-checked inside the transaction, not only from the caller's count", async () => {
    // The caller's usage says there is room; the database says there is not,
    // because another request took the last slot in between. Reading the count
    // outside the transaction is a read-then-write race, and the count that
    // decides has to be the one written against.
    const c = capture();
    const result = await startRunForWorkspace(
      stubDb(c, 3),
      base({ usage: { usedTokens: 0, allowanceTokens: 20_000_000, inFlight: 0 } }),
    );

    expect(result).toEqual({ ok: false, errors: ["quota-concurrency"] });
    expect(c.runs).toHaveLength(0);
    expect(c.queue).toHaveLength(0);
  });
});
