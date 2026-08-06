import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  buildDockerArgs,
  CONTAINER_WORKDIR,
  createSandboxSpawn,
  formatEnvFile,
  type SandboxConfig,
} from "./spawn";

const config: SandboxConfig = {
  mode: "docker",
  image: "polymetis/sandbox:test",
  proxyBaseUrl: "http://polymetis-proxy:7777",
  placeholderToken: "placeholder",
  workdir: "/host/runs/run_abc",
  network: "polymetis-sandbox",
};

const args = () =>
  buildDockerArgs(config, {
    command: "bun",
    args: ["--version"],
    envFile: "/tmp/polymetis-run-abc/env",
  });

/** True when `flag` is present with `value` as the next argument. */
const hasFlag = (argv: string[], flag: string, value?: string) => {
  const i = argv.indexOf(flag);
  if (i === -1) return false;
  return value === undefined || argv[i + 1] === value;
};

describe("buildDockerArgs", () => {
  test("runs non-root", () => {
    expect(hasFlag(args(), "--user", "65532:65532")).toBe(true);
  });

  test("drops all capabilities and forbids regaining privileges", () => {
    const argv = args();
    expect(hasFlag(argv, "--cap-drop", "ALL")).toBe(true);
    expect(hasFlag(argv, "--security-opt", "no-new-privileges")).toBe(true);
  });

  test("mounts a read-only rootfs with a writable tmpfs", () => {
    const argv = args();
    expect(argv).toContain("--read-only");
    const tmpfs = argv[argv.indexOf("--tmpfs") + 1];
    expect(tmpfs).toContain("/tmp");
    expect(tmpfs).toContain("noexec");
    expect(tmpfs).toContain("nosuid");
  });

  test("caps memory, CPU and process count so one run cannot take the host down", () => {
    const argv = args();
    expect(hasFlag(argv, "--memory", "2g")).toBe(true);
    expect(hasFlag(argv, "--cpus", "2")).toBe(true);
    expect(hasFlag(argv, "--pids-limit", "512")).toBe(true);
  });

  test("mounts only the prepared workdir, and nothing else from the host", () => {
    const argv = args();
    const mounts = argv.filter((_, i) => argv[i - 1] === "-v");
    expect(mounts).toEqual([`/host/runs/run_abc:${CONTAINER_WORKDIR}:rw`]);
  });

  test("runs on the configured network and can reach the proxy by name", () => {
    const argv = args();
    expect(hasFlag(argv, "--network", "polymetis-sandbox")).toBe(true);
    expect(hasFlag(argv, "--add-host", "polymetis-proxy:host-gateway")).toBe(true);
  });

  test("keeps stdin open — the SDK speaks its protocol over it", () => {
    expect(args()).toContain("-i");
  });

  test("allocates no TTY, which would corrupt the protocol stream", () => {
    const argv = args();
    expect(argv).not.toContain("-t");
    expect(argv).not.toContain("--tty");
  });

  test("removes the container when the run ends", () => {
    expect(args()).toContain("--rm");
  });

  test("passes the command after the image, not before it", () => {
    const argv = args();
    const imageIndex = argv.indexOf(config.image);
    expect(imageIndex).toBeGreaterThan(-1);
    expect(argv.slice(imageIndex + 1)).toEqual(["bun", "--version"]);
  });

  test("passes the environment by file, never in argv", () => {
    // argv is world-readable through `ps`, and the environment carries the
    // per-run proxy token.
    const argv = args();
    expect(hasFlag(argv, "--env-file", "/tmp/polymetis-run-abc/env")).toBe(true);
    expect(argv).not.toContain("-e");
    expect(argv.join(" ")).not.toContain("ANTHROPIC_BASE_URL=");
  });

  test("never mounts the docker socket", () => {
    // A container that can reach the daemon is not a sandbox.
    expect(args().join(" ")).not.toContain("docker.sock");
  });

  test("never runs privileged", () => {
    expect(args()).not.toContain("--privileged");
  });
});

describe("formatEnvFile", () => {
  test("emits KEY=VALUE lines docker can read", () => {
    expect(formatEnvFile({ A: "1", B: "two" })).toBe("A=1\nB=two\n");
  });

  test("does not quote or escape — values pass through verbatim", () => {
    expect(formatEnvFile({ URL: "http://polymetis-proxy:7777" })).toBe(
      "URL=http://polymetis-proxy:7777\n",
    );
  });

  test("rejects a value containing a newline, which would inject a variable", () => {
    // --env-file has no quoting, so a newline in a value silently becomes an
    // extra environment entry in the container.
    expect(() => formatEnvFile({ A: "one\nB=two" })).toThrow(/newline/);
    expect(() => formatEnvFile({ A: "one\rB=two" })).toThrow(/newline/);
  });
});

describe("the container environment file", () => {
  /** Reads --env-file after a delay, the way docker reads it while parsing argv. */
  const fakeDocker = join(
    dirname(new URL(import.meta.url).pathname),
    "__fixtures__/slow-docker.sh",
  );

  const spawnInto = (extra: Partial<SandboxConfig> = {}) =>
    createSandboxSpawn({ ...config, dockerBinary: fakeDocker, ...extra })({
      command: "bun",
      args: ["--version"],
      env: { PATH: "/usr/bin", HOME: "/home/agent" },
    } as never);

  /**
   * The env file's path, read back from the argv we handed the runtime. The
   * SDK's SpawnedProcess type is narrower than what spawn() actually returns.
   */
  const envFileOf = (child: ReturnType<typeof spawnInto>) => {
    const argv = (child as unknown as ChildProcess).spawnargs;
    return argv[argv.indexOf("--env-file") + 1] ?? "";
  };

  const collect = async (child: ReturnType<typeof spawnInto>) => {
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    return { out, code };
  };

  test("survives long enough for the container runtime to read it", async () => {
    // The regression: cleanup was registered on 'spawn', which fires when the
    // child exists — before docker has parsed argv and opened --env-file. The
    // container would come up with no proxy URL and no run token, and fail as
    // what looks like a network problem rather than a missing file.
    const { out } = await collect(spawnInto());

    expect(out).not.toContain("MISSING_ENV_FILE");
    expect(out).toContain("ANTHROPIC_BASE_URL=http://polymetis-proxy:7777");
    expect(out).toContain("ANTHROPIC_AUTH_TOKEN=placeholder");
  });

  test("is removed once the container exits, along with its directory", async () => {
    const child = spawnInto();
    const envFile = envFileOf(child);
    expect(existsSync(envFile)).toBe(true);

    await collect(child);
    // 'exit' can land before the handler that removes it; yield once.
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(envFile)).toBe(false);
    // The mkdtemp directory goes too — one per run would otherwise accumulate.
    expect(existsSync(dirname(envFile))).toBe(false);
  });

  test("is removed when the runtime cannot be started at all", async () => {
    const child = spawnInto({ dockerBinary: "/nonexistent/docker" });
    const envFile = envFileOf(child);

    await new Promise((r) => child.once("error", r));
    await new Promise((r) => setTimeout(r, 50));

    expect(existsSync(envFile)).toBe(false);
  });
});
