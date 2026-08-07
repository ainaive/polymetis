import { describe, expect, test } from "bun:test";

import { assertProductionSafe, envSchema } from "./env";

describe("envSchema", () => {
  test("boots from an empty environment so M1 can run on fixtures alone", () => {
    const parsed = envSchema.parse({});
    expect(parsed.NODE_ENV).toBe("development");
    expect(parsed.DATABASE_URL).toBeUndefined();
    expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("applies agent defaults matching the plan", () => {
    const parsed = envSchema.parse({});
    expect(parsed.AGENT_MODEL).toBe("claude-opus-5");
    expect(parsed.AGENT_EFFORT).toBe("xhigh");
  });

  test("coerces numeric pool and ceiling settings from strings", () => {
    const parsed = envSchema.parse({
      DB_POOL_MAX: "25",
      RUN_TIMEOUT_SECONDS: "600",
    });
    expect(parsed.DB_POOL_MAX).toBe(25);
    expect(parsed.RUN_TIMEOUT_SECONDS).toBe(600);
  });

  test("rejects a fractional pool size, which postgres-js throws on at connect", () => {
    expect(() => envSchema.parse({ DB_POOL_MAX: "2.5" })).toThrow();
  });

  test("rejects a non-positive pool size", () => {
    expect(() => envSchema.parse({ DB_POOL_MAX: "0" })).toThrow();
  });

  test("rejects an effort level the API does not accept", () => {
    expect(() => envSchema.parse({ AGENT_EFFORT: "extreme" })).toThrow();
  });

  test("defaults the sandbox to none so the driver is developable without Docker", () => {
    // Safe only because the production guard in env.ts refuses this mode;
    // that guard is what makes the default acceptable.
    expect(envSchema.parse({}).SANDBOX_MODE).toBe("none");
  });

  test("rejects a sandbox mode that is neither docker nor none", () => {
    expect(() => envSchema.parse({ SANDBOX_MODE: "vm" })).toThrow();
  });
});

describe("assertProductionSafe", () => {
  type Config = Parameters<typeof assertProductionSafe>[0];

  const production: Config = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "x".repeat(32),
    DATABASE_URL: "postgres://user:pw@db.internal:5432/polymetis",
    SANDBOX_MODE: "docker",
  };

  const check =
    (overrides: Partial<Config>, options = { isBuildPhase: false }) =>
    () =>
      assertProductionSafe({ ...production, ...overrides }, options);

  test("accepts a fully configured production environment", () => {
    expect(check({})).not.toThrow();
  });

  test("says nothing about development, whatever it holds", () => {
    expect(
      check({
        NODE_ENV: "development",
        SANDBOX_MODE: "none",
        BETTER_AUTH_SECRET: "dev-secret-change-me",
        DATABASE_URL: undefined,
      }),
    ).not.toThrow();
  });

  test("refuses SANDBOX_MODE=none in production", () => {
    expect(check({ SANDBOX_MODE: "none" })).toThrow(/unsandboxed/);
  });

  // The regression this function was extracted for. NEXT_PHASE is set by
  // Next.js, not by an operator, so a stale value in a shared env file or a
  // base image used to disable every production guard at once — including the
  // one AGENTS.md says must never be weakened.
  test("refuses SANDBOX_MODE=none even during the build phase", () => {
    expect(check({ SANDBOX_MODE: "none" }, { isBuildPhase: true })).toThrow(
      /unsandboxed/,
    );
  });

  test("refuses the dev fallback secret in production", () => {
    expect(check({ BETTER_AUTH_SECRET: "dev-secret-change-me" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  test("refuses a secret shorter than better-auth's own minimum", () => {
    expect(check({ BETTER_AUTH_SECRET: "x".repeat(31) })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  test("refuses a missing database url in production", () => {
    expect(check({ DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  // Build machines have no secrets and need none — that is the whole reason the
  // exemption exists, and it stays.
  test("allows missing credentials during the build phase", () => {
    expect(
      check(
        { BETTER_AUTH_SECRET: undefined, DATABASE_URL: undefined },
        { isBuildPhase: true },
      ),
    ).not.toThrow();
  });
});
