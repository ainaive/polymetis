import { describe, expect, test } from "bun:test";

import { workspaceName, workspaceSlug } from "./provision";

describe("workspaceSlug", () => {
  const user = { id: "abc123def456ghi789", email: "alex@example.com" };

  test("uses the name when there is one", () => {
    expect(workspaceSlug({ ...user, name: "Alex Rivera" })).toBe("alex-rivera-ghi789");
  });

  test("falls back to the email local part", () => {
    expect(workspaceSlug(user)).toBe("alex-ghi789");
  });

  test("two people with the same name do not collide", () => {
    // The suffix comes from the user id, so this holds without a retry loop
    // against the unique constraint — which is a race, not a fallback.
    const a = workspaceSlug({ id: "id-aaaaaa", email: "a@x.com", name: "Alex" });
    const b = workspaceSlug({ id: "id-bbbbbb", email: "b@x.com", name: "Alex" });
    expect(a).not.toBe(b);
  });

  test("produces a URL-safe slug from a non-Latin name", () => {
    // The slug ends up in URLs; a name that yields nothing usable must still
    // produce something rather than an empty segment.
    const slug = workspaceSlug({ ...user, name: "胡子勇" });
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("-")).toBe(false);
  });

  test("does not leave separators at the edges", () => {
    expect(workspaceSlug({ ...user, name: "  --Alex--  " })).toBe("alex-ghi789");
  });

  test("bounds the readable part", () => {
    const slug = workspaceSlug({ ...user, name: "x".repeat(100) });
    expect(slug.length).toBeLessThanOrEqual(32 + 1 + 6);
  });
});

describe("workspaceName", () => {
  test("uses the person's name", () => {
    expect(workspaceName({ name: "Alex", email: "a@x.com" })).toBe("Alex's workspace");
  });

  test("falls back to the email local part", () => {
    expect(workspaceName({ email: "alex@x.com" })).toBe("alex's workspace");
  });
});
