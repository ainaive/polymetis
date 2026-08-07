/**
 * Create the Docker network the sandbox runs on, and print the firewall rules
 * that actually deny egress.
 *
 * `spawn.ts` passes `--network <name>` on every sandboxed run and nothing has
 * ever created that network, so the first `SANDBOX_MODE=docker` run fails on a
 * missing network before reaching anything interesting.
 *
 *   bun run scripts/sandbox-setup.ts          # create it, print the rules
 *   bun run scripts/sandbox-setup.ts --check  # report only, change nothing
 */
import { spawnSync } from "node:child_process";

import { env } from "@/env";

const checkOnly = process.argv.includes("--check");

/** The bridge interface name, so firewall rules have something to match on. */
const BRIDGE = "polymetis0";

function docker(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) return { ok: false, out: String(result.error) };
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

const runtime = docker(["info", "--format", "{{.ServerVersion}}"]);
if (!runtime.ok) {
  console.error("No container runtime. Install one first:");
  console.error("  brew install colima docker && colima start --cpu 4 --memory 8");
  console.error(`\n(${runtime.out.split("\n")[0]})`);
  process.exit(1);
}
console.log(`docker ${runtime.out}`);

const existing = docker(["network", "inspect", env.SANDBOX_NETWORK, "--format", "{{.Name}}"]);

if (existing.ok) {
  console.log(`network ${env.SANDBOX_NETWORK} already exists`);
} else if (checkOnly) {
  console.log(`network ${env.SANDBOX_NETWORK} does NOT exist — run without --check`);
} else {
  // Deliberately a normal bridge, not --internal. An internal network has no
  // gateway, and the gateway is exactly how the container reaches the host-side
  // proxy (ADR-0005). Naming the bridge interface is what makes the firewall
  // rules below expressible at all.
  const created = docker([
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    `com.docker.network.bridge.name=${BRIDGE}`,
    env.SANDBOX_NETWORK,
  ]);

  if (!created.ok) {
    console.error(`could not create ${env.SANDBOX_NETWORK}: ${created.out}`);
    process.exit(1);
  }
  console.log(`created network ${env.SANDBOX_NETWORK} on bridge ${BRIDGE}`);
}

console.log(`
Egress is NOT denied by creating this network. Docker gives the container a
gateway — that is how it reaches the proxy — and a gateway also reaches the
internet. Denying the rest is a host firewall concern, which is why it is
printed rather than applied: it needs root, it differs by host, and a script
that silently rewrites a firewall is worse than one that tells you what to run.

On a Linux host, in DOCKER-USER (consulted before Docker's own rules). Insert
the DROP first so the ACCEPT lands above it:

  iptables -I DOCKER-USER -i ${BRIDGE} -j DROP
  iptables -I DOCKER-USER -i ${BRIDGE} -d "$(docker network inspect ${env.SANDBOX_NETWORK} \\
    --format '{{(index .IPAM.Config 0).Gateway}}')" \\
    -p tcp --dport ${env.SANDBOX_PROXY_PORT} -j ACCEPT

These are a starting point, not a verified configuration — they have not been
run on a host with a runtime. scripts/verify/sandbox-isolation.ts is what
decides whether they work: it checks that the container reaches the proxy and
does not reach anything else.

On macOS with colima the rules go inside the VM, not on the Mac.
`);

process.exit(0);
