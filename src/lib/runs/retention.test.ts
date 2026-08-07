import { describe, expect, test } from "bun:test";

import { mayPurge } from "./retention";

const base = { visibility: "private", isDemo: false, purgedAt: null };

describe("mayPurge", () => {
  test("a private run may lose its log", () => {
    expect(mayPurge(base)).toBe(true);
  });

  test("a demo run never does", () => {
    // It is the gallery. Purging one empties a card on the homepage.
    expect(mayPurge({ ...base, isDemo: true })).toBe(false);
  });

  test("a public or unlisted run never does", () => {
    // The value of a replay URL is that it keeps working. Someone may have put
    // either of these in a review comment months ago.
    expect(mayPurge({ ...base, visibility: "public" })).toBe(false);
    expect(mayPurge({ ...base, visibility: "unlisted" })).toBe(false);
  });

  test("an already-purged run is not purged again", () => {
    expect(mayPurge({ ...base, purgedAt: new Date() })).toBe(false);
  });

  test("a demo run that is somehow private is still spared", () => {
    // isDemo wins. The two flags moving together is curate.ts's job, and this
    // should not be the place that discovers they came apart.
    expect(mayPurge({ ...base, isDemo: true, visibility: "private" })).toBe(false);
  });
});
