import { describe, expect, test } from "bun:test";

import {
  issueToSpecDeliverable,
  issueToSpecDirectives,
} from "@/lib/templates/issue-to-spec";

import { buildPrompt } from "./driver";

describe("buildPrompt", () => {
  const prompt = buildPrompt({
    directives: issueToSpecDirectives,
    deliverable: issueToSpecDeliverable,
    issue: "Title: Support X\n\nSome body.",
  });

  test("leads with the template's directives verbatim", () => {
    // The directives are part of the versioned contract. Reframing or
    // truncating them here would silently change what a template means
    // without producing a new template version.
    expect(prompt.startsWith(issueToSpecDirectives)).toBe(true);
  });

  test("includes the issue text", () => {
    expect(prompt).toContain("Title: Support X");
    expect(prompt).toContain("Some body.");
  });

  test("names the deliverable the contract declares", () => {
    expect(prompt).toContain(issueToSpecDeliverable.filename);
  });

  test("does not name a path outside the workdir", () => {
    // The agent writes inside the sandbox; an absolute host path in the prompt
    // would either fail or, worse, escape the workdir.
    expect(prompt).not.toContain("/Users/");
    expect(prompt).not.toContain("/private/");
  });
});
