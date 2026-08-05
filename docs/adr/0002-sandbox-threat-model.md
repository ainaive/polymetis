# ADR-0002: Sandbox threat model — no credentials below the host boundary

- **Status**: Accepted
- **Date**: 2026-08-05

## Context

Polymetis runs a self-hosted Claude Agent SDK harness over a user's repository.
The agent has file and shell tools, and it reads repository content — README
files, issues, source comments, test fixtures — as input.

That content is **untrusted**. Anything in a repository can attempt prompt
injection, and unlike a chat product the injected text arrives through the
agent's normal working material rather than from the user. An agent with a
shell and a network route is a capable actor to hand to a stranger's README.

The credential at stake is the user's GitHub token. If it is reachable from
inside the sandbox, a successful injection escalates from "made the agent write
a bad spec" to "exfiltrated a token that reads, and possibly writes, the user's
private repositories."

Managed agent platforms solve this with a host-side git proxy that injects
credentials after the request leaves the sandbox. Self-hosting means we own the
equivalent boundary.

## Decision

**No credential ever crosses into the container.** Concretely:

1. The **worker clones the repository on the host**, using the decrypted GitHub
   token, into a per-run workdir. The token lives only in the worker process.
2. The container receives that workdir as a **bind mount** containing an
   already-materialized checkout. It gets no token, no environment variable
   holding one, and no credential-bearing git remote.
3. **v1 is read-only on the repository.** No push, no branch creation, no PR.
   This removes the write-credential problem rather than mitigating it.
4. The container runs **non-root**, with a read-only root filesystem except the
   workdir and a designated output directory, dropped capabilities, and CPU,
   memory, PID, and wall-clock limits.
5. Egress is **default-deny** with an allowlist. In v1 the only allowed
   destination is the Anthropic API: the repository is already on disk, so the
   agent needs no network to read it.
6. The GitHub token is **encrypted at rest** in the `accounts` table
   (`account.encryptOAuthTokens` in `src/auth/index.ts`), so a database read is
   not equivalent to a repository compromise.
7. OAuth requests **sign-in scopes only**. GitHub's classic `repo` scope grants
   write access to private repositories, which contradicts point 3. Repository
   access is a separate consented step in M3, preferring a GitHub App with
   fine-grained `contents: read` over classic scopes.

## Consequences

The blast radius of a successful prompt injection is bounded to the run: the
agent can produce a wrong or malicious deliverable, waste its cost ceiling, and
read the checkout it was given. It cannot reach the token, other users' data,
other runs' workdirs, or the network beyond the model API.

What we give up:

- **No `git pull` mid-run.** The checkout is a point-in-time snapshot taken by
  the worker. Fine for v1, where the input is a specific issue against a
  specific commit.
- **No package installation.** Default-deny egress blocks npm and PyPI, so the
  agent cannot install a dependency to inspect a project. If a template later
  needs to run a project's tests, that is a deliberate allowlist amendment with
  its own analysis, not a quiet loosening.
- **Operational burden is ours.** Container hardening, egress policy, and the
  reaper for stranded runs are all things we now maintain. This is the accepted
  cost of self-hosting rather than using a managed agent runtime.

## Enforcement

A PASS/FAIL script in `scripts/verify/` asserts that the container cannot reach
a non-allowlisted host and that no credential is present in its environment or
filesystem. It runs in CI (M5). Any change that would pass a credential into
the container requires amending this ADR first.
