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
  console.error("No container runtime reachable. Install or start one:");
  // Platform-specific, because "brew install colima" is wrong advice on the
  // Linux host this is most likely to run on in production.
  if (process.platform === "darwin") {
    console.error("  brew install colima docker && colima start --cpu 4 --memory 8");
  } else {
    console.error("  install Docker Engine (or a compatible runtime) and start its daemon");
    console.error("  e.g. sudo systemctl start docker");
  }
  console.error(`\n(${runtime.out.split("\n")[0]})`);
  process.exit(1);
}
console.log(`docker ${runtime.out}`);

// The shape matters, not just the name. A network created from the pre-ADR-0005
// instructions would be --internal — the exact configuration that cannot reach
// the proxy — and reporting "already exists" would wave it through.
const existing = docker([
  "network",
  "inspect",
  env.SANDBOX_NETWORK,
  "--format",
  "{{.Driver}}|{{.Internal}}|{{index .Options \"com.docker.network.bridge.name\"}}",
]);

if (existing.ok) {
  const [driver, internal, bridge] = existing.out.split("|");
  const problems: string[] = [];
  if (driver !== "bridge") problems.push(`driver is ${driver}, expected bridge`);
  if (internal === "true") {
    problems.push(
      "it is --internal, which cannot reach the host-side proxy (ADR-0005)",
    );
  }
  if (bridge !== BRIDGE) {
    problems.push(
      `bridge interface is ${bridge || "unnamed"}, expected ${BRIDGE} — the firewall rules have nothing to match on`,
    );
  }

  if (problems.length > 0) {
    console.error(`network ${env.SANDBOX_NETWORK} exists but is not usable:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      `\nRemove and recreate it:\n  docker network rm ${env.SANDBOX_NETWORK} && bun run sandbox:setup`,
    );
    process.exit(1);
  }

  console.log(`network ${env.SANDBOX_NETWORK} already exists and looks right`);
} else if (checkOnly) {
  console.log(`network ${env.SANDBOX_NETWORK} does NOT exist — run without --check`);
} else {
  // Deliberately a normal bridge, not --internal. An internal network is
  // isolated from traffic outside it, and the host — where the proxy runs — is
  // outside it (ADR-0005). Naming the bridge interface is what makes the
  // firewall rules below expressible at all.
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
Egress is NOT denied by creating this network. A non-internal bridge can route
outward — that is how the container reaches the proxy, and it is equally how it
would reach the internet. Denying the rest is a host firewall concern, which is
why it is printed rather than applied: it needs root, it differs by host, and a
script that silently rewrites a firewall is worse than one that tells you what
to run.

Note that --add-host polymetis-proxy:host-gateway resolves to the host address
Docker advertises, which is not necessarily this bridge's gateway. The
verification checks reachability rather than assuming either.

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
