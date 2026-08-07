# ADR-0001: The run event log is append-only

- **Status**: Accepted
- **Date**: 2026-08-05

## Context

A Polymetis run is a long-lived agent session — typically several minutes,
sometimes tens of minutes — that reads a repository, calls tools, and produces
a deliverable. The product needs to do six things with that session:

1. Replay it after the fact, as the core public artifact of the gallery
2. Stream it live to a browser while it is still running
3. Survive a dropped connection without losing or duplicating anything
4. Account for its cost
5. Later, fork it at an arbitrary step and re-run from there
6. Later, evaluate deliverables produced from the same template version

The obvious cheap implementation is a `run` row holding mutable state plus a
transcript blob, updated as the agent works.

## Decision

Runs are recorded as an **append-only event stream**: `runEvents`, keyed by
`(runId, seq)` with a uniqueness constraint, where `seq` is monotonic and
gap-free within a run. Rows are never updated, never deleted, and `seq` is
never renumbered.

> **Amended in M5 — retention.** One operation deletes: retention removes a
> private run's log once it is older than `RETENTION_DAYS`. It removes the log
> **whole**, in a single transaction, together with that run's artifacts, and
> marks the run `purgedAt`.
>
> The invariant replay, cost accounting and the SSE cursor actually depend on
> is *a log is complete or absent* — never partially deleted, never renumbered,
> never reordered. A whole-log deletion upholds that; it is a partial one that
> would break every consumer at once, which is why the deletion is transactional
> and why nothing anywhere deletes an individual event.
>
> Demo, public and unlisted runs are never purged: the gallery and any link
> someone has shared must keep working. See `src/lib/runs/retention.ts`. Event payloads are typed and validated by Zod schemas over a
closed set of event types.

`run` keeps only derived, terminal facts (status, totals, timestamps).

## Consequences

All six capabilities become reads of one table rather than six mechanisms:

- **Replay** is `SELECT ... ORDER BY seq`.
- **Live streaming** is the same query with `WHERE seq > $after`, then tailing
  a `NOTIFY` channel. The player does not need to know whether the run it is
  watching is live or archived — the same endpoint shape serves both.
- **Reconnect** works because `seq` is a cursor the client already holds: it
  resends the last value it saw. This is the property a transcript blob cannot
  give, and getting it wrong is how streaming UIs silently drop events.
- **Cost** is a fold over `usage` events, so a partial run still has a real
  number attached.
- **Fork** is the prefix `seq <= N`.
- **Evals** compare deliverables across runs that pin the same
  `templateVersionId`.

Because replay reads our own Postgres and never calls a model, **replaying a
run is free**. That is what makes it safe to leave the gallery open to
anonymous visitors while metering actual runs.

The costs we accept:

- The table grows without bound and needs a retention policy (M5).
- Event schemas are effectively public API. Changing an event's payload shape
  breaks replay of every run already recorded with it, so payloads are
  versioned by type and new information is added as new fields or new types,
  never by repurposing existing ones.
- A retried run cannot resume mid-stream. Because events are append-only, a
  retry starts a fresh `seq` range under a new attempt rather than rewriting
  history. Genuine mid-run agent resumption is deferred to v2.

## Alternatives rejected

**Mutable run state plus a transcript blob.** Cheapest to write, and it can
render a finished run. It cannot do reconnect-without-loss (no cursor), fork
(no addressable step), or partial-run cost (no per-step usage), and it makes
evals guesswork. Every one of those would have been retrofitted later against
recorded data that lacked the structure to support them.

**Event sourcing the whole domain.** Applying the same pattern to templates,
workspaces, and users would be consistent but buys nothing: those are small,
mutable, and never replayed. The log is scoped to runs, where replay is the
actual product.
