/**
 * Who may read a run.
 *
 * One pure predicate, because the replay page and the SSE stream both answer
 * this question about the same run — and if they answer differently, one of
 * them is a way around the other. M3a shipped with neither enforcing it, which
 * was defensible only while no run had an owner.
 */

export type RunAccess = {
  visibility: "private" | "unlisted" | "public";
  /** Null for runs created outside a session, such as by the CLI scripts. */
  workspaceId: string | null;
};

export type Viewer = {
  /** The workspace the signed-in person acts in, or null when signed out. */
  workspaceId: string | null;
};

export function canViewRun(run: RunAccess, viewer: Viewer): boolean {
  switch (run.visibility) {
    case "public":
      return true;

    case "unlisted":
      // Shareable by link and not guessable: the run id is 24 random
      // characters, which is the access control. This is what makes a replay
      // URL something you can paste into a review, and it is what the CLI
      // scripts create — an operator has no session to be a member of.
      return true;

    case "private":
      // Fail closed. A private run with no workspace is one nothing can prove
      // ownership of, so nothing may read it: the alternative is that
      // "private" silently means "public to anyone holding the id", which is
      // the weaker of the two guarantees and the one nobody expects.
      return (
        run.workspaceId !== null &&
        viewer.workspaceId !== null &&
        viewer.workspaceId === run.workspaceId
      );
  }
}
