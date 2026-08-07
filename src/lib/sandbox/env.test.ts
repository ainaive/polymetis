import { describe, expect, test } from "bun:test";

import { buildSandboxEnv, isCredentialBearingValue, isDeniedEnvVar } from "./env";

const build = (sdkEnv: Record<string, string | undefined>) =>
  buildSandboxEnv({
    sdkEnv,
    baseUrl: "http://proxy.internal:7777",
    placeholderToken: "sk-placeholder",
  });

describe("isDeniedEnvVar", () => {
  test("blocks the Anthropic credential in every form it takes", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(isDeniedEnvVar(name), name).toBe(true);
    }
  });

  test("blocks whole credential families by prefix", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(isDeniedEnvVar(name), name).toBe(true);
    }
  });

  test("blocks anything secret-shaped, including names we have never seen", () => {
    // The point of the suffix rule: a credential added to the worker next year
    // should be excluded by default rather than inherited because nobody
    // updated a list.
    for (const name of [
      "STRIPE_SECRET",
      "SOME_FUTURE_API_KEY",
      "SMTP_PASSWORD",
      "REGISTRY_CREDENTIALS",
    ]) {
      expect(isDeniedEnvVar(name), name).toBe(true);
    }
  });

  test("blocks the database URL — a run must not reach our own tables", () => {
    expect(isDeniedEnvVar("DATABASE_URL")).toBe(true);
  });

  test("blocks credentials whose names predate the suffix conventions", () => {
    // No leading underscore for the suffix rule to find — these have to be
    // enumerated exactly (issue #10).
    for (const name of ["PGPASSWORD", "PGSSLKEY", "MYSQL_PWD", "REDISCLI_AUTH"]) {
      expect(isDeniedEnvVar(name), name).toBe(true);
    }
  });

  test("is case-insensitive", () => {
    expect(isDeniedEnvVar("github_token")).toBe(true);
  });

  test("allows the ordinary variables a process needs", () => {
    for (const name of ["PATH", "HOME", "LANG", "TMPDIR", "TERM"]) {
      expect(isDeniedEnvVar(name), name).toBe(false);
    }
  });

  test("allows SDK control-protocol variables it did not invent", () => {
    // The filter is subtractive precisely so these survive without us having
    // to enumerate the SDK's internals.
    for (const name of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) {
      expect(isDeniedEnvVar(name), name).toBe(false);
    }
  });
});

describe("isCredentialBearingValue", () => {
  test("catches a URL that embeds a credential, whatever its name", () => {
    for (const value of [
      "postgres://polymetis:s3cret@db.internal:5432/polymetis",
      "redis://:p4ss@cache.internal:6379",
      "https://alice:hunter2@registry.example.com",
    ]) {
      expect(isCredentialBearingValue(value), value).toBe(true);
    }
  });

  test("allows plain endpoints and non-URL values", () => {
    for (const value of [
      "https://api.example.com/v1",
      "/usr/bin:/bin",
      "C.UTF-8",
      "xterm-256color",
    ]) {
      expect(isCredentialBearingValue(value), value).toBe(false);
    }
  });
});

describe("buildSandboxEnv", () => {
  test("a URL-embedded credential is dropped even under a harmless name", () => {
    // REDIS_URL matches no name rule; the value is what gives it away.
    const env = build({
      REDIS_URL: "redis://:p4ss@cache.internal:6379",
      API_ENDPOINT: "https://api.example.com/v1",
      PATH: "/usr/bin",
    });
    expect("REDIS_URL" in env).toBe(false);
    expect(env.API_ENDPOINT).toBe("https://api.example.com/v1");
  });
  test("a host credential in the SDK env does not reach the sandbox", () => {
    // This is the ADR-0002 guarantee, stated as a test.
    const env = build({
      ANTHROPIC_API_KEY: "sk-ant-real-secret",
      GITHUB_TOKEN: "ghp_real_secret",
      PATH: "/usr/bin",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ant-real-secret");
    expect(Object.values(env)).not.toContain("ghp_real_secret");
  });

  test("points the agent at the proxy with a placeholder credential", () => {
    const env = build({ PATH: "/usr/bin" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy.internal:7777");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-placeholder");
  });

  test("injected values win over anything that survived the filter", () => {
    // ANTHROPIC_BASE_URL is denied on the way in, but the ordering also has to
    // hold if the deny list ever changes.
    const env = build({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy.internal:7777");
  });

  test("keeps the ordinary environment the process needs to run", () => {
    const env = build({ PATH: "/usr/bin:/bin", HOME: "/home/agent", LANG: "C.UTF-8" });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.LANG).toBe("C.UTF-8");
  });

  test("drops undefined values rather than passing the string 'undefined'", () => {
    const env = build({ PATH: "/usr/bin", EMPTY: undefined });
    expect("EMPTY" in env).toBe(false);
  });

  test("the whole real process environment can be passed without leaking", () => {
    // The realistic call site: the SDK derives its env from process.env.
    const env = buildSandboxEnv({
      sdkEnv: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-leaked" },
      baseUrl: "http://proxy:1",
      placeholderToken: "placeholder",
    });

    // The two we inject are denied on the way in and set on the way out, so
    // they are the only denied names allowed to appear — and they must hold
    // our values, never an inherited one.
    const injected = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy:1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("placeholder");

    for (const [name, value] of Object.entries(env)) {
      if (injected.has(name)) continue;
      expect(isDeniedEnvVar(name), `${name} survived the filter`).toBe(false);
      expect(value).not.toBe("sk-ant-leaked");
    }
  });
});
