import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `state` carried through a GitHub App installation.
 *
 * GitHub hands `installation_id` back to the callback as a plain query
 * parameter. Anyone can craft that request, so the callback needs to know two
 * things it cannot learn from the parameter itself: that the person arriving is
 * the one who started the install, and where to send them afterwards.
 *
 * This proves the first. It does not prove that the installation belongs to
 * them — nothing signed by us could — which is why the callback separately
 * checks the installation against the user's own list.
 */

export type InstallState = {
  userId: string;
  locale: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
};

/** An install is a few clicks. Beyond this the link is stale, not stolen. */
export const INSTALL_STATE_TTL_MS = 15 * 60_000;

export function signInstallState(
  state: Omit<InstallState, "exp">,
  secret: string,
  nowMs: number,
): string {
  const payload: InstallState = { ...state, exp: nowMs + INSTALL_STATE_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * The state, or null if it is not ours, was tampered with, or has expired.
 *
 * Null in every failure case on purpose: the caller's only correct response to
 * any of them is the same, and distinguishing them in a response would tell an
 * attacker which part they got wrong.
 */
export function verifyInstallState(
  value: string | null,
  secret: string,
  nowMs: number,
): InstallState | null {
  if (!value) return null;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!matches(sign(encoded, secret), signature)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<InstallState>;

    if (typeof payload.userId !== "string" || payload.userId === "") return null;
    if (typeof payload.locale !== "string") return null;
    if (typeof payload.exp !== "number" || payload.exp < nowMs) return null;

    return { userId: payload.userId, locale: payload.locale, exp: payload.exp };
  } catch {
    return null;
  }
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function matches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // the length of a signature is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
