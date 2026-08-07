import type { IssueRef } from "@/lib/templates/contract";

/**
 * Fetch an issue's text on the host, before the sandbox starts.
 *
 * The agent cannot do this itself: egress is default-deny and the only allowed
 * destination is the model API (ADR-0002). The driver's own option says the
 * issue arrives "already fetched host-side" — this is the thing that fetches
 * it.
 */

export const GITHUB_API = "https://api.github.com";

/**
 * Bound on the issue text we will carry into a prompt.
 *
 * An issue with a megabyte of pasted logs is not a specification input, and it
 * would be paid for on every cached turn of the run.
 */
export const MAX_ISSUE_BYTES = 64_000;

export type FetchedIssue = {
  title: string;
  body: string;
  /** Title and body together, in the shape the prompt expects. */
  text: string;
  truncated: boolean;
};

export type FetchIssueOptions = {
  /** An installation token, for private repositories. Public needs none. */
  token?: string;
  timeoutMs?: number;
  baseUrl?: string;
};

export function issueText(title: string, body: string): string {
  // Matches the shape scripts/run-once.ts has always used for its sample, so a
  // run driven from the browser and one driven from the CLI give the agent the
  // same thing.
  return `Title: ${title}\n\n${body}`.trim();
}

export async function fetchIssue(
  ref: IssueRef,
  options: FetchIssueOptions = {},
): Promise<FetchedIssue> {
  const { token, timeoutMs = 15_000, baseUrl = GITHUB_API } = options;
  const url = `${baseUrl}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/issues/${ref.number}`;

  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "polymetis",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    // A queue worker must not hang on GitHub being slow; the run fails with a
    // reason instead.
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    // 404 covers both "no such issue" and "private, and we cannot see it",
    // because that is what GitHub returns to an unauthorized reader. Saying so
    // is more useful than repeating the status.
    if (response.status === 404) {
      throw new Error(
        `issue ${ref.owner}/${ref.name}#${ref.number} was not found, or is private and this workspace has no access to it`,
      );
    }
    throw new Error(
      `GitHub returned ${response.status} for ${ref.owner}/${ref.name}#${ref.number}`,
    );
  }

  const payload = (await response.json()) as { title?: unknown; body?: unknown };
  const title = typeof payload.title === "string" ? payload.title : "";
  const rawBody = typeof payload.body === "string" ? payload.body : "";

  const full = issueText(title, rawBody);
  const truncated = Buffer.byteLength(full, "utf8") > MAX_ISSUE_BYTES;

  return {
    title,
    body: rawBody,
    text: truncated ? truncate(full, MAX_ISSUE_BYTES) : full,
    truncated,
  };
}

/**
 * Cut to a byte budget without splitting a character.
 *
 * Slicing by string index would overshoot on any non-ASCII issue, and slicing
 * bytes blindly can leave half a code point that then fails to encode.
 */
function truncate(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8").subarray(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(encoded);
  // The replacement character is what a split code point decodes to; dropping
  // it is tidier than leaving U+FFFD at the end of a prompt.
  return `${decoded.replace(/�+$/, "")}\n\n[issue truncated]`;
}
