# ADR-0005: Egress denial is a host control, not a Docker flag

Status: accepted (2026-08-07). Corrects ADR-0003.

## Context

ADR-0003 and `src/lib/sandbox/spawn.ts` both describe the sandbox network as
created `--internal` "so egress is denied", while the same code passes
`--add-host polymetis-proxy:host-gateway` so the container can reach the
credential proxy running on the host.

**These cannot both hold.** `--internal` removes the network's gateway, and the
gateway is precisely the route to the host. On an internal network the proxy is
unreachable, so every run fails at its first model call.

Nothing had noticed because nothing ever ran it: no code, script or document
created that network at all, so the first `SANDBOX_MODE=docker` run would have
failed on a missing network before reaching the contradiction.

The wider claim was already flagged as unproven — ADR-0003 says to "treat
network isolation as intended rather than proven" — but "unproven" understated
it. The design as written could not have worked.

## Decision

1. **The sandbox network is an ordinary bridge**, created by
   `scripts/sandbox-setup.ts`, with a named bridge interface (`polymetis0`) so
   firewall rules have something to match on.

2. **Docker is not what denies egress.** What Docker provides is worth stating
   exactly, because it is not nothing: no credential in the container
   (ADR-0002), no host filesystem beyond the bind mount, non-root, read-only
   rootfs, dropped capabilities, and bounded memory, CPU and process count.
   None of that restricts where the container can connect.

3. **Egress denial is a host firewall rule** on that bridge: permit the gateway
   on the proxy's port, drop the rest. `sandbox-setup.ts` prints the rules
   rather than applying them — they need root, they differ by host, and a script
   that silently rewrites a firewall is worse than one that tells you what to
   run.

4. **`scripts/verify/sandbox-isolation.ts` is what settles it.** The rules
   printed today have never run on a host with a runtime. The verification
   checks the outcome — proxy reachable, everything else not — rather than the
   configuration, so it stays honest if the rules are wrong or a host applies
   them differently.

## Alternatives rejected

**Move the proxy into the sandbox network as a sidecar container.** This is the
one design where `--internal` works: with the proxy inside the network, there is
no gateway to want. Rejected for now because ADR-0003 makes the proxy in-process
with the worker so that it dies with it, and a proxy that outlives its worker is
a credential relay nobody is watching. Reconsider if the firewall approach
proves unworkable in deployment — this is the fallback, and it is a real one.

**Give the container the credential and an egress allowlist.** Already rejected
by ADR-0003, but its stated reason needs correcting: it said this "makes
`RUN_COST_CEILING_USD` unenforceable". That variable was never read by anything
and M5 removes it. The reasoning survives when restated in terms of what the
proxy actually enforces — the per-run **token** ceiling, and the observed usage
that settles a run the SDK never reported for. Traffic the worker never sees can
be neither metered nor stopped.

## Consequences

- **A deployment must apply the firewall rules or it has no egress control.**
  The application cannot enforce this and no longer pretends to. An operator who
  skips this step gets every other sandbox property and an agent that can reach
  the internet.
- **`SANDBOX_MODE=docker` now has a prerequisite** — `bun run sandbox:setup`.
  Failing on a missing network is a clear error, but only once someone knows the
  command exists, which is why it is in `.env.example` and the README path.
- **The claim in ADR-0003 stands corrected rather than deleted.** That ADR
  records what was decided at the time; this one records that part of it was
  wrong and why, which is more useful to a later reader than a quiet edit.
