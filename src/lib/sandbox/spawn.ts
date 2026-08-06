import { spawn as spawnProcess } from "node:child_process";

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
  /** Docker network. Created `--internal` in production so egress is denied. */
  network?: string;
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
  spawnOptions: { command: string; args: string[]; env: Record<string, string> },
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

  for (const [name, value] of Object.entries(spawnOptions.env)) {
    args.push("-e", `${name}=${value}`);
  }

  args.push(config.image, spawnOptions.command, ...spawnOptions.args);
  return args;
}

/**
 * Returns a `spawnClaudeCodeProcess` implementation for the configured mode.
 *
 * `none` runs the agent directly on the host, exactly as the validation spike
 * did. It exists so the driver and event mapping can be developed and tested
 * before a container runtime is available, and `src/env.ts` refuses it in
 * production — the mode flag is a foot-gun that the env guard closes.
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
      // is why src/env.ts refuses the mode in production (ADR-0003).
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

    const args = buildDockerArgs(config, {
      command: options.command,
      args: options.args,
      env,
    });

    return spawnProcess("docker", args, {
      // The host cwd is irrelevant: the container's is set by -w.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
  };
}
