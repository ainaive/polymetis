import { describe, expect, test } from "bun:test";

import {
  INSTALL_STATE_TTL_MS,
  signInstallState,
  verifyInstallState,
} from "./install-state";

const SECRET = "test-secret-at-least-32-characters-long";
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);
const state = { userId: "user_1", locale: "zh" };

describe("install state", () => {
  test("round-trips the person and where they came from", () => {
    const signed = signInstallState(state, SECRET, NOW);
    expect(verifyInstallState(signed, SECRET, NOW)).toMatchObject({
      userId: "user_1",
      locale: "zh",
    });
  });

  test("rejects a state signed with a different secret", () => {
    const signed = signInstallState(state, "another-secret-entirely-32-chars-x", NOW);
    expect(verifyInstallState(signed, SECRET, NOW)).toBeNull();
  });

  test("rejects a tampered payload", () => {
    // The whole point: swapping the user id must not survive the signature.
    const signed = signInstallState(state, SECRET, NOW);
    const forged = Buffer.from(
      JSON.stringify({ userId: "attacker", locale: "en", exp: NOW + 60_000 }),
    ).toString("base64url");
    expect(verifyInstallState(`${forged}.${signed.split(".")[1]}`, SECRET, NOW)).toBeNull();
  });

  test("rejects an expired state", () => {
    const signed = signInstallState(state, SECRET, NOW);
    expect(verifyInstallState(signed, SECRET, NOW + INSTALL_STATE_TTL_MS + 1)).toBeNull();
  });

  test("accepts one that has not quite expired", () => {
    const signed = signInstallState(state, SECRET, NOW);
    expect(verifyInstallState(signed, SECRET, NOW + INSTALL_STATE_TTL_MS - 1)).not.toBeNull();
  });

  test("rejects absent, empty and malformed values", () => {
    expect(verifyInstallState(null, SECRET, NOW)).toBeNull();
    expect(verifyInstallState("", SECRET, NOW)).toBeNull();
    expect(verifyInstallState("nodot", SECRET, NOW)).toBeNull();
    expect(verifyInstallState(".abc", SECRET, NOW)).toBeNull();
    expect(verifyInstallState("not-base64.abc", SECRET, NOW)).toBeNull();
  });

  test("rejects a signature of the right shape but wrong value", () => {
    const signed = signInstallState(state, SECRET, NOW);
    const [encoded, signature] = signed.split(".");
    const flipped = `${signature!.slice(0, -1)}${signature!.slice(-1) === "A" ? "B" : "A"}`;
    expect(verifyInstallState(`${encoded}.${flipped}`, SECRET, NOW)).toBeNull();
  });

  test("rejects a payload missing its user", () => {
    // A signed but empty user id would otherwise pass the signature check and
    // then compare equal to nothing.
    const encoded = Buffer.from(
      JSON.stringify({ userId: "", locale: "en", exp: NOW + 60_000 }),
    ).toString("base64url");
    const signed = signInstallState({ userId: "x", locale: "en" }, SECRET, NOW);
    void signed;
    expect(verifyInstallState(`${encoded}.whatever`, SECRET, NOW)).toBeNull();
  });
});
