import { index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { users } from "./auth";

// Column names are camelCase in SQL throughout. better-auth requires camelCase
// for its own tables, and one convention per database beats two.

export const workspaceMemberRoles = ["owner", "admin", "member"] as const;
export type WorkspaceMemberRole = (typeof workspaceMemberRoles)[number];

/**
 * Workspaces exist from day one even though v1 is effectively one per user.
 * Retrofitting a tenancy column across runs, templates, and quota later is the
 * expensive version of this decision.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: text().primaryKey(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    /**
     * Tokens this workspace may spend per calendar month.
     *
     * On the workspace rather than in a settings table because it is one number
     * per tenant and it has to be readable in the same query that sums usage —
     * a join for a single integer is a join that will eventually be forgotten.
     * Measured runs ranged from 73K to 3.5M tokens, so this is counted in
     * millions, not in runs.
     */
    monthlyTokenAllowance: integer().notNull().default(20_000_000),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspaces_slug_idx").on(t.slug)],
);

export const workspaceMembers = pgTable(
  "workspaceMembers",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: workspaceMemberRoles }).notNull().default("member"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workspaceMembers_workspace_user_uq").on(t.workspaceId, t.userId),
    index("workspaceMembers_userId_idx").on(t.userId),
    // One owner membership per person. Provisioning checks for an existing one
    // and then inserts, which is a read-then-write race: two concurrent
    // sign-ups could both find none. The database is what actually decides,
    // and without this the loser creates a second workspace that silently
    // splits one person's runs across two tenants.
    unique("workspaceMembers_owner_uq").on(t.userId, t.role),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
