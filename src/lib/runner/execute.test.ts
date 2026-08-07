import { describe, expect, test } from "bun:test";

import { assertSandboxAllowed } from "./execute";

/**
 * The guard between `SANDBOX_MODE=none` and production (ADR-0003).
 *
 * It sits here rather than in env.ts because a load-time check binds every
 * process that imports `env` — including `next build`, which evaluates server
 * modules with NODE_ENV=production and no sandbox configured. Exempting the
 * build means trusting NEXT_PHASE, and a worker that inherited a stale value
 * would then run an agent unsandboxed over untrusted repository content.
 */
describe("assertSandboxAllowed", () => {
  test("docker is allowed everywhere", () => {
    expect(() => assertSandboxAllowed("docker", "production")).not.toThrow();
    expect(() => assertSandboxAllowed("docker", "development")).not.toThrow();
    expect(() => assertSandboxAllowed("docker", "test")).not.toThrow();
  });

  test("none is allowed outside production, which is why it can be the default", () => {
    expect(() => assertSandboxAllowed("none", "development")).not.toThrow();
    expect(() => assertSandboxAllowed("none", "test")).not.toThrow();
  });

  test("none is refused in production", () => {
    expect(() => assertSandboxAllowed("none", "production")).toThrow(/unsandboxed/);
  });

  // The regression that moved this check out of env.ts. There is no build-phase
  // parameter to pass, and that is the point: no caller can opt out of it.
  test("takes no exemption of any kind", () => {
    expect(assertSandboxAllowed.length).toBe(2);
  });
});
