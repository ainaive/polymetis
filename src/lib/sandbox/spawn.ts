import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { buildSandboxEnv } from "./env";

/**
 * Supplies the Agent SDK's `spawnClaudeCodeProcess` hook (ADR-0003).
 *
 * The SDK drives the agent over stdin/stdout, so replacing the spawn is enough
 * to move every tool execution — Read, Write, Grep, and anything added later —
 * inside a container, with no bespoke driver baked into the image.
 */

export type SandboxMode = "docker" | "none";

export type SandboxConfig = {
  mode: SandboxMode;
  /** Image containing bun and a pinned copy of the agent SDK. */
  image: string;
  /** Where the agent reaches our credential proxy. */
  proxyBaseUrl: string;
  /** Stand-in credential; the proxy swaps it for the real one at egress. */
  placeholderToken: string;
  /** Host path holding the prepared checkout. */
  workdir: string;
  /** Resource ceilings. A run must not be able to take the host down. */
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /**
   * Docker network, created by `bun run sandbox:setup`.
   *
   * An ordinary bridge, not `--internal`: an internal network has no gateway,
   * and the gateway is how the container reaches the host-side proxy. Creating
   * it does not deny egress — that is a host firewall rule on the bridge
   * (ADR-0005).
   */
  network?: string;
  /** The CLI to invoke. Overridable for podman, and for testing this module. */
  dockerBinary?: string;
};

/** Where the host workdir is mounted inside the container. */
export const CONTAINER_WORKDIR = "/workspace";

const DEFAULTS = {
  memory: "2g",
  cpus: "2",
  pidsLimit: 512,
} as const;

/**
 * Build the `docker run` argv. Pure, so the hardening flags are asserted in
 * CI rather than discovered missing in production.
 */
export function buildDockerArgs(
  config: SandboxConfig,
  spawnOptions: { command: string; args: string[]; envFile: string },
): string[] {
  const args = [
    "run",
    "--rm",
    // The SDK speaks to the process over stdin/stdout.
    "-i",
    // No TTY: output must stay a clean protocol stream.
    "--user",
    "65532:65532",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    config.memory ?? DEFAULTS.memory,
    "--cpus",
    config.cpus ?? DEFAULTS.cpus,
    "--pids-limit",
    String(config.pidsLimit ?? DEFAULTS.pidsLimit),
    // Read-only rootfs still needs somewhere to write.
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "-v",
    `${config.workdir}:${CONTAINER_WORKDIR}:rw`,
    "-w",
    CONTAINER_WORKDIR,
  ];

  if (config.network) {
    args.push("--network", config.network);
  }
  // The proxy runs on the host; the container reaches it by this name.
  args.push("--add-host", "polymetis-proxy:host-gateway");

  // --env-file rather than repeated -e: argv is world-readable through `ps`,
  // and the environment carries the per-run proxy token.
  args.push("--env-file", spawnOptions.envFile);

  args.push(config.image, spawnOptions.command, ...spawnOptions.args);
  return args;
}

/**
 * Serialize the container environment to a private file.
 *
 * Docker's `--env-file` is `KEY=VALUE` per line with no quoting, so a value
 * containing a newline would inject an extra variable. Nothing we pass should
 * contain one; the guard is here because "should" is not a security property.
 */
export function formatEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`environment variable ${name} contains a newline`);
    }
    lines.push(`${name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write the container environment to a private file, and say how to remove it.
 *
 * The file outlives the container's startup — docker keeps no handle on it, but
 * removing it early races docker's own argv parsing. What protects it meanwhile
 * is 0600 inside a 0700 mkdtemp directory; what this indirection actually
 * bought is keeping the per-run token out of argv, which `ps` shows to every
 * user on the host.
 */
function writeEnvFile(env: Record<string, string>): {
  file: string;
  remove: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "polymetis-run-"));
  const file = join(dir, "env");
  writeFileSync(file, formatEnvFile(env), { mode: 0o600 });
  // Remove the directory, not just the file: one empty directory per run in
  // tmpdir is a leak that nothing else cleans up.
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Returns a `spawnClaudeCodeProcess` implementation for the configured mode.
 *
 * `none` runs the agent directly on the host, exactly as the validation spike
 * did. It exists so the driver and event mapping can be developed and tested
 * before a container runtime is available, and `assertSandboxAllowed` in
 * src/lib/runner/execute.ts refuses it in production — the mode flag is a
 * foot-gun that the guard closes at the point of use.
 */
export function createSandboxSpawn(
  config: SandboxConfig,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (options) => {
    if (config.mode === "none") {
      // No container, and therefore no proxy: the agent runs on the host and
      // resolves credentials the way any local tool would. Applying the
      // sandbox env filter here would strip the credential and point the agent
      // at a proxy that is not running, so `none` would authenticate against
      // nothing. This is the escape hatch behaving as an escape hatch, and it
      // is why assertSandboxAllowed in src/lib/runner/execute.ts refuses the
      // mode in production (ADR-0003).
      return spawnProcess(options.command, options.args, {
        cwd: options.cwd ?? config.workdir,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      });
    }

    const env = buildSandboxEnv({
      sdkEnv: options.env,
      baseUrl: config.proxyBaseUrl,
      placeholderToken: config.placeholderToken,
    });

    const { file: envFile, remove: removeEnvFile } = writeEnvFile(env);
    const args = buildDockerArgs(config, {
      command: options.command,
      args: options.args,
      envFile,
    });

    let child;
    try {
      child = spawnProcess(config.dockerBinary ?? "docker", args, {
        // The host cwd is irrelevant: the container's is set by -w.
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      });
    } catch (error) {
      // spawn can throw synchronously — an aborted signal, or an argument the
      // runtime rejects before forking. Nothing will ever emit, so the file has
      // to be removed here or it stays on disk for the life of the process.
      removeEnvFile();
      throw error;
    }

    // Deleting on `spawn` is a race, not an optimization: `spawn` fires when
    // the child process exists, which is before docker has parsed its own
    // arguments and read --env-file. The container would start with no
    // environment — no proxy URL, no run token — and fail to reach the API in a
    // way that looks like a network problem rather than a missing file. Wait
    // for the process to be gone, by which point docker has certainly read it.
    child.once("error", removeEnvFile);
    child.once("exit", removeEnvFile);

    return child;
  };
}
