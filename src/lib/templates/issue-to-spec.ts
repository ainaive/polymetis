import type { Deliverable, TemplateInputSchema, ToolPolicy } from "./contract";

/**
 * The v1 wedge: a requirement plus a repository become an implementation spec
 * that names real files, modules, and risks.
 *
 * This lives in src/lib/templates rather than the next-intl catalogs because
 * it is worker-side content — the worker cannot import anything under
 * src/i18n. Only the display copy (title, summary) is localized, in
 * templateI18n.
 */

export const ISSUE_TO_SPEC_SLUG = "issue-to-spec";

export const issueToSpecInputSchema: TemplateInputSchema = {
  fields: [
    { type: "repo", name: "repo", required: true, publicOnly: false },
    { type: "issue", name: "issue", required: true },
    {
      type: "select",
      name: "audience",
      required: false,
      options: ["engineer", "tech-lead", "product-manager"],
      defaultValue: "engineer",
    },
  ],
};

export const issueToSpecToolPolicy: ToolPolicy = {
  // Read-only over the checkout, plus Write so the deliverable can be
  // produced. Bash and Edit are denied: v1 never mutates the repository, and
  // a shell is the widest capability we could hand to untrusted repo content
  // (ADR-0002).
  allow: ["Read", "Glob", "Grep", "Write"],
  deny: ["Bash", "Edit", "WebFetch", "WebSearch"],
  confirm: [],
};

export const issueToSpecDeliverable: Deliverable = {
  filename: "implementation-spec.md",
  format: "markdown",
  sections: [
    "Problem",
    "Affected modules",
    "Approach",
    "Task breakdown",
    "Risks and open questions",
    "Test plan",
  ],
};

export const issueToSpecDirectives = `You are producing an implementation spec for a software team.

You have read-only access to a checkout of the repository, and the text of one
issue. Your job is to turn that issue into a spec a competent engineer who does
not know this codebase could pick up and execute.

Ground every claim in the actual code:

- Name real files and real symbols. A path you did not read is a guess, and a
  guess in a spec is worse than an omission — say "I could not find where X is
  handled" instead.
- Before describing how something works, read it. Prefer Grep to find the
  entry points, then Read the files that matter.
- When you name a file, say what is in it and why it is affected.

Write the deliverable to implementation-spec.md with exactly these sections:
Problem, Affected modules, Approach, Task breakdown, Risks and open questions,
Test plan.

The task breakdown is the part the reader will actually use. Each task should
be independently reviewable, name the files it touches, and state how the
author will know it is done. Order them so the codebase is working after each
one. Do not pad the list to look thorough — four real tasks beat ten invented
ones.

Under risks, include what you were unsure about. A spec that admits it could
not determine the retry semantics is more useful than one that quietly invents
them.

Do not write code. Do not modify the repository. Produce the spec only.`;

export const issueToSpecRubric = `Grade the spec against these criteria. Each is pass or fail.

1. FILE ACCURACY — Every file path named in "Affected modules" and "Task
   breakdown" exists in the repository. Any invented path fails this criterion
   outright.
2. GROUNDING — The "Approach" section refers to how the code actually works
   today, citing specific symbols or functions, not generic architecture.
3. ACTIONABILITY — Each task in the breakdown names the files it touches and
   states a completion condition. A task like "implement the feature" fails.
4. ORDERING — The task breakdown leaves the codebase in a working state after
   each step.
5. HONESTY — Anything the run could not determine appears under "Risks and
   open questions" rather than being asserted confidently elsewhere.
6. COMPLETENESS — All six required sections are present and non-empty.
7. SCOPE — The spec addresses the issue as written and does not expand it into
   a redesign the issue did not ask for.`;
