import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Prepares the checkout a run works in.
 *
 * The clone happens on the host and the result is bind-mounted (ADR-0002): the
 * container never sees a git remote, so it never sees a credential-bearing one
 * either. Everything the agent can reach is what git wrote here.
 */

export type RepoSource =
  | { kind: "clone"; url: string }
  | { kind: "local"; path: string };

export type PreparedWorkdir = {
  path: string;
  /** Removes the tree, unless it is a developer's own checkout. */
  release: () => void;
};

/** Where cloned checkouts live. Per-run subdirectories, removed on settle. */
export const WORKDIR_ROOT = join(tmpdir(), "polymetis-workdirs");

/**
 * Decide what a run's `repo` input refers to, and refuse what we will not fetch.
 *
 * v1 clones public repositories only. Private access needs the user's stored
 * GitHub token, which ADR-0002 deliberately makes a separate consented step, so
 * there is no code path here that could quietly use an ambient credential.
 */
export function classifyRepoSource(repo: string): RepoSource {
  const trimmed = repo.trim();
  if (trimmed === "") {
    throw new Error("repo is empty");
  }

  // A local path is the development affordance: point a run at a checkout you
  // already have, exactly as scripts/run-once.ts has always worked.
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return { kind: "local", path: resolve(trimmed) };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `repo must be an https:// URL or an absolute path, got: ${trimmed}`,
    );
  }

  if (url.protocol !== "https:") {
    // ssh:// and git:// would use the host's keys, and file:// would escape the
    // "nothing but what we fetched" property the bind mount depends on.
    throw new Error(`repo must use https, got ${url.protocol}//`);
  }
  if (url.username || url.password) {
    // A credential in the URL would be written into the clone's remote config
    // and then bind-mounted into the sandbox — the exact thing ADR-0002 forbids.
    throw new Error("repo URL must not embed credentials");
  }

  // The worker runs inside the trust boundary, so an unrestricted host is
  // server-side request forgery through the queue: a run input naming
  // 169.254.169.254 or an address on the private network makes the worker
  // reach it, and whatever comes back lands in a workdir that a replay may
  // publish. Refuse the addresses that only mean "inside".
  if (isForbiddenHost(url.hostname)) {
    throw new Error(`repo host is not reachable from a run: ${url.hostname}`);
  }

  return { kind: "clone", url: url.toString() };
}

/**
 * True for hosts that only ever name something inside our own network.
 *
 * Literals only. A name that *resolves* to a private address still gets
 * through, and closing that needs a resolve-then-pin step that git does not
 * expose — worth doing when repositories become user-supplied in M3b, where
 * this guard is the wrong layer anyway. Today the only caller is an operator
 * running a script.
 */
export function isForbiddenHost(hostname: string): boolean {
  // Lowercased, brackets off an IPv6 literal, and a trailing dot removed — the
  // resolver treats "localhost." as "localhost", so a string comparison must
  // too or the dot walks straight past every name rule below.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  // The cloud metadata endpoints, which hand out credentials to anyone who asks.
  if (host === "169.254.169.254" || host === "metadata.google.internal") return true;
  // IPv6 loopback, link-local (fe80::/10) and unique-local (fc00::/7).
  if (/^(::1|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/.test(host)) return true;

  const v4 = (unmapV4(host) ?? host).match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, including metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

/**
 * The dotted quad inside an IPv4-mapped IPv6 literal, or null. Such a literal
 * names the same endpoint as its embedded v4 address, so it has to be judged
 * as that address. The WHATWG parser renders the mapping in hex
 * (`::ffff:7f00:1`); the dotted form arrives when a caller passes a raw string.
 */
function unmapV4(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The `git clone` argv. Pure, so the hardening stays asserted in CI rather than
 * discovered missing the first time a run points at a hostile repository.
 */
export function buildCloneArgs(url: string, dest: string): string[] {
  return [
    // A repository is untrusted input. None of these are defaults.
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "core.symlinks=false",
    "clone",
    // History is not part of the contract, and a deep clone is most of the
    // wall-clock cost of starting a run.
    "--depth",
    "1",
    "--no-tags",
    "--single-branch",
    "--",
    url,
    dest,
  ];
}

/**
 * Environment for the clone: enough to run git, and nothing that could
 * authenticate.
 *
 * The host's git config may install a credential helper. Inheriting it would
 * let a run reach a private repository using the operator's credentials and
 * then bind-mount the result into a sandbox running untrusted content — a
 * private repo must fail here, loudly, rather than succeed quietly.
 */
export type CloneEnv = Record<string, string | undefined>;

export function cloneEnv(base: CloneEnv = process.env, token?: string): CloneEnv {
  const env: CloneEnv = {
    PATH: base.PATH,
    // No global or system config, so no credential.helper and no insteadOf.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // Fail instead of blocking a worker forever on a password prompt.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };

  if (!token) return env;

  // The token goes in a header, through the environment (ADR-0004).
  //
  // Not in the URL: git writes remote.origin.url into .git/config, and that
  // directory is bind-mounted into the sandbox — a credential there is exactly
  // what ADR-0002 forbids. Not on the command line either: argv is readable
  // through `ps` by every user on the host, which is the same reason the
  // container's environment goes through a file rather than -e.
  //
  // GIT_CONFIG_COUNT applies these as if they were -c, without persisting them.
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "http.extraheader";
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(
    `x-access-token:${token}`,
  ).toString("base64")}`;
  // git follows the initial redirect by default, and an extraheader set this
  // way would be sent to wherever it lands. The host check above decides where
  // the credential may go; a redirect must not be able to overrule it.
  env.GIT_CONFIG_KEY_1 = "http.followRedirects";
  env.GIT_CONFIG_VALUE_1 = "false";

  return env;
}

export async function prepareWorkdir(options: {
  runId: string;
  repo: string;
  root?: string;
  timeoutMs?: number;
  /** Installation token for a private repository. Never persisted (ADR-0004). */
  token?: string;
}): Promise<PreparedWorkdir> {
  const source = classifyRepoSource(options.repo);

  if (source.kind === "local") {
    // Never a temp copy, and never removed: this is the developer's own
    // checkout, and a settle step that deleted it would be unforgivable.
    if (!isDirectory(source.path)) {
      throw new Error(`repo path is not a directory: ${source.path}`);
    }
    return { path: source.path, release: () => {} };
  }

  return cloneInto(source.url, {
    runId: options.runId,
    root: options.root ?? WORKDIR_ROOT,
    timeoutMs: options.timeoutMs,
    token: options.token,
  });
}

/**
 * Clone `url` into a fresh per-run directory. The mechanism, with no opinion
 * about which URLs are acceptable — `classifyRepoSource` holds that, and holds
 * it in one place so it cannot be half-enforced here as well.
 */
export async function cloneInto(
  url: string,
  options: { runId: string; root: string; timeoutMs?: number; token?: string },
): Promise<PreparedWorkdir> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  // mkdtemp rather than the run id: a retry of the same run must not collide
  // with a directory the previous attempt is still holding.
  const dir = mkdtempSync(join(options.root, `${options.runId}-`));
  const dest = join(dir, "repo");

  try {
    await runGit(
      buildCloneArgs(url, dest),
      options.timeoutMs ?? 300_000,
      options.token,
    );
  } catch (error) {
    // A half-written clone is not something to leave in tmp for a human to
    // find; the run is going to fail either way.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: dest,
    release: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function runGit(args: string[], timeoutMs: number, token?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      env: cloneEnv(process.env, token) as NodeJS.ProcessEnv,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: timeoutMs,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: a clone that fails in a loop should not be able to grow the
      // worker's heap with its own error output.
      if (stderr.length < 4_000) stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(
        new Error(
          // Redacted: git echoes the header it was given on some failures, and
          // this message is stored on the run row and shown in the UI.
          `git clone failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${redact(stderr.trim(), token) || "no output"}`,
        ),
      );
    });
  });
}


/**
 * Remove a credential from text that is about to be stored or displayed.
 *
 * The raw token is not what git sees. cloneEnv sends
 * `Authorization: Basic base64("x-access-token:" + token)`, so a stderr line
 * echoing the header it was given contains the encoded form — which is
 * reversible, and this message ends up on the run row and in the UI. Redacting
 * only the raw token left the credential in plain sight.
 */
function redact(text: string, token?: string): string {
  if (!token) return text;
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("[redacted]").split(encoded).join("[redacted]");
}
