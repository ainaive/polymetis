import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { workspaces } from "./workspace";

/**
 * A GitHub App installation, connected to a workspace.
 *
 * Deliberately holds no token. An installation token lives about an hour and is
 * minted when a clone needs one (ADR-0004); storing one would recreate exactly
 * the long-lived repository credential the App was chosen to avoid (ADR-0002).
 * What is stored is an identifier that is worthless without the App's private
 * key, which never leaves the server's environment.
 */
export const githubInstallations = pgTable(
  "githubInstallations",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** GitHub's installation id. Numeric, stored as text like every other id. */
    installationId: text().notNull(),
    /** The org or user the App was installed on, for display. */
    accountLogin: text().notNull(),
    /** Who connected it, for an audit trail. Kept if they leave. */
    connectedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per installation: reconnecting the same installation updates
    // rather than accumulating duplicates that disagree about the owner.
    unique("githubInstallations_installationId_uq").on(t.installationId),
    index("githubInstallations_workspaceId_idx").on(t.workspaceId),
  ],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
