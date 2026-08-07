/**
 * Remove the logs of private runs past the retention window.
 *
 * Dry by default: the first thing anyone runs against a real database should
 * show what would go, not report what already went.
 *
 *   DATABASE_URL=... bun run scripts/retention.ts            # show only
 *   DATABASE_URL=... bun run scripts/retention.ts --apply    # actually delete
 */
import { db } from "@/db";
import { env } from "@/env";
import { purgeExpiredRuns } from "@/lib/runs/retention";

const apply = process.argv.includes("--apply");

if (env.RETENTION_DAYS <= 0) {
  console.log("RETENTION_DAYS is 0 — retention is disabled, nothing to do.");
  process.exit(0);
}

const result = await purgeExpiredRuns(db, {
  retentionDays: env.RETENTION_DAYS,
  now: new Date(),
  dryRun: !apply,
});

if (result.purged.length === 0) {
  console.log(`nothing older than ${env.RETENTION_DAYS} days is eligible`);
  process.exit(0);
}

const events = result.purged.reduce((n, r) => n + r.events, 0);
const artifacts = result.purged.reduce((n, r) => n + r.artifacts, 0);

console.log(
  `${result.dryRun ? "would remove" : "removed"} the logs of ${result.purged.length} run(s): ` +
    `${events} events, ${artifacts} artifacts`,
);
for (const row of result.purged) {
  console.log(`  ${row.runId}  ${row.events} events  ${row.artifacts} artifacts`);
}

if (result.dryRun) {
  console.log("\ndry run — pass --apply to delete");
}

process.exit(0);
