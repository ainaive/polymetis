import { describe, expect, test } from "bun:test";

import { envSchema } from "./env";

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
