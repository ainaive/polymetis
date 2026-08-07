import { afterEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  APP_JWT_TTL_SECONDS,
  createInstallationToken,
  InstallationTokens,
  listInstallationRepos,
  MAX_REPO_PAGES,
  normalizePrivateKey,
  signAppJwt,
  TOKEN_REFRESH_MARGIN_MS,
} from "./app";

// A real RSA key, generated once for the file: signing is the thing under test,
// so a fixture key would only prove the fixture parses.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credentials = { appId: "12345", privateKey };
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

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

async function fakeGithub(
  handler: (
    req: { url: string; method: string; auth: string | undefined },
  ) => { status: number; body: unknown },
): Promise<string> {
  server = createServer((req, res) => {
    const reply = handler({
      url: req.url ?? "",
      method: req.method ?? "GET",
      auth: req.headers.authorization,
    });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("normalizePrivateKey", () => {
  test("turns escaped newlines back into real ones", () => {
    // Multi-line values routinely arrive through env vars with literal \n, and
    // a key that still contains them fails to parse for reasons that say
    // nothing about the cause.
    const escaped = "-----BEGIN KEY-----\\nabc\\n-----END KEY-----";
    expect(normalizePrivateKey(escaped)).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
    );
  });

  test("leaves a real PEM alone apart from a trailing newline", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    expect(normalizePrivateKey(pem)).toBe(`${pem}\n`);
  });
});

describe("signAppJwt", () => {
  const jwt = signAppJwt(credentials, NOW);
  const [header, payload, signature] = jwt.split(".");

  test("is a three-segment RS256 token", () => {
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(signature).toBeTruthy();
  });

  test("verifies against the App's public key", () => {
    // The whole point: GitHub checks this signature, so a test that only
    // inspected the claims would prove nothing about whether it is valid.
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(true);
  });

  test("is issued by the App and expires inside GitHub's ten-minute limit", () => {
    const claims = decode(payload!);
    expect(claims.iss).toBe("12345");
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(600);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(APP_JWT_TTL_SECONDS + 60);
  });

  test("backdates iat so a slightly fast clock is not rejected", () => {
    const claims = decode(payload!);
    expect(Number(claims.iat)).toBe(Math.floor(NOW / 1000) - 60);
  });

  test("does not verify against a different key", () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).publicKey;

    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(other, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(false);
  });
});

describe("createInstallationToken", () => {
  test("exchanges the App JWT for an installation token", async () => {
    let seen: { url: string; method: string; auth: string | undefined } | null = null;
    const baseUrl = await fakeGithub((req) => {
      seen = req;
      return {
        status: 201,
        body: { token: "ghs_abc", expires_at: "2026-08-07T13:00:00Z" },
      };
    });

    const token = await createInstallationToken(credentials, "999", { nowMs: NOW, baseUrl });

    expect(token.token).toBe("ghs_abc");
    expect(token.expiresAt.toISOString()).toBe("2026-08-07T13:00:00.000Z");
    expect(seen!.url).toBe("/app/installations/999/access_tokens");
    expect(seen!.method).toBe("POST");
    expect(seen!.auth?.startsWith("Bearer ")).toBe(true);
  });

  test("explains a refusal as a possibly-removed installation", async () => {
    // The common cause is someone uninstalling the App, not a bug here.
    const baseUrl = await fakeGithub(() => ({ status: 404, body: {} }));
    await expect(
      createInstallationToken(credentials, "999", { nowMs: NOW, baseUrl }),
    ).rejects.toThrow(/may have been removed/);
  });
});

describe("listInstallationRepos", () => {
  test("returns the repositories the installation can see", async () => {
    const baseUrl = await fakeGithub(() => ({
      status: 200,
      body: {
        repositories: [
          { full_name: "o/public", private: false, default_branch: "main" },
          { full_name: "o/secret", private: true, default_branch: "trunk" },
        ],
      },
    }));

    expect(await listInstallationRepos("ghs_abc", { baseUrl })).toEqual([
      { fullName: "o/public", private: false, defaultBranch: "main" },
      { fullName: "o/secret", private: true, defaultBranch: "trunk" },
    ]);
  });

  test("walks every page", async () => {
    // An organization installation can hold far more than a hundred
    // repositories, and stopping at page 1 hides the rest with nothing to
    // indicate why.
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}` })),
      "2": Array.from({ length: 30 }, (_, i) => ({ full_name: `o/p${i}` })),
    };
    const seen: string[] = [];
    const baseUrl = await fakeGithub((req) => {
      const page = new URL(req.url, "http://x").searchParams.get("page") ?? "1";
      seen.push(page);
      return { status: 200, body: { repositories: pages[page] ?? [] } };
    });

    const repos = await listInstallationRepos("ghs_abc", { baseUrl });
    expect(repos).toHaveLength(130);
    // Stops on the short page rather than asking for one more.
    expect(seen).toEqual(["1", "2"]);
  });

  test("stops immediately when the first page is short", async () => {
    let calls = 0;
    const baseUrl = await fakeGithub(() => {
      calls++;
      return { status: 200, body: { repositories: [{ full_name: "o/r" }] } };
    });

    await listInstallationRepos("ghs_abc", { baseUrl });
    expect(calls).toBe(1);
  });

  test("skips entries without a name rather than failing the page", async () => {
    const baseUrl = await fakeGithub(() => ({
      status: 200,
      body: { repositories: [{ private: true }, { full_name: "o/r" }] },
    }));

    const repos = await listInstallationRepos("ghs_abc", { baseUrl });
    expect(repos).toHaveLength(1);
    expect(repos[0]!.defaultBranch).toBe("main");
  });
});

describe("InstallationTokens", () => {
  test("reuses a token that is still good", async () => {
    let minted = 0;
    const baseUrl = await fakeGithub(() => {
      minted++;
      return {
        status: 201,
        body: {
          token: `ghs_${minted}`,
          expires_at: new Date(NOW + 3_600_000).toISOString(),
        },
      };
    });

    const tokens = new InstallationTokens(credentials, { baseUrl });
    expect(await tokens.get("999", NOW)).toBe("ghs_1");
    expect(await tokens.get("999", NOW + 60_000)).toBe("ghs_1");
    expect(minted).toBe(1);
  });

  test("re-mints before expiry rather than at it", async () => {
    // A token that expires between being read and being used fails a clone
    // that had every reason to succeed, and the retry costs a whole run.
    let minted = 0;
    const baseUrl = await fakeGithub(() => {
      minted++;
      return {
        status: 201,
        body: {
          token: `ghs_${minted}`,
          expires_at: new Date(NOW + 3_600_000).toISOString(),
        },
      };
    });

    const tokens = new InstallationTokens(credentials, { baseUrl });
    await tokens.get("999", NOW);
    // Inside the margin: still valid, but not for long enough to rely on.
    await tokens.get("999", NOW + 3_600_000 - TOKEN_REFRESH_MARGIN_MS + 1);
    expect(minted).toBe(2);
  });

  test("keeps installations apart", async () => {
    const baseUrl = await fakeGithub((req) => ({
      status: 201,
      body: {
        token: `ghs_${req.url.split("/")[3]}`,
        expires_at: new Date(NOW + 3_600_000).toISOString(),
      },
    }));

    const tokens = new InstallationTokens(credentials, { baseUrl });
    expect(await tokens.get("111", NOW)).toBe("ghs_111");
    expect(await tokens.get("222", NOW)).toBe("ghs_222");
  });
});

describe("listInstallationRepos page bound", () => {
  test("gives up rather than looping forever on a server that never shortens", async () => {
    // A full page every time would otherwise be an unbounded loop against an
    // API that is also rate-limiting our clones.
    let calls = 0;
    const baseUrl = await fakeGithub(() => {
      calls++;
      return {
        status: 200,
        body: {
          repositories: Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}` })),
        },
      };
    });

    await listInstallationRepos("ghs_abc", { baseUrl });
    expect(calls).toBe(MAX_REPO_PAGES);
  }, 30_000);
});
