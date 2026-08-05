import { z } from "zod";

/**
 * A template version is a contract, not a saved prompt. Saved prompts have no
 * moat and get copied in a weekend; this five-part contract is what makes runs
 * comparable, replays legible, and inputs validatable before a run is queued.
 *
 * These schemas are framework-free on purpose — the worker validates against
 * the same definitions the web form renders from, so a run cannot be queued
 * with inputs the agent will choke on.
 */

// ---------------------------------------------------------------- 1. inputs

export const templateInputFieldSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("repo"),
    name: z.string().min(1),
    required: z.boolean().default(true),
    /** Public repositories only, for curated demo runs on OSS. */
    publicOnly: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("issue"),
    name: z.string().min(1),
    required: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("text"),
    name: z.string().min(1),
    required: z.boolean().default(false),
    maxLength: z.number().int().positive().default(2000),
  }),
  z.object({
    type: z.literal("select"),
    name: z.string().min(1),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1)).min(2),
    defaultValue: z.string().optional(),
  }),
]);

export const templateInputSchema = z.object({
  fields: z.array(templateInputFieldSchema).min(1),
});

export type TemplateInputField = z.infer<typeof templateInputFieldSchema>;
export type TemplateInputSchema = z.infer<typeof templateInputSchema>;

// ------------------------------------------------------------ 2. tool policy

/**
 * Which tools the agent may use. Deny wins over allow. This is enforced when
 * configuring the Agent SDK harness in M2 — it is not advisory.
 */
export const toolPolicySchema = z.object({
  allow: z.array(z.string().min(1)).min(1),
  deny: z.array(z.string().min(1)).default([]),
  /** Tools requiring an explicit confirmation rather than running silently. */
  confirm: z.array(z.string().min(1)).default([]),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

// ----------------------------------------------------------- 3. deliverable

/**
 * The artifact contract. `sections` is what the rubric grades against and what
 * the replay player shows filling in as the run proceeds.
 */
export const deliverableSchema = z.object({
  filename: z.string().min(1),
  format: z.enum(["markdown"]),
  sections: z.array(z.string().min(1)).min(1),
});

export type Deliverable = z.infer<typeof deliverableSchema>;

// --------------------------------------------------- validating run inputs

/**
 * Validate submitted inputs against a template's declared input schema.
 * Returns the coerced values, or the list of problems — callers surface these
 * on the run form rather than queueing a run that cannot succeed.
 */
export function validateRunInputs(
  schema: TemplateInputSchema,
  inputs: Record<string, unknown>,
): { ok: true; values: Record<string, string> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const values: Record<string, string> = {};

  for (const field of schema.fields) {
    const raw = inputs[field.name];
    const missing = raw === undefined || raw === null || raw === "";

    if (missing) {
      if (field.required) errors.push(`${field.name} is required`);
      else if (field.type === "select" && field.defaultValue) {
        values[field.name] = field.defaultValue;
      }
      continue;
    }

    if (typeof raw !== "string") {
      errors.push(`${field.name} must be a string`);
      continue;
    }
    const value = raw.trim();

    switch (field.type) {
      case "repo": {
        if (!parseRepoRef(value)) {
          errors.push(`${field.name} must look like owner/name or a GitHub URL`);
          continue;
        }
        break;
      }
      case "issue": {
        if (!parseIssueRef(value)) {
          errors.push(`${field.name} must be a GitHub issue URL`);
          continue;
        }
        break;
      }
      case "text": {
        if (value.length > field.maxLength) {
          errors.push(`${field.name} must be at most ${field.maxLength} characters`);
          continue;
        }
        break;
      }
      case "select": {
        if (!field.options.includes(value)) {
          errors.push(`${field.name} must be one of: ${field.options.join(", ")}`);
          continue;
        }
        break;
      }
    }

    values[field.name] = value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

const REPO_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const REPO_SHORT = /^([\w.-]+)\/([\w.-]+)$/;
const ISSUE_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/;

export type RepoRef = { owner: string; name: string };
export type IssueRef = RepoRef & { number: number };

/** Accepts `owner/name` or a github.com URL. */
export function parseRepoRef(value: string): RepoRef | null {
  const trimmed = value.trim();
  // Check the issue form first: an issue URL also matches nothing here, but a
  // repo URL with a trailing path would otherwise parse as a repo name.
  const match = REPO_URL.exec(trimmed) ?? REPO_SHORT.exec(trimmed);
  if (!match) return null;
  return { owner: match[1], name: match[2] };
}

/** Accepts a github.com issue URL. */
export function parseIssueRef(value: string): IssueRef | null {
  const match = ISSUE_URL.exec(value.trim());
  if (!match) return null;
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}
