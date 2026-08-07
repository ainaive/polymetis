import { describe, expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Db } from "@/db";
import type { UsageTotals } from "@/lib/events/fold";
import type { RunEventInput } from "@/lib/events/schema";
import type { Deliverable } from "@/lib/templates/contract";

import {
  MAX_READ_ARTIFACT_BYTES,
  OBSERVED_MODEL,
  settleRun,
  type SettleInput,
} from "./settle";

const deliverable: Deliverable = {
  filename: "SPEC.md",
  format: "markdown",
  sections: ["Summary"],
};

const noUsage: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

type Captured = {
  appended: RunEventInput[];
  runUpdates: Record<string, unknown>[];
  queueUpdates: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
};

/**
 * Records what settleRun writes instead of writing it. settleRun only inserts,
 * updates and appends, so a stub keeps this a unit test — AGENTS.md forbids
 * unit tests that need Postgres.
 */
function stubDb(captured: Captured, options: { claimHeld?: boolean } = {}) {
  const claimHeld = options.claimHeld ?? true;

  const tx = {
    update: (table: { [k: string]: unknown }) => ({
      set: (values: Record<string, unknown>) => {
        const isQueue = String(table).includes("runQueue") || "state" in values;
        return {
          where: () => {
            const sink = isQueue ? captured.queueUpdates : captured.runUpdates;
            sink.push(values);
            return {
              returning: () => Promise.resolve(claimHeld ? [{ runId: "run_x" }] : []),
            };
          },
        };
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown> | { type: string; payload: unknown }[]) => {
        // appendEvents passes an array and awaits it; the artifact upsert passes
        // one row and chains onConflictDoUpdate.
        if (Array.isArray(row)) {
          for (const event of row) captured.appended.push(event as unknown as RunEventInput);
          return Promise.resolve();
        }
        return {
          onConflictDoUpdate: () => {
            captured.artifacts.push(row);
            return Promise.resolve();
          },
        };
      },
    }),
  };

  return {
    // appendEvents opens its own select/insert against the same client.
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ max: 0 }]) }) }),
    insert: () => ({
      values: (rows: { type: string; payload: unknown }[]) => {
        for (const row of rows) captured.appended.push(row as unknown as RunEventInput);
        return Promise.resolve();
      },
    }),
    transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  } as unknown as Db;
}

function capture(): Captured {
  return { appended: [], runUpdates: [], queueUpdates: [], artifacts: [] };
}

function workdirWith(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "polymetis-settle-"));
  if (content !== undefined) writeFileSync(join(dir, deliverable.filename), content);
  return dir;
}

const base = (over: Partial<SettleInput> = {}): SettleInput => ({
  runId: "run_x",
  workerId: "worker-a",
  workdir: workdirWith("# spec\n"),
  deliverable,
  status: "succeeded",
  totals: { ...noUsage, inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
  lastSeq: 7,
  ...over,
});

describe("settleRun", () => {
  test("stores the deliverable the template contracted for", async () => {
    const c = capture();
    const result = await settleRun(stubDb(c), base());

    expect(result.settled).toBe(true);
    expect(c.artifacts).toHaveLength(1);
    expect(c.artifacts[0]).toMatchObject({
      path: "SPEC.md",
      mime: "text/markdown",
      bytes: 7,
      content: "# spec\n",
    });
  });

  test("folds the totals onto the run row", async () => {
    const c = capture();
    await settleRun(stubDb(c), base());

    expect(c.runUpdates[0]).toMatchObject({
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: "0.250000",
      error: null,
    });
  });

  test("a success that wrote no deliverable is not a success", async () => {
    // The deliverable is the entire output of a run. Reporting success without
    // it would put an empty replay in the gallery.
    const c = capture();
    await settleRun(stubDb(c), base({ workdir: workdirWith(undefined) }));

    expect(c.runUpdates[0]).toMatchObject({ status: "failed" });
    expect(String(c.runUpdates[0]!.error)).toContain("no SPEC.md was written");
    expect(c.queueUpdates[0]).toMatchObject({ state: "failed" });
    expect(c.artifacts).toHaveLength(0);
  });

  test("a failed run keeps its status and stores whatever it did write", async () => {
    const c = capture();
    await settleRun(stubDb(c), base({ status: "timed_out" }));

    expect(c.runUpdates[0]).toMatchObject({ status: "timed_out" });
    expect(c.artifacts).toHaveLength(1);
  });

  test("records that the token ceiling cut the run off", async () => {
    const c = capture();
    await settleRun(stubDb(c), base({ status: "failed", tripped: true }));

    expect(String(c.runUpdates[0]!.error)).toContain("ceiling");
  });

  test("writes nothing when the claim was lost to the reaper", async () => {
    // Another worker owns this run now. Two workers writing terminal facts for
    // one run is how a replay ends up describing neither attempt.
    const c = capture();
    const result = await settleRun(stubDb(c, { claimHeld: false }), base());

    expect(result.settled).toBe(false);
    expect(c.runUpdates).toHaveLength(0);
    expect(c.artifacts).toHaveLength(0);
  });

  test("appends no usage event when the claim was lost", async () => {
    // The append is permanent. A worker whose claim was reaped writing one
    // means the next attempt's usage folds on top of it, and every reader of
    // foldUsage double counts that run's tokens for good.
    const c = capture();
    const result = await settleRun(
      stubDb(c, { claimHeld: false }),
      base({
        status: "timed_out",
        totals: { ...noUsage },
        observed: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2_000_000,
          cacheCreationTokens: 0,
        },
      }),
    );

    expect(c.appended).toHaveLength(0);
    expect(result.settled).toBe(false);
  });

  describe("a deliverable that is not what it claims to be", () => {
    test("a symlinked deliverable is not read", async () => {
      // The agent has write access to the workdir, so it can replace the
      // deliverable with a link to anything the worker can read — and the
      // content would land in a replay built to be shared.
      const dir = workdirWith(undefined);
      const secret = join(mkdtempSync(join(tmpdir(), "polymetis-secret-")), "host.txt");
      writeFileSync(secret, "SECRET-HOST-FILE");
      symlinkSync(secret, join(dir, deliverable.filename));

      const c = capture();
      await settleRun(stubDb(c), base({ workdir: dir }));

      expect(c.artifacts).toHaveLength(0);
      expect(String(c.runUpdates[0]!.error)).toContain("no SPEC.md was written");
    });

    test("a deliverable behind a symlinked directory is not read", async () => {
      // The file itself is a regular file; the escape is one level up.
      const outside = mkdtempSync(join(tmpdir(), "polymetis-outside-"));
      writeFileSync(join(outside, "SPEC.md"), "# not ours\n");
      const dir = workdirWith(undefined);
      symlinkSync(outside, join(dir, "nested"));

      const c = capture();
      await settleRun(
        stubDb(c),
        base({ workdir: dir, deliverable: { ...deliverable, filename: "nested/SPEC.md" } }),
      );

      expect(c.artifacts).toHaveLength(0);
    });

    test("an oversized deliverable is recorded but never read into memory", async () => {
      const dir = workdirWith(undefined);
      // Sparse: the point is the reported size, not writing a real 20 MB file.
      const fd = openSync(join(dir, deliverable.filename), "w");
      ftruncateSync(fd, MAX_READ_ARTIFACT_BYTES + 1);
      closeSync(fd);

      const c = capture();
      await settleRun(stubDb(c), base({ workdir: dir }));

      expect(c.artifacts[0]).toMatchObject({
        bytes: MAX_READ_ARTIFACT_BYTES + 1,
        // Not stored inline, and not loaded to find that out.
        content: null,
      });
      expect(String(c.runUpdates[0]!.error)).toContain("not stored inline");
    });
  });

  test("does not read a deliverable from outside the workdir", async () => {
    // The filename comes from the template version, so a template naming a
    // path outside the workdir would have the worker read it and store it in a
    // publicly shareable replay.
    const c = capture();
    const dir = workdirWith("# spec\n");
    writeFileSync(join(dir, "..", "escaped.md"), "secret");

    await settleRun(
      stubDb(c),
      base({
        workdir: dir,
        deliverable: { ...deliverable, filename: "../escaped.md" },
      }),
    );

    expect(c.artifacts).toHaveLength(0);
  });

  describe("a run that ended before the SDK reported usage", () => {
    const observed = {
      inputTokens: 1_200,
      outputTokens: 800,
      cacheReadTokens: 2_000_000,
      cacheCreationTokens: 0,
    };

    test("takes the proxy's counts rather than recording zero", async () => {
      const c = capture();
      const result = await settleRun(
        stubDb(c),
        base({ status: "timed_out", totals: { ...noUsage }, observed }),
      );

      const usage = c.appended.find((e) => e.type === "usage");
      expect(usage?.type === "usage" && usage.payload).toMatchObject({
        model: OBSERVED_MODEL,
        inputTokens: 1_200,
        cacheReadTokens: 2_000_000,
        // The proxy counts bytes, not prices. Cost is understated, on purpose.
        costUsd: 0,
      });
      expect(result.totals.cacheReadTokens).toBe(2_000_000);
      expect(c.runUpdates[0]).toMatchObject({ cacheReadTokens: 2_000_000 });
    });

    test("does not double count when the SDK did report usage", async () => {
      const c = capture();
      const result = await settleRun(
        stubDb(c),
        base({ totals: { ...noUsage, inputTokens: 10, costUsd: 0.25 }, observed }),
      );

      expect(c.appended.filter((e) => e.type === "usage")).toHaveLength(0);
      expect(result.totals.inputTokens).toBe(10);
    });

    test("appends nothing when there was no proxy to observe", async () => {
      // SANDBOX_MODE=none has no proxy, so there is no second source of truth.
      const c = capture();
      await settleRun(
        stubDb(c),
        base({ status: "timed_out", totals: { ...noUsage }, observed: null }),
      );

      expect(c.appended).toHaveLength(0);
    });
  });
});
