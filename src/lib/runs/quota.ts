/**
 * What a workspace is allowed to start.
 *
 * `RUN_TOKEN_CEILING` bounds a single run; nothing bounded a person until now.
 * The moment anyone can sign up and press a button, that is unbounded spend —
 * so this lands in the same change that opens the door.
 */

export type QuotaInput = {
  usedTokens: number;
  allowanceTokens: number;
  /** Runs queued or running, which have settled no tokens yet. */
  inFlight: number;
  maxConcurrent: number;
};

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: "allowance" | "concurrency" };

export function checkQuota(input: QuotaInput): QuotaDecision {
  // Concurrency first, and it is not a nicety. Usage is summed from *settled*
  // runs, so a run that is still going contributes nothing — without this cap
  // a workspace can start twenty runs in the time it takes one to finish and
  // exceed the month's allowance many times over before any of it is counted.
  if (input.inFlight >= input.maxConcurrent) {
    return { allowed: false, reason: "concurrency" };
  }

  // An allowance of zero means unmetered, matching how RUN_TOKEN_CEILING treats
  // zero. Anything else is a real ceiling.
  if (input.allowanceTokens > 0 && input.usedTokens >= input.allowanceTokens) {
    return { allowed: false, reason: "allowance" };
  }

  return { allowed: true };
}
