import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { fetchIssue, issueText, MAX_ISSUE_BYTES } from "./issue";

const ref = { owner: "o", name: "r", number: 7 };

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const s = server;
  server = undefined;
  await new Promise<void>((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  });
});

/** A stand-in for the GitHub REST API, so these tests need no network. */
async function fakeGithub(
  handler: (path: string, headers: Record<string, string | string[] | undefined>) => {
    status: number;
    body: unknown;
  },
): Promise<string> {
  server = createServer((req, res) => {
    const reply = handler(req.url ?? "", req.headers);
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("issueText", () => {
  test("puts the title above the body, as the prompt expects", () => {
    expect(issueText("Support X", "Some body.")).toBe("Title: Support X\n\nSome body.");
  });

  test("does not leave trailing whitespace when the body is empty", () => {
    expect(issueText("Support X", "")).toBe("Title: Support X");
  });
});

describe("fetchIssue", () => {
  test("returns the title and body", async () => {
    const baseUrl = await fakeGithub(() => ({
      status: 200,
      body: { title: "Support X", body: "Some body." },
    }));

    const issue = await fetchIssue(ref, { baseUrl });
    expect(issue.title).toBe("Support X");
    expect(issue.text).toBe("Title: Support X\n\nSome body.");
    expect(issue.truncated).toBe(false);
  });

  test("requests the right issue and identifies itself", async () => {
    let seenPath = "";
    let seenAuth: unknown;
    const baseUrl = await fakeGithub((path, headers) => {
      seenPath = path;
      seenAuth = headers.authorization;
      return { status: 200, body: { title: "t", body: "b" } };
    });

    await fetchIssue(ref, { baseUrl });
    expect(seenPath).toBe("/repos/o/r/issues/7");
    // No token for a public repository: sending one we do not have would be
    // the only reason this could fail.
    expect(seenAuth).toBeUndefined();
  });

  test("sends an installation token when given one", async () => {
    let seenAuth: unknown;
    const baseUrl = await fakeGithub((_path, headers) => {
      seenAuth = headers.authorization;
      return { status: 200, body: { title: "t", body: "b" } };
    });

    await fetchIssue(ref, { baseUrl, token: "ghs_installation" });
    expect(seenAuth).toBe("Bearer ghs_installation");
  });

  test("explains a 404 as missing or inaccessible, which is what it means", async () => {
    // GitHub returns 404 rather than 403 for a private repository you cannot
    // see, so repeating the status would send someone looking for a typo.
    const baseUrl = await fakeGithub(() => ({ status: 404, body: {} }));

    await expect(fetchIssue(ref, { baseUrl })).rejects.toThrow(
      /not found, or is private/,
    );
  });

  test("surfaces other failures with their status", async () => {
    const baseUrl = await fakeGithub(() => ({ status: 503, body: {} }));
    await expect(fetchIssue(ref, { baseUrl })).rejects.toThrow(/503/);
  });

  test("truncates an issue that would dominate the prompt", async () => {
    const baseUrl = await fakeGithub(() => ({
      status: 200,
      body: { title: "Logs", body: "x".repeat(MAX_ISSUE_BYTES * 2) },
    }));

    const issue = await fetchIssue(ref, { baseUrl });
    expect(issue.truncated).toBe(true);
    expect(issue.text).toContain("[issue truncated]");
    expect(Buffer.byteLength(issue.text, "utf8")).toBeLessThan(MAX_ISSUE_BYTES + 100);
  });

  test("truncates without splitting a character", async () => {
    // Cutting bytes blindly leaves half a code point, which decodes to U+FFFD
    // and would be carried into the prompt.
    const baseUrl = await fakeGithub(() => ({
      status: 200,
      body: { title: "T", body: "。".repeat(MAX_ISSUE_BYTES) },
    }));

    const issue = await fetchIssue(ref, { baseUrl });
    expect(issue.truncated).toBe(true);
    expect(issue.text).not.toContain("�");
  });

  test("tolerates an issue with no body", async () => {
    const baseUrl = await fakeGithub(() => ({ status: 200, body: { title: "T" } }));
    const issue = await fetchIssue(ref, { baseUrl });
    expect(issue.text).toBe("Title: T");
  });
});
