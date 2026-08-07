# Polymetis architecture

Polymetis is an AI agent task platform for software R&D: a **template-first**
vertical of the general-agent idea. You pick a template, give it typed inputs
(a repository and an issue), and an agent produces a deliverable. Every run is
recorded as a replayable event stream.

The v1 wedge is **issue → repo-grounded implementation spec**: given a
requirement and a repository, produce a spec and task breakdown that names the
real files, modules, and risks. That grounding is what separates Polymetis from
a chat window with a prompt library.

## Shape

```
Browser ──SSE──> Next.js API ──reads──> Postgres (runEvents, append-only)
                                            ▲
                                            │ append (runId, seq)
   Postgres runQueue  <──claim── Bun worker ┘
                                    │
                                    ├─ clone repo (token held HERE, never below)
                                    └─ sandboxed container, default-deny egress
                                            └─ Claude Agent SDK over the workdir
```

Two processes share one codebase and one database:

- **The web app** (`src/app`) serves the public gallery, the replay player, and
  the authenticated dashboard. It never talks to a model.
- **The worker** (`src/worker`) claims queued runs, prepares a workdir, drives
  the agent inside a sandbox, and appends events. It runs directly under Bun
  with no Next.js runtime, which is why the import boundary in
  `eslint.config.mjs` exists.

## The event log is the spine

`runEvents` is an append-only stream keyed by `(runId, seq)`. Everything the
product does with a run reads that one table:

| Capability | How it falls out of the log |
|---|---|
| Replay | Read the events in `seq` order and animate them |
| Live streaming | Read persisted events past `?after_seq=N`, then tail |
| Reconnect without loss | The client resends the last `seq` it saw |
| Cost accounting | Sum the `usage` events |
| Fork a run at step N (later) | Take the prefix up to `seq = N` |
| Evals (later) | Compare deliverables produced from the same template version |

Replay reads our own Postgres, so **replaying a run costs nothing**. That is
what makes a public gallery safe to leave open to anonymous visitors while runs
themselves stay login-gated and metered.

See ADR-0001 for why this is append-only rather than mutable run state.

## A template is a contract, not a prompt

A `templateVersion` is immutable and has five parts:

1. **`inputSchema`** — typed parameters (repository, issue URL, audience)
2. **`toolPolicy`** — which tools the agent may use, and under what permission
3. **`directives`** — the agent instructions
4. **`deliverable`** — the artifact contract: filename, format, required sections
5. **`rubric`** — how to tell whether the deliverable is any good

A run pins a `templateVersionId`, so a replay from months ago still describes
exactly what produced it. Saved prompts have no moat; this contract is what
makes runs comparable and replays legible.

## Trust boundary

The agent reads untrusted repository content and acts on it, so the sandbox is
treated as hostile. The worker clones the repo **on the host** and bind-mounts
the result; no credential is ever passed into the container, and v1 is
read-only on the repository — no push, no PR creation. See ADR-0002.

## Layout

```
src/app/[locale]/   public gallery, replay, dashboard (locale-prefixed URLs)
src/app/api/        auth, run SSE stream
src/components/     ui (shadcn) / layout / gallery / replay / run / dashboard
src/db/             Drizzle schema and queries
src/lib/            templates, runs, events, github, sandbox — framework-free
src/worker/         queue claim, sandbox launch, agent driver, event relay
src/auth/           better-auth config (outside the boundary: uses next/headers)
src/i18n/           routing, request config, locale-aware navigation
messages/           en.json, zh.json
drizzle/            generated migrations
docs/adr/           decisions and their rationale
```

## Milestones

| | Scope | State |
|---|---|---|
| M0 | Scaffold, conventions, check gate, ADRs | done |
| M1 | Schema, event log, golden-run fixture, replay player, gallery | done |
| M2 | Sandbox, agent driver, credential proxy, first template | done |
| M3a | Queue claim, worker loop, settle, live SSE, tail view | done |
| M3b | Accounts, access control, dashboard, run form, quota, GitHub App | done |
| M4 | Curated demo runs, homepage design pass, full EN/ZH sweep | done |
| M5 | Sandbox verification, egress correction, retention | in progress |

M2 was split because its second half — the worker and live SSE — is what makes a
run startable at all, and M3's dashboard and quota are UI around an action that
would not otherwise exist. M3a builds the loop; M3b puts accounts on top of it.
A minimal reaper landed with M3a rather than M5: without one, a worker killed
mid-run leaves that run `running` forever with nothing driving it. M5 still owns
the policy around it.

M1 deliberately built the gallery and replay player against a hand-authored
fixture with no runtime at all: it made the event schema prove itself before
anything depended on it, and let all UI work proceed at zero token cost. **M4
retired that fixture from the gallery.** It served its purpose and still drives
the player's unit tests, but the homepage claims these replays are real, and one
of them was not. See `docs/gallery.md` for how runs get there now.

**Private repositories go through a GitHub App** (ADR-0004), which is built but
**not yet registered** — see issue #5 for the registration steps and what to
verify once it exists. Public repositories are unaffected. The worker clones
on the host and bind-mounts the result (ADR-0002), with the operator's git
credentials stripped from the clone environment, so a repository is reachable
only through a credential the workspace consented to. That credential is a
short-lived installation token passed as an HTTP header through the environment
— never in the remote URL, which git would persist into the bind-mounted
`.git/config`, and never in argv, which `ps` exposes.

**A run belongs to a workspace.** `visibility` is enforced by one predicate used
by both the replay page and the SSE stream; private fails closed, and the CLI
scripts create `unlisted` runs because an operator has no session to be a member
of.

**The sandbox has never run.** Every run so far, including all four gallery
runs, used `SANDBOX_MODE=none` — the agent directly on the host. `src/env.ts`
refuses that in production, so this is what stands between the project and a
deployment. M5 made the design coherent (ADR-0005 corrects an egress claim in
ADR-0003 that could not have worked) and wrote
`scripts/verify/sandbox-isolation.ts`, which skips until a container runtime
exists. Running it is tracked in issue #7.

**M2 carries the product risk.** If issue + repo → spec does not produce
something a senior engineer says saved them real time, no amount of gallery
polish matters.
