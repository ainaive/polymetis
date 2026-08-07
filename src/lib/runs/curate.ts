import { classifyRepoSource } from "@/lib/runner/workdir";

/**
 * Whether a run may be shown in the public gallery.
 *
 * The gallery is the product's whole argument: every template ships with a real
 * replay against a real repository. A run that cannot support that claim must
 * not appear beside ones that can, so the checks are here rather than in the
 * operator's head at promotion time.
 */

export type CurateCandidate = {
  runId: string;
  status: string;
  repo: string | null;
  hasArtifact: boolean;
  hasTerminalEvent: boolean;
};

export type CurateRefusal =
  | "not-succeeded"
  | "no-artifact"
  | "no-terminal-event"
  | "no-repo"
  | "not-reproducible";

export type CurateDecision =
  | { ok: true }
  | { ok: false; reason: CurateRefusal; detail: string };

export function canCurate(candidate: CurateCandidate): CurateDecision {
  if (candidate.status !== "succeeded") {
    return {
      ok: false,
      reason: "not-succeeded",
      detail: `status is ${candidate.status}`,
    };
  }

  if (!candidate.hasTerminalEvent) {
    // A replay with no run.end renders as though it is still going. Whatever
    // the run row says, the log is what a visitor watches.
    return {
      ok: false,
      reason: "no-terminal-event",
      detail: "the event log has no run.end",
    };
  }

  if (!candidate.hasArtifact) {
    // The deliverable is the output being advertised. A replay that produced
    // none demonstrates the opposite of the claim.
    return { ok: false, reason: "no-artifact", detail: "no stored deliverable" };
  }

  if (!candidate.repo) {
    return { ok: false, reason: "no-repo", detail: "the run records no repository" };
  }

  // A local path is reproducible only on the machine that ran it. "Run this on
  // your own repo" is the call to action beneath every card, so a demo pointing
  // at /tmp on a laptop is an invitation nobody can accept.
  try {
    const source = classifyRepoSource(candidate.repo);
    if (source.kind !== "clone") {
      return {
        ok: false,
        reason: "not-reproducible",
        detail: `${candidate.repo} is a local path`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "not-reproducible",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true };
}
