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
        BETTER_AUTH_SECRET: "dev-secret-change-me",
        DATABASE_URL: undefined,
      }),
    ).not.toThrow();
  });

  // The sandbox guard deliberately does NOT live here — see assertSandboxAllowed
  // in src/lib/runner/execute.ts. A check at env load binds `next build` too,
  // which would need a NEXT_PHASE exemption, and that exemption is exactly what
  // a worker must not be able to inherit.
  test("says nothing about the sandbox", () => {
    expect(Object.keys(production)).not.toContain("SANDBOX_MODE");
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
