# Polymetis

An **AI agent task platform for software R&D** — template-first, with run
replays as the shareable artifact.

Pick a template, give it a repository and an issue, and an agent produces a
deliverable. Every run is recorded as a replayable event stream, so a template
can ship with a full recording of itself working on a real public repository.

The v1 wedge is **issue → repo-grounded implementation spec**: a spec and task
breakdown that names the real files, modules, and risks. The grounding is the
point — a breakdown that says "1. Design the API 2. Implement 3. Test" is a
demo, not a product.

> Status: early. M0 (scaffold and conventions) is landing; the gallery and
> replay player arrive in M1. See [`docs/architecture.md`](./docs/architecture.md).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, RSC, Turbopack) |
| Language | TypeScript |
| Runtime | Bun |
| Styling | Tailwind CSS v4, shadcn/ui |
| Database | PostgreSQL + Drizzle ORM |
| Auth | better-auth (GitHub OAuth primary) |
| Agent runtime | Claude Agent SDK, self-hosted in a per-run sandbox |
| Background work | Bun worker + Postgres queue, SSE to the browser |
| i18n | next-intl, always-prefixed `/en` and `/zh` |

## Quickstart

```bash
bun install
cp .env.example .env.local     # DATABASE_URL is the only one needed to boot
bun run db:migrate
bun run dev                    # http://localhost:3000 → redirects to /en
```

The worker runs as a separate process:

```bash
bun run worker
```

No Anthropic key or GitHub OAuth app is needed to run the app — replay reads
the local event log and never calls a model, which is what lets M1 build the
gallery against fixtures.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Next.js dev server |
| `bun run build` / `start` | Production build and serve |
| `bun run check` | **The commit gate**: tsc + eslint + `bun test` |
| `bun run worker` | Run the queue worker under Bun |
| `bun run db:generate` | Generate a migration after a schema edit |
| `bun run db:migrate` | Apply migrations |
| `bun run db:studio` | Drizzle Studio |
| `bun run seed` | Seed templates and the golden-run fixture |

## Contributing

Read [`AGENTS.md`](./AGENTS.md) before writing code — it lists the rules that
are lint-enforced or have bitten before. Architectural decisions and their
rationale live in [`docs/adr/`](./docs/adr/).
