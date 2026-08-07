import { createSign } from "node:crypto";

import { GITHUB_API } from "./issue";

/**
 * GitHub App authentication.
 *
 * ADR-0002 chose an App over OAuth scopes: GitHub's classic `repo` scope grants
 * *write* to every private repository, which contradicts v1 being read-only. An
 * App asks for `contents: read` on the repositories a person selects, and the
 * token it yields is short-lived and scoped to that installation — so there is
 * no long-lived repository credential at rest anywhere.
 *
 * Signed here with node:crypto rather than a JWT dependency. RS256 over two
 * base64url segments is a dozen lines, and a dependency that only ever signs
 * one claim set is a dependency to keep patched for no benefit.
 */

export type AppCredentials = {
  appId: string;
  /** PEM private key from the App's settings page. */
  privateKey: string;
};

/** GitHub rejects a JWT with `exp` more than 10 minutes out. */
export const APP_JWT_TTL_SECONDS = 540;

/**
 * Re-mint an installation token this long before it expires.
 *
 * A token that expires between being read and being used fails a clone that
 * had every reason to succeed, and the retry costs a whole run.
 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Normalize a PEM that arrived through an environment variable.
 *
 * Multi-line values are routinely stored with literal `\n`, and a key that
 * still contains them fails to parse with an error that says nothing about the
 * cause.
 */
export function normalizePrivateKey(value: string): string {
  const unescaped = value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  return unescaped.trim().concat("\n");
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A JWT proving we are the App. Valid for minutes, and only ever exchanged for
 * an installation token — it grants nothing on a repository by itself.
 */
export function signAppJwt(credentials: AppCredentials, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      // Backdated by a minute: GitHub rejects a token issued in the future, and
      // a host clock a few seconds fast is common enough to design around.
      iat: issuedAt - 60,
      exp: issuedAt + APP_JWT_TTL_SECONDS,
      iss: credentials.appId,
    }),
  );

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(normalizePrivateKey(credentials.privateKey), "base64url");

  return `${header}.${payload}.${signature}`;
}

export type InstallationToken = {
  token: string;
  expiresAt: Date;
};

export type InstallationRepo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
};

/**
 * Mint a token for one installation.
 *
 * Not stored. It lives about an hour, and writing it to the database would
 * recreate exactly the long-lived repository credential the App was chosen to
 * avoid.
 */
export async function createInstallationToken(
  credentials: AppCredentials,
  installationId: string,
  options: { nowMs?: number; baseUrl?: string } = {},
): Promise<InstallationToken> {
  const { nowMs = Date.now(), baseUrl = GITHUB_API } = options;

  const response = await fetch(
    `${baseUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "polymetis",
        authorization: `Bearer ${signAppJwt(credentials, nowMs)}`,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub refused an installation token for ${installationId} (${response.status}). The installation may have been removed.`,
    );
  }

  const payload = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof payload.token !== "string") {
    throw new Error("GitHub returned no installation token");
  }

  return {
    token: payload.token,
    expiresAt:
      typeof payload.expires_at === "string"
        ? new Date(payload.expires_at)
        : new Date(nowMs + 3_600_000),
  };
}

/** Pages to walk before giving up. 100 per page, so 5,000 repositories. */
export const MAX_REPO_PAGES = 50;

/**
 * Repositories the installation can see, for the picker.
 *
 * Paginated: an installation on an organization can hold far more than a
 * hundred repositories, and stopping at the first page silently hides the rest
 * — the person sees a picker that simply lacks the repository they wanted, with
 * nothing to indicate why.
 */
export async function listInstallationRepos(
  token: string,
  options: { baseUrl?: string } = {},
): Promise<InstallationRepo[]> {
  const { baseUrl = GITHUB_API } = options;
  const all: InstallationRepo[] = [];

  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const response = await fetch(
      `${baseUrl}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "polymetis",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} listing installation repos`);
    }

    const payload = (await response.json()) as { repositories?: unknown };
    if (!Array.isArray(payload.repositories)) break;

    for (const repo of payload.repositories) {
      const entry = repo as {
        full_name?: unknown;
        private?: unknown;
        default_branch?: unknown;
      };
      if (typeof entry.full_name !== "string") continue;
      all.push({
        fullName: entry.full_name,
        private: entry.private === true,
        defaultBranch:
          typeof entry.default_branch === "string" ? entry.default_branch : "main",
      });
    }

    // A short page is the last page. Stopping on it avoids one extra request
    // per listing, which matters against a rate limit shared with the clones.
    if (payload.repositories.length < 100) break;
  }

  return all;
}

/**
 * A token cache keyed by installation.
 *
 * The worker clones several runs from one installation, and minting a token per
 * clone spends a round trip and a rate-limit slot on something valid for
 * another fifty minutes.
 */
export class InstallationTokens {
  private readonly cache = new Map<string, InstallationToken>();

  constructor(
    private readonly credentials: AppCredentials,
    private readonly options: { baseUrl?: string } = {},
  ) {}

  async get(installationId: string, nowMs = Date.now()): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt.getTime() - nowMs > TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    const minted = await createInstallationToken(this.credentials, installationId, {
      nowMs,
      ...this.options,
    });
    this.cache.set(installationId, minted);
    return minted.token;
  }
}

/**
 * Exchange the OAuth code GitHub sends during installation for a user token.
 *
 * Requires "Request user authorization (OAuth) during installation" on the App.
 * Without it the callback has no way to tell whose installation it is looking
 * at, which is the difference between connecting an account and taking one over.
 */
export async function exchangeUserCode(
  clientId: string,
  clientSecret: string,
  code: string,
  options: { baseUrl?: string } = {},
): Promise<string> {
  const baseUrl = options.baseUrl ?? "https://github.com";

  const response = await fetch(`${baseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "polymetis",
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub refused the authorization code (${response.status})`);
  }

  const payload = (await response.json()) as { access_token?: unknown; error?: unknown };
  if (typeof payload.access_token !== "string") {
    throw new Error(
      `GitHub returned no access token${typeof payload.error === "string" ? `: ${payload.error}` : ""}`,
    );
  }

  return payload.access_token;
}

/**
 * Whether this *user* can administer this installation.
 *
 * The check the callback actually needs. Minting an installation token proves
 * only that the installation exists and our App is on it — it succeeds for
 * every installation of the App, including other people's. `/user/installations`
 * is scoped to the token's own user, so it answers the question that matters.
 */
export async function userCanAccessInstallation(
  userToken: string,
  installationId: string,
  options: { baseUrl?: string } = {},
): Promise<boolean> {
  const baseUrl = options.baseUrl ?? GITHUB_API;

  const response = await fetch(`${baseUrl}/user/installations?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "polymetis",
      authorization: `Bearer ${userToken}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return false;

  const payload = (await response.json()) as { installations?: { id?: unknown }[] };
  if (!Array.isArray(payload.installations)) return false;

  return payload.installations.some((entry) => String(entry?.id) === installationId);
}
