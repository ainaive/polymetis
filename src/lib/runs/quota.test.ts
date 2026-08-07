import { describe, expect, test } from "bun:test";

import { checkQuota } from "./quota";

const base = {
  usedTokens: 0,
  allowanceTokens: 20_000_000,
  inFlight: 0,
  maxConcurrent: 3,
};

describe("checkQuota", () => {
  test("allows a workspace inside both limits", () => {
    expect(checkQuota({ ...base, usedTokens: 1_000_000 })).toEqual({ allowed: true });
  });

  test("refuses once the allowance is spent", () => {
    expect(checkQuota({ ...base, usedTokens: 20_000_000 })).toEqual({
      allowed: false,
      reason: "allowance",
    });
  });

  test("refuses past the allowance, not merely at it", () => {
    expect(checkQuota({ ...base, usedTokens: 25_000_000 }).allowed).toBe(false);
  });

  test("treats a zero allowance as unmetered, like RUN_TOKEN_CEILING does", () => {
    expect(
      checkQuota({ ...base, allowanceTokens: 0, usedTokens: 999_000_000 }),
    ).toEqual({ allowed: true });
  });

  test("refuses a workspace already at its concurrency cap", () => {
    expect(checkQuota({ ...base, inFlight: 3 })).toEqual({
      allowed: false,
      reason: "concurrency",
    });
  });

  test("caps concurrency before the allowance is anywhere near spent", () => {
    // The case the token allowance alone cannot see: usage is summed from
    // settled runs, so twenty runs started at once have spent nothing yet by
    // that measure while spending plenty in reality.
    const decision = checkQuota({ ...base, usedTokens: 0, inFlight: 20 });
    expect(decision).toEqual({ allowed: false, reason: "concurrency" });
  });

  test("reports concurrency first when both limits are hit", () => {
    // Arbitrary but fixed: the message a person sees should tell them to wait
    // for a run to finish, which is actionable, rather than that their month
    // is over, which is not.
    expect(
      checkQuota({ ...base, usedTokens: 99_000_000, inFlight: 3 }),
    ).toEqual({ allowed: false, reason: "concurrency" });
  });
});
