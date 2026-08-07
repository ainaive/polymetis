/**
 * Builds the environment handed to the agent process.
 *
 * This is the ADR-0002 boundary in code. The Agent SDK constructs its own
 * `env` for the process it would have spawned locally, derived from the
 * worker's environment — which holds the Anthropic credential, and will hold a
 * GitHub token. Forwarding that wholesale into the sandbox would put both
 * inside the blast radius of a prompt injection from repository content.
 *
 * The filter is subtractive rather than an allowlist because the SDK also puts
 * variables in there that the Claude Code process genuinely needs to speak its
 * control protocol, and those are not ours to enumerate. So: keep what the SDK
 * asked for, strip anything credential-shaped, then inject our own.
 */

/**
 * Exact names that must never reach the sandbox. The tail of the list is
 * credentials whose conventional names predate the `_SECRET`-style suffixes
 * the rules below rely on — PGPASSWORD has no underscore for a suffix rule to
 * find. Names like these have to be enumerated, so add here liberally.
 */
const DENIED_EXACT = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "BETTER_AUTH_SECRET",
  "PGPASSWORD",
  "PGSSLKEY",
  "MYSQL_PWD",
  "REDISCLI_AUTH",
]);

/** Prefixes covering whole credential families. */
const DENIED_PREFIXES = [
  "AWS_",
  "GITHUB_",
  "GH_",
  "GOOGLE_",
  "AZURE_",
  "NPM_",
  "VERCEL_",
];

/**
 * Anything that merely *looks* like a secret. Deliberately broad: a variable
 * added to the worker next year should be excluded by default rather than
 * silently inherited because nobody remembered to update a list.
 */
const DENIED_SUFFIXES = [
  "_TOKEN",
  "_KEY",
  "_SECRET",
  "_PASSWORD",
  "_CREDENTIALS",
  "_CREDENTIAL",
];

export function isDeniedEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENIED_EXACT.has(upper)) return true;
  if (DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  if (DENIED_SUFFIXES.some((suffix) => upper.endsWith(suffix))) return true;
  return false;
}

/**
 * A value that is itself a credential: a URL carrying userinfo, the shape of
 * DATABASE_URL, REDIS_URL, MONGODB_URI and their kin. Judged by value because
 * such names end in `_URL`/`_URI`/`_DSN`, which no name rule can tell apart
 * from a harmless endpoint — and the next one added will not be on any list.
 */
export function isCredentialBearingValue(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.username !== "" || url.password !== "";
}

export type SandboxEnvOptions = {
  /** The env the SDK built for a local spawn. */
  sdkEnv: Record<string, string | undefined>;
  /** Where the agent should send model traffic — our credential proxy. */
  baseUrl: string;
  /**
   * Stand-in for the real credential. The proxy replaces it at egress, so
   * exfiltrating this from the sandbox gains an attacker nothing.
   */
  placeholderToken: string;
};

export function buildSandboxEnv(
  options: SandboxEnvOptions,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(options.sdkEnv)) {
    if (value === undefined) continue;
    if (isDeniedEnvVar(name)) continue;
    if (isCredentialBearingValue(value)) continue;
    out[name] = value;
  }

  // Injected last so they cannot be overwritten by anything that survived the
  // filter.
  out.ANTHROPIC_BASE_URL = options.baseUrl;
  out.ANTHROPIC_AUTH_TOKEN = options.placeholderToken;

  return out;
}
