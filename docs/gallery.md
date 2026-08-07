# The gallery

The homepage lists curated runs. Curation is manual and deliberately so: every
card claims *this is a real run against a real repository, watch the whole
thing*, and that is only worth saying if someone read the deliverable first and
decided it was worth showing.

## How a run gets there

```sh
bun run enqueue <repo-url> <issue-url> --public   # queue it
bun run worker                                    # run it
bun run curate list                               # see candidates and refusals
bun run curate show <runId>                       # read the deliverable — do not skip
bun run curate promote <runId>                    # publish it
bun run curate demote <runId>                     # unlist it, link still works
```

`canCurate` (`src/lib/runs/curate.ts`) refuses what can be checked mechanically:
a run that did not succeed, one whose log has no `run.end`, one that stored no
deliverable, and one against a local path — because "Run this on your own repo"
sits beneath every card, and a demo pointing at a directory on one laptop is an
invitation nobody can accept.

**Nothing checks whether the spec is any good.** That is the reading step, and it
is the whole reason this is not automated.

## What is in it, and why

| Run | Repository | Issue | Why |
|---|---|---|---|
| `run_g37gtk…` | honojs/hono | [#3869](https://github.com/honojs/hono/issues/3869) — type inference is slow during builds | Names the mechanism with file and line references, counts the overload ladder (23 + 21 + 23), and identifies that the tractable problem is *measurement* rather than optimisation — then designs the harness for it. |
| `run_6i97tb…` | TanStack/query | [#2712](https://github.com/TanStack/query/issues/2712) — errored queries not retried on mount | Traces the mechanism across three files, notices the issue was filed against v3 while the repo is v5 and confirms the behaviour still follows, and says plainly which parts it verified by reading rather than by running. |

## Choosing repositories

Well-known TypeScript projects, on real open issues. The recognition is the
point: a visitor who knows the codebase can judge whether the spec is any good,
which is the claim the gallery is making. A spec about a repository nobody has
seen proves nothing to anyone.

## A note on the previous gallery

Until M4 the gallery held exactly one entry, `run_goldenfixture000000000` — a
hand-authored event stream from `src/lib/fixtures/golden-run.ts`, seeded with
`isDemo`, presenting itself as a $1.2452 run against honojs/hono#3421. No agent
produced it.

That was the right call in M1: it let the entire replay player be built and
tested before a runtime existed, at zero token cost, and the architecture doc
says so. It became the wrong call the moment runs worked, because the homepage's
claim is specifically that these are real. The fixture still exists and still
drives the player's unit tests; what went is the pretence that it happened.

Its own successor refuses it, though for a narrower reason than "it was fake":
the fixture stored its repository as the shorthand `honojs/hono`, and
`classifyRepoSource` only recognises an `https://` URL or an absolute path. The
repository is perfectly cloneable — the recorded value simply is not a clone
source, so nothing could reproduce the run from what the row says.
