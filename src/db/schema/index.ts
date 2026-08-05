// Barrel for every Drizzle table. Tables land in M1 (workspaces, templates,
// runs, run_event) and M3 (better-auth tables); keeping the barrel here from
// the start means drizzle.config.ts and src/db/index.ts never move.
export {};
