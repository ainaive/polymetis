<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Polymetis project conventions

Read `docs/architecture.md` first; decisions and their rationale live in
`docs/adr/`. Rules that are enforced, or that have bitten before:

- **Gate**: `bun run check` (tsc + eslint + `bun test`) must be green before
  every commit. CI runs the same gate.
- **Import boundary** (lint-enforced): nothing under `src/lib`, `src/db`, or
  `src/worker` may import `next/*`, `react`, `react-dom`, `server-only`,
  `@/app/*`, `@/components/*`, or `@/auth/session`. The worker runs those
  modules directly under Bun, so a framework import fails at worker startup
  rather than at build time. `@/auth/index` is deliberately allowed — it is
  framework-free and the worker needs it to decrypt a stored GitHub token.
- **The run event log is append-only** (ADR-0001). Never update or delete a
  `run_event` row, and never renumber `seq`. Replay, SSE reconnect, cost
  accounting, and future fork-at-step all read it as an immutable stream.
- **Credentials never enter the sandbox** (ADR-0002). The worker clones the
  repo on the host and bind-mounts the result. Any change that would pass a
  token, an env var holding one, or a credential-bearing git remote into the
  container needs an ADR amendment first.
- **Template versions are immutable.** Editing a published `template_version`
  breaks every replay pinned to it. Publish a new version instead.
- **Migrations**: `bun run db:generate` after schema edits; never edit an
  applied migration (Drizzle will not re-run it — the hash goes stale). Custom
  SQL: `drizzle-kit generate --custom`.
- **i18n**: every user-facing string goes into BOTH `messages/en.json` and
  `messages/zh.json`. Locale comes from the URL prefix, never a cookie —
  gallery and replay links are public and shareable, and a link has to carry
  the language it was read in. Agent directives and deliverable copy are
  worker-side content and live in `src/lib/templates/`, NOT in the next-intl
  catalogs (the worker cannot import them).
- **Use `@/i18n/navigation`** (`Link`, `redirect`, `useRouter`) inside
  `src/app/[locale]`, not `next/link` or `next/navigation` — it keeps the
  locale prefix on every URL.
- **DB-dependent verification** lives in `scripts/verify/` as PASS/FAIL scripts
  run in CI; unit tests must not require Postgres.
- **Commits**: Conventional Commits with a body explaining why. No
  `Co-Authored-By`, no AI-attribution lines. Milestones branch as
  `<type>/<topic>` + PR; merge commits, no squashing.
