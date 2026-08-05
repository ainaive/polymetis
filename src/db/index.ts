import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/env";

import * as schema from "./schema";

// One connection pool per process, shared by the Next.js server and the
// worker. postgres-js queues work beyond `max`. `idle_timeout` releases idle
// connections so managed Postgres can autosuspend between runs. `prepare:
// false` because pooled managed Postgres (PgBouncer in transaction mode)
// breaks named prepared statements, and the cost on a direct connection is
// negligible at this traffic.
const client = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT,
  prepare: false,
});

export const db = drizzle(client, { schema });

export type Db = typeof db;
/** Either the pool client or a transaction — for helpers usable in both. */
export type DbClient = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
