import { describe, expect, test } from "bun:test";

import { canViewRun } from "./access";

const signedOut = { workspaceId: null };
const owner = { workspaceId: "ws_owner" };
const stranger = { workspaceId: "ws_stranger" };

describe("canViewRun", () => {
  test("a public run is readable by anyone", () => {
    const run = { visibility: "public" as const, workspaceId: "ws_owner" };
    expect(canViewRun(run, signedOut)).toBe(true);
    expect(canViewRun(run, stranger)).toBe(true);
  });

  test("an unlisted run is readable by anyone holding the link", () => {
    // The 24 random characters of the run id are the access control. This is
    // what makes a replay URL pasteable into a review.
    const run = { visibility: "unlisted" as const, workspaceId: "ws_owner" };
    expect(canViewRun(run, signedOut)).toBe(true);
    expect(canViewRun(run, stranger)).toBe(true);
  });

  test("a private run is readable by its own workspace", () => {
    const run = { visibility: "private" as const, workspaceId: "ws_owner" };
    expect(canViewRun(run, owner)).toBe(true);
  });

  test("a private run is not readable by anyone else", () => {
    const run = { visibility: "private" as const, workspaceId: "ws_owner" };
    expect(canViewRun(run, stranger)).toBe(false);
    expect(canViewRun(run, signedOut)).toBe(false);
  });

  test("a private run nobody owns is readable by nobody", () => {
    // Fail closed. The alternative is that "private" quietly means "public to
    // anyone holding the id", which is not what the word promises.
    const run = { visibility: "private" as const, workspaceId: null };
    expect(canViewRun(run, owner)).toBe(false);
    expect(canViewRun(run, signedOut)).toBe(false);
  });

  test("being signed in is not on its own permission", () => {
    // A viewer with a workspace must match the run's, not merely have one.
    const run = { visibility: "private" as const, workspaceId: "ws_owner" };
    expect(canViewRun(run, { workspaceId: "ws_owner_2" })).toBe(false);
  });
});
