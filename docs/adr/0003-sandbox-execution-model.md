# ADR-0003: The agent runs in the container; credentials are injected at egress

- **Status**: Accepted
- **Date**: 2026-08-06
- **Amends**: ADR-0002, which covered only the GitHub credential

## Context

ADR-0002 established the sandbox as the trust boundary: repository content is
untrusted input, the agent acts on it, and no credential crosses into the
container. It was written about the **GitHub token**, and its mitigation — the
worker clones on the host and bind-mounts the result — solves that case
completely.

Building the runtime surfaced a second credential that ADR-0002 did not
consider. Whatever process calls the model API needs an **Anthropic
credential**. If the agent runs inside the sandbox, the sandbox holds one, and
ADR-0002's rule is quietly false.

Two further questions had to be settled to write any of this:

1. **How does the agent end up inside a container at all?** The Agent SDK's
   built-in tools (Read, Write, Grep, Bash) execute in the process the SDK
   spawns. Sandboxing them means sandboxing that process.
2. **How is the runtime developed before a container runtime exists?**

## Decision

### The agent runs in the container, via `spawnClaudeCodeProcess`

The SDK exposes `spawnClaudeCodeProcess`, documented for "VMs, containers, or
remote environments". It drives the agent over stdin/stdout, so replacing the
spawn with `docker run -i` moves the process — and therefore every tool
execution, including tools added to the SDK later — inside the container. The
worker stays on the host and consumes the message stream.

No bespoke driver is baked into the image. The image contains a JavaScript
runtime and the Claude Code executable the SDK ships, pinned to the same
version as the worker's, because the worker hands the container the argv the
SDK built for a local spawn.

### The Anthropic credential never enters the container

The container receives `ANTHROPIC_BASE_URL` pointing at a proxy on the worker
and a **placeholder** token. The proxy swaps in the real credential on the way
out. Exfiltrating anything from the container therefore gains an attacker
nothing, and ADR-0002's rule holds for both credentials rather than one.

> **Amended 2026-08-07 — the claim above was unenforced.** "Exfiltrating
> anything from the container gains an attacker nothing" holds only if the
> proxy sends the credential to *upstream*. It resolved the sandbox's
> request-target with `new URL(req.url, upstream)`, which treats that target as
> a URL reference rather than a path, so an absolute-form request line or a
> protocol-relative target chose the destination and the proxy attached the real
> credential to it. The run-token check does not catch this: code executing in
> the container legitimately holds that token, and uses the credential path
> exactly as designed — only the destination changes.
>
> The property is now enforced by `resolveUpstreamUrl` in
> `src/lib/sandbox/proxy.ts`, which accepts only origin-form paths that resolve
> onto the upstream origin. That function is the boundary in code, the way
> `src/lib/sandbox/env.ts` is for the environment; its tests are the guarantee.
>
> Nothing had exercised it, because the container that would have made the
> request has never run (see the egress note below) and the one shipped
> template's tool policy has no `Bash`. Both are accidents of what has been
> built so far, not controls — which is the same shape of mistake as the egress
> claim ADR-0005 corrects.

The environment handed to the container is built by **subtraction**: keep what
the SDK asked for, strip anything credential-shaped, then inject ours last. An
allowlist would have been stricter but wrong — the SDK puts variables in the
child environment that the Claude Code process needs for its control protocol,
and enumerating those is not our business. The suffix rules (`_TOKEN`, `_KEY`,
`_SECRET`, …) are deliberately broad so a credential added to the worker next
year is excluded by default rather than inherited because nobody updated a list.

### The proxy is the circuit breaker, and it counts tokens

The agent's own usage report arrives when the run ends. A prompt-injected agent
looping on tool calls would spend the whole budget before any number was
visible, so the only place that can actually stop a runaway run is the thing
its traffic passes through.

It trips on **tokens**, not dollars. The proxy observes tokens exactly;
converting them to dollars would require a pricing table duplicated from the
SDK and free to drift out of step with it. `RUN_TOKEN_CEILING` is what the proxy
enforces; the dollar figure on a settled run comes from the SDK's own
`total_cost_usd` and is a record, not a limit.

*(Amended in M5: this originally also described a `RUN_COST_CEILING_USD`
"accounting budget". Nothing ever read it, so it was removed rather than left
looking like a control.)*

### `SANDBOX_MODE=none` exists, and production refuses it

`none` spawns the agent directly on the host. It exists so the driver, the
event mapping, and the template contract can be developed and tested before a
container runtime is available — which is exactly the situation this was
written in. `src/env.ts` throws on it when `NODE_ENV=production`, alongside the
existing dev-fallback guards.

## Consequences

The blast radius of a prompt injection is bounded to the run: the agent can
produce a wrong or malicious deliverable, exhaust its token ceiling, and read
the checkout it was given. It cannot reach either credential, the database, the
host filesystem, or other runs' workdirs — each of those follows from something
enforced here: the credentials never enter the container, the only mount is the
run's own workdir, and the proxy will only carry the credential to upstream.

That last clause is load-bearing and was added after the fact. "The credential
is not in the container" bounds nothing on its own if the container can still
direct where the credential gets sent — see the amendment above.

Confining it to the proxy as its **only** network destination does not follow
the same way. That depends on how the Docker network is configured on the host,
which this ADR specifies but nothing in the codebase enforces or has yet
observed. It is therefore an intended property of this design, not a guarantee
it currently provides — see the unverified-egress note below.

What this costs:

- **The mode flag is a foot-gun.** `SANDBOX_MODE=none` is one environment
  variable away from running a model-driven agent over untrusted content with
  the worker's own filesystem and network. The production guard is the only
  thing standing between those two states, which is why it is a hard boot
  failure rather than a warning.
- **Two SDK version pins must stay in step** — the worker's dependency and the
  image's `AGENT_SDK_VERSION`. A mismatch fails at run time, not build time.
- **Egress restriction was declared here and was wrong.** This ADR called for a
  network created `--internal` while also reaching a host-side proxy through
  the gateway that `--internal` removes; the two cannot both hold, and no run
  ever exposed it because nothing created the network at all. **ADR-0005
  corrects this**: the network is an ordinary bridge, and egress denial is a
  host firewall rule. `scripts/verify/sandbox-isolation.ts` now exists and is
  what settles whether it works; until it has been run against a real runtime,
  treat network isolation as intended rather than proven.
- **The proxy is a single point of failure** for every run on a worker. It is
  in-process with the worker, so it dies with it, which is the correct
  coupling — but it means a proxy bug fails runs rather than degrading them.

## Alternatives rejected

**Credential in the container with a strict egress allowlist.** Simpler, and
`api.anthropic.com` is the one host that must be reachable anyway. Rejected
because traffic the worker never sees can be neither metered nor stopped — the
per-run token ceiling and the observed usage that settles an abandoned run both
depend on the proxy seeing every request — and because it would require amending
ADR-0002 to carve out an exception rather than upholding it.

**Agent SDK on the host with tools proxied into the container.** Keeps the
credential host-side without a proxy. Rejected because the SDK's built-in tools
run in-process: sandboxing them would mean disabling every built-in tool and
reimplementing them as custom MCP tools that shell into the container,
discarding most of the SDK's value to solve a problem the proxy solves in about
a hundred lines.

**A dollar-denominated breaker.** Rejected for the drift reason above. The
distinction is worth keeping clear: the proxy enforces a limit, the SDK reports
a cost, and neither pretends to be the other.
