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

  // The GitHub App used for repository access (ADR-0002 chose it over classic
  // OAuth scopes, which grant write to every private repo). Separate from the
  // sign-in provider above: signing in and granting repository access are two
  // consented steps, and one must not imply the other.
  GITHUB_APP_ID: z.string().optional(),
  /** The App's URL slug, for building its installation link. */
  GITHUB_APP_SLUG: z.string().optional(),
  /** PEM from the App's settings. Escaped newlines are normalized on use. */
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  /**
   * The App's OAuth client, used during installation to prove the person
   * connecting can administer the installation they named. Without it the
   * callback cannot tell connecting an account from taking one over, so the App
   * counts as unconfigured rather than partly working.
   */
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),

  // Agent runtime (M2). Absent means runs cannot be executed; the gallery and
  // replay of already-recorded runs still work, because replay reads our own
  // event log rather than calling any model.
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-opus-5"),
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("xhigh"),
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
  // Runs a workspace may have queued or running at once. The token allowance
  // is summed from settled runs, so it cannot see work still in flight; this is
  // what stops a workspace starting twenty at once and blowing past the month.
  WORKSPACE_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),

  /**
   * How long a private run keeps its event log and artifacts.
   *
   * Demo, public and unlisted runs are never purged — the gallery and any link
   * someone has shared must keep working. 0 disables retention entirely.
   */
  RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),

  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
});

/** Exported for tests: parse a controlled input instead of process.env. */
export const envSchema = schema;

/** Exported for tests: the value the production guard must refuse. */
export const DEV_FALLBACK_SECRET = "dev-secret-change-me";
const DEV_FALLBACK_DB = "postgres://polymetis:polymetis@localhost:5432/polymetis";

export type Env = Omit<
  z.infer<typeof schema>,
  "BETTER_AUTH_SECRET" | "DATABASE_URL"
> & {
  BETTER_AUTH_SECRET: string;
  DATABASE_URL: string;
};

/**
 * Refuse to boot on a configuration that is only safe in development.
 *
 * Exported and pure so it can be tested. As an inline block at module scope it
 * ran once at import and nothing could reach it.
 *
 * This covers the credential fallbacks only. `SANDBOX_MODE=none` is not checked
 * here: every process that imports `env` would have to satisfy it, including
 * `next build`, which evaluates server modules with NODE_ENV=production and no
 * sandbox configured. Exempting the build means keying on `NEXT_PHASE` — a
 * Next.js-owned variable a worker never sets deliberately — so a stale value in
 * a shared env file or a base image would switch the guard off in the one
 * process that matters.
 *
 * The sandbox refusal lives in `src/lib/runner/execute.ts` instead, at the only
 * place the unsandboxed path is actually taken. Nothing reaches it that is not
 * about to run an agent, so it needs no exemption and has none.
 */
export function assertProductionSafe(
  parsed: Pick<z.infer<typeof schema>, "NODE_ENV" | "BETTER_AUTH_SECRET" | "DATABASE_URL">,
  options: { isBuildPhase: boolean },
): void {
  if (parsed.NODE_ENV !== "production") return;

  // Production must not run on dev fallbacks: a guessable auth secret lets
  // anyone forge a session, and a defaulted DATABASE_URL points at nothing real.
  // Build machines have neither and need neither.
  if (options.isBuildPhase) return;

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
}

const parsed = schema.parse(process.env);

assertProductionSafe(parsed, {
  isBuildPhase: process.env.NEXT_PHASE === "phase-production-build",
});

export const env: Env = {
  ...parsed,
  BETTER_AUTH_SECRET: parsed.BETTER_AUTH_SECRET ?? DEV_FALLBACK_SECRET,
  DATABASE_URL: parsed.DATABASE_URL ?? DEV_FALLBACK_DB,
};

/** Whether a real agent run can be executed in this process. */
export const canExecuteRuns = Boolean(parsed.ANTHROPIC_API_KEY);

/** Whether GitHub sign-in is configured. Sign-in scopes only (ADR-0002). */
export const githubConfigured = Boolean(
  parsed.GITHUB_CLIENT_ID && parsed.GITHUB_CLIENT_SECRET,
);

/**
 * Whether the GitHub App is configured, which is what grants repository access.
 *
 * Separate from sign-in on purpose: an install requires all three of these, and
 * a half-configured App fails at the point of use with an error about a missing
 * key rather than being absent from the UI in the first place.
 */
export const githubAppConfigured = Boolean(
  parsed.GITHUB_APP_ID &&
    parsed.GITHUB_APP_SLUG &&
    parsed.GITHUB_APP_PRIVATE_KEY &&
    parsed.GITHUB_APP_CLIENT_ID &&
    parsed.GITHUB_APP_CLIENT_SECRET,
);

/**
 * The App's credentials, or a refusal that names what is missing.
 *
 * Throwing here rather than returning undefined means a code path that needs
 * the App cannot quietly continue without it.
 */
export function requireGithubApp(): {
  appId: string;
  privateKey: string;
  slug: string;
  clientId: string;
  clientSecret: string;
} {
  const missing = (
    [
      ["GITHUB_APP_ID", parsed.GITHUB_APP_ID],
      ["GITHUB_APP_SLUG", parsed.GITHUB_APP_SLUG],
      ["GITHUB_APP_PRIVATE_KEY", parsed.GITHUB_APP_PRIVATE_KEY],
      ["GITHUB_APP_CLIENT_ID", parsed.GITHUB_APP_CLIENT_ID],
      ["GITHUB_APP_CLIENT_SECRET", parsed.GITHUB_APP_CLIENT_SECRET],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `GitHub App is not configured: set ${missing.join(", ")}. Register an App with contents:read and metadata:read, enable "Request user authorization (OAuth) during installation", then copy its id, slug, private key and OAuth client credentials.`,
    );
  }

  return {
    appId: parsed.GITHUB_APP_ID!,
    slug: parsed.GITHUB_APP_SLUG!,
    privateKey: parsed.GITHUB_APP_PRIVATE_KEY!,
    clientId: parsed.GITHUB_APP_CLIENT_ID!,
    clientSecret: parsed.GITHUB_APP_CLIENT_SECRET!,
  };
}
