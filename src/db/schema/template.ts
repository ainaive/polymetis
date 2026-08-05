import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type {
  Deliverable,
  TemplateInputSchema,
  ToolPolicy,
} from "@/lib/templates/contract";

import { localeEnum } from "./auth";
import { workspaces } from "./workspace";

export const templateCategories = [
  "spec", // issue -> implementation spec (the v1 wedge)
  "test-plan",
  "architecture",
  "research",
] as const;
export type TemplateCategory = (typeof templateCategories)[number];

export const visibilities = ["private", "unlisted", "public"] as const;
export type Visibility = (typeof visibilities)[number];

export const templates = pgTable(
  "templates",
  {
    id: text().primaryKey(),
    // NULL means first-party: authored by us and shown in the public gallery.
    // User-authored templates arrive after v1.
    workspaceId: text().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    slug: text().notNull().unique(),
    category: text({ enum: templateCategories }).notNull(),
    visibility: text({ enum: visibilities }).notNull().default("private"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("templates_visibility_idx").on(t.visibility),
    index("templates_workspaceId_idx").on(t.workspaceId),
  ],
);

/**
 * Immutable once published. A run pins a templateVersionId, so a replay from
 * months ago still describes exactly what produced it — editing a published
 * version would silently rewrite the history of every replay pinned to it.
 *
 * There is deliberately no `currentVersionId` pointer on `templates`: it would
 * introduce a circular foreign key and a denormalized value that can drift.
 * The current version is the highest `version` with a non-null `publishedAt`.
 */
export const templateVersions = pgTable(
  "templateVersions",
  {
    id: text().primaryKey(),
    templateId: text()
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    publishedAt: timestamp({ withTimezone: true }),

    // The five-part contract.
    inputSchema: jsonb().$type<TemplateInputSchema>().notNull(),
    toolPolicy: jsonb().$type<ToolPolicy>().notNull(),
    directives: text().notNull(),
    deliverable: jsonb().$type<Deliverable>().notNull(),
    rubric: text().notNull(),

    model: text().notNull(),
    effort: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("templateVersions_template_version_uq").on(t.templateId, t.version),
    index("templateVersions_current_idx").on(t.templateId, t.version.desc()),
  ],
);

/**
 * Per-locale display copy. Kept out of the next-intl catalogs because template
 * copy is data, not UI chrome — first-party templates are seeded and
 * user-authored ones will be written by users.
 */
export const templateI18n = pgTable(
  "templateI18n",
  {
    templateVersionId: text()
      .notNull()
      .references(() => templateVersions.id, { onDelete: "cascade" }),
    locale: text({ enum: localeEnum }).notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    body: text(),
  },
  (t) => [
    unique("templateI18n_version_locale_uq").on(t.templateVersionId, t.locale),
  ],
);

export type Template = typeof templates.$inferSelect;
export type TemplateVersion = typeof templateVersions.$inferSelect;
export type TemplateI18n = typeof templateI18n.$inferSelect;
