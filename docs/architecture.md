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
| M3a | Queue claim, worker loop, settle, live SSE, tail view | in progress |
| M3b | Accounts, GitHub connect, dashboard, quota | |
| M4 | Curated demo runs, homepage design pass, full EN/ZH sweep | |
| M5 | Egress allowlist, cost ceilings, retention | |

M2 was split because its second half — the worker and live SSE — is what makes a
run startable at all, and M3's dashboard and quota are UI around an action that
would not otherwise exist. M3a builds the loop; M3b puts accounts on top of it.
A minimal reaper landed with M3a rather than M5: without one, a worker killed
mid-run leaves that run `running` forever with nothing driving it. M5 still owns
the policy around it.

M1 deliberately builds the gallery and replay player against a hand-authored
fixture with no runtime at all: it makes the event schema prove itself before
anything depends on it, and lets all UI work proceed at zero token cost.

**Public repositories only until M3b.** The worker clones on the host and
bind-mounts the result (ADR-0002), with the operator's git credentials
deliberately stripped from the clone environment — so a private repository fails
loudly rather than succeeding with the wrong identity. Private access needs the
user's own consented GitHub token, which is M3b.

**M2 carries the product risk.** If issue + repo → spec does not produce
something a senior engineer says saved them real time, no amount of gallery
polish matters.
