import { z } from "zod";

/**
 * Every environment variable the app and the worker read, validated in one
 * place. Optional groups (GitHub OAuth, Anthropic, object storage) degrade
 * gracefully — the feature is disabled when its variables are absent, so a
 * partial .env still boots. That matters here because M1 builds the gallery
 * and replay player against seeded fixtures with no runtime credentials at all.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().optional(),
  // Connection pool, per process. postgres-js throws on fractional or
  // negative pool sizes — reject at parse rather than at first query.
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().int().nonnegative().default(20),

  // better-auth
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().optional(),

  // GitHub OAuth — the primary sign-in provider, and the source of the repo
  // read scope the agent runs against. Absent means sign-in falls back to
  // email/password only (M3).
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  // Agent runtime (M2). Absent means runs cannot be executed; the gallery and
  // replay of already-recorded runs still work, because replay reads our own
  // event log rather than calling any model.
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-opus-5"),
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("xhigh"),
  // Accounting ceiling, used for quota. The authoritative per-run cost comes
  // from the SDK, so this is a budget rather than an enforcement point.
  RUN_COST_CEILING_USD: z.coerce.number().positive().default(5),
  // The circuit breaker the egress proxy actually enforces. Tokens rather than
  // dollars on purpose: the proxy observes tokens exactly, whereas converting
  // to dollars would need a pricing table duplicated from the SDK and free to
  // drift. 0 disables it.
  // Calibrated against a measured run: issue-to-spec over a 131-file
  // repository consumed 3.54M tokens, almost all cache traffic. A 2M ceiling
  // would have killed it around 60% through, so the default leaves real
  // headroom — a breaker that trips on healthy runs teaches people to raise it
  // without looking, which is worse than not having one.
  RUN_TOKEN_CEILING: z.coerce.number().int().nonnegative().default(8_000_000),
  // Wall-clock ceiling per run, enforced by the sandbox supervisor.
  RUN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),

  // Sandbox (ADR-0003). `none` runs the agent directly on the host, which is
  // how the driver is developed before a container runtime exists; production
  // refuses it below.
  SANDBOX_MODE: z.enum(["docker", "none"]).default("none"),
  SANDBOX_IMAGE: z.string().default("polymetis/sandbox:0.3.222"),
  SANDBOX_NETWORK: z.string().default("polymetis-sandbox"),
  SANDBOX_MEMORY: z.string().default("2g"),
  SANDBOX_CPUS: z.string().default("2"),
  /** Port the credential-injecting egress proxy listens on, host-side. */
  SANDBOX_PROXY_PORT: z.coerce.number().int().positive().default(7777),

  // Worker identity and liveness. A run whose heartbeat goes stale for longer
  // than the reaper's threshold is requeued (see ADR-0001).
  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
});

/** Exported for tests: parse a controlled input instead of process.env. */
export const envSchema = schema;

const DEV_FALLBACK_SECRET = "dev-secret-change-me";
const DEV_FALLBACK_DB = "postgres://polymetis:polymetis@localhost:5432/polymetis";

export type Env = Omit<
  z.infer<typeof schema>,
  "BETTER_AUTH_SECRET" | "DATABASE_URL"
> & {
  BETTER_AUTH_SECRET: string;
  DATABASE_URL: string;
};

const parsed = schema.parse(process.env);

// Production must not run on dev fallbacks: a guessable auth secret lets
// anyone forge a session, and a defaulted DATABASE_URL points at nothing real.
// Enforced at runtime, not during `next build` — build machines have no
// secrets and need none.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
if (parsed.NODE_ENV === "production" && !isBuildPhase) {
  // 32 is better-auth's own minimum: below it, it logs a low-entropy warning
  // that is easy to miss in deploy logs. Fail the boot instead.
  if (
    !parsed.BETTER_AUTH_SECRET ||
    parsed.BETTER_AUTH_SECRET === DEV_FALLBACK_SECRET ||
    parsed.BETTER_AUTH_SECRET.length < 32
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set to a strong value in production — generate one with: openssl rand -base64 32",
    );
  }
  if (!parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set explicitly in production");
  }
  // SANDBOX_MODE=none runs a model-driven agent over untrusted repository
  // content directly on the host, with the worker's own filesystem and network.
  // It exists so the driver can be developed before a container runtime is
  // available (ADR-0003); in production it is the whole threat model deleted.
  if (parsed.SANDBOX_MODE === "none") {
    throw new Error(
      "SANDBOX_MODE=none runs the agent unsandboxed on the host and must never be used in production — set SANDBOX_MODE=docker",
    );
  }
}

export const env: Env = {
  ...parsed,
  BETTER_AUTH_SECRET: parsed.BETTER_AUTH_SECRET ?? DEV_FALLBACK_SECRET,
  DATABASE_URL: parsed.DATABASE_URL ?? DEV_FALLBACK_DB,
};

/** Whether a real agent run can be executed in this process. */
export const canExecuteRuns = Boolean(parsed.ANTHROPIC_API_KEY);

/** Whether GitHub sign-in and repo access are configured. */
export const githubConfigured = Boolean(
  parsed.GITHUB_CLIENT_ID && parsed.GITHUB_CLIENT_SECRET,
);
