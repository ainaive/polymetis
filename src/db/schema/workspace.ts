import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

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
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
