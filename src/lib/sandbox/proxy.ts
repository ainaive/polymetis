import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import {
  addUsage,
  EMPTY_USAGE,
  type ObservedUsage,
  totalTokens,
  UsageMeter,
} from "./usage-meter";

/**
 * The credential-injecting egress proxy (ADR-0003).
 *
 * The sandbox holds a placeholder token and points `ANTHROPIC_BASE_URL` here.
 * This process swaps in the real credential on the way out, so exfiltrating
 * anything from the container gains an attacker nothing — which is what keeps
 * ADR-0002's "no credential crosses into the container" true for the Anthropic
 * credential and not just the GitHub one.
 *
 * It is also the only place that can stop a runaway run. The agent's own usage
 * report arrives when the run ends; a prompt-injected agent looping on tool
 * calls would spend the whole budget before anyone saw it.
 */

export const UPSTREAM = "https://api.anthropic.com";

/**
 * How long upstream may go silent before the request is abandoned. Generous,
 * because extended thinking legitimately produces long gaps between frames.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** Header names that must never be forwarded upstream from the sandbox. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "connection",
]);

/**
 * Response headers we must not relay. Content encoding and length describe a
 * body we are re-framing, and the transfer/connection headers describe a
 * connection that ends at this process — forwarding them while Node frames its
 * own response can produce a body the client cannot parse.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

/** A per-run secret the sandbox presents. Not a credential — an authorization. */
export function newRunToken(): string {
  return `plm-${randomBytes(24).toString("base64url")}`;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type CredentialProxyConfig = {
  port: number;
  /** Real credential, held only in this process. */
  credential: { kind: "apiKey" | "authToken"; value: string };
  /**
   * The placeholder the sandbox was given. It doubles as this proxy's
   * authorization: without it the proxy is an open credential-injecting relay
   * to the Anthropic API for anything that can reach the port.
   */
  runToken: string;
  /** Ceiling across the whole run. Zero or below disables the breaker. */
  tokenCeiling: number;
  upstream?: string;
  /**
   * Abort an upstream request that goes quiet for this long. Idle rather than
   * total, because a healthy streamed response runs for minutes.
   */
  idleTimeoutMs?: number;
  /** Called whenever the running total changes, for progress and diagnostics. */
  onUsage?: (usage: ObservedUsage) => void;
};

export type CredentialProxy = {
  /** What the sandbox should use as ANTHROPIC_BASE_URL. */
  baseUrl: string;
  port: number;
  usage(): ObservedUsage;
  /** True once the ceiling tripped; the run should be settled as failed. */
  tripped(): boolean;
  stop(): Promise<void>;
};

/**
 * Rewrite the sandbox's request headers for upstream: drop the placeholder
 * credential and hop-by-hop headers, then attach the real one.
 */
export function buildUpstreamHeaders(
  incoming: NodeJS.Dict<string | string[]>,
  credential: CredentialProxyConfig["credential"],
): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  if (credential.kind === "apiKey") {
    headers.set("x-api-key", credential.value);
  } else {
    headers.set("authorization", `Bearer ${credential.value}`);
  }

  return headers;
}

/**
 * Resolve the sandbox's request-target against the upstream base, refusing
 * anything that would leave the upstream origin.
 *
 * `new URL(target, upstream)` treats the target as a *reference*, not a path,
 * and the very next thing this proxy does is attach the real credential. An
 * absolute-form request line (`GET http://elsewhere/x HTTP/1.1`, legal per
 * RFC 7230 section 5.3.2 and surfaced verbatim as `req.url`) or a
 * protocol-relative `//elsewhere/x` replaces the base outright, which turns the
 * proxy into a credential relay to any host the container names — and into an
 * SSRF pivot onto the worker's own network. The run-token check above cannot
 * catch it: anything executing in the container legitimately holds that token
 * and is using the credential path exactly as designed, only with a different
 * destination.
 *
 * The origin comparison is not redundant with the prefix test. WHATWG URL
 * treats `\` as `/` for special schemes, so `/\elsewhere/x` — which starts with
 * a single slash — still resolves to `https://elsewhere/x`.
 */
export function resolveUpstreamUrl(
  target: string | undefined,
  upstream: string,
): URL | null {
  if (!target || !target.startsWith("/")) return null;

  let resolved: URL;
  try {
    resolved = new URL(target, upstream);
  } catch {
    return null;
  }

  return resolved.origin === new URL(upstream).origin ? resolved : null;
}

export async function startCredentialProxy(
  config: CredentialProxyConfig,
): Promise<CredentialProxy> {
  const upstream = config.upstream ?? UPSTREAM;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let tripped = false;

  // A UsageMeter is a scanner over ONE response: it buffers partial SSE lines
  // and takes a high-water mark of each field, because a streamed response
  // re-sends its running totals. Sharing one across requests interleaves their
  // chunks into a single line buffer and collapses their high-water marks —
  // two responses of 200 and 50 tokens are counted as 200, and a chunk
  // boundary can destroy a frame outright. So: one meter per response, live
  // ones tracked, finished ones folded into `committed`.
  let committed: ObservedUsage = { ...EMPTY_USAGE };
  const active = new Set<UsageMeter>();

  /** Everything counted, including responses still streaming. */
  function currentTotal(): ObservedUsage {
    let total = committed;
    for (const meter of active) total = addUsage(total, meter.total);
    return total;
  }

  const server = createServer(async (req, res) => {
    try {
      // Authorize before anything else. The proxy has to listen where a
      // container can reach it, which is not loopback, so the port is exposed
      // to whatever else shares that network.
      const presented = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!tokenMatches(presented, config.runToken)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "permission_error", message: "Unrecognized run token." },
          }),
        );
        return;
      }

      if (tripped || overCeiling()) {
        tripped = true;
        // 429 rather than 402: the agent harness already knows how to stop on
        // a rate limit, and this is a limit even if it is ours.
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Polymetis run token ceiling reached.",
            },
          }),
        );
        return;
      }

      // Confine the target before reading a body or attaching a credential.
      const target = resolveUpstreamUrl(req.url, upstream);
      if (!target) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Request target must be a path on the upstream origin.",
            },
          }),
        );
        return;
      }

      const body = await readBody(req);

      // An idle timer rather than a deadline: a legitimate streamed response
      // runs for minutes, so a fixed timeout would kill healthy runs. This
      // aborts only when upstream goes quiet — covering both a stalled connect
      // and a stream that dies mid-body, either of which would otherwise hold
      // the sandbox's connection open with no error and no 502.
      const upstreamAbort = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => upstreamAbort.abort(), idleTimeoutMs);
      };
      resetIdle();

      const response = await fetch(target, {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, config.credential),
        // Buffer is a Uint8Array view; fetch accepts the view, not the Buffer type.
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        // Streaming responses must not be buffered whole before the agent
        // sees them, or the run appears to hang.
        redirect: "manual",
        signal: upstreamAbort.signal,
      });
      resetIdle();

      res.writeHead(
        response.status,
        Object.fromEntries(
          [...response.headers.entries()].filter(
            ([name]) => !STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()),
          ),
        ),
      );

      if (!response.body) {
        clearTimeout(idleTimer);
        res.end();
        return;
      }

      const meter = new UsageMeter();
      active.add(meter);
      try {
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          resetIdle();
          meter.push(decoder.decode(chunk, { stream: true }));
          config.onUsage?.(currentTotal());
          if (overCeiling()) tripped = true;
          res.write(chunk);
        }
        meter.end();
      } finally {
        clearTimeout(idleTimer);
        // Commit in a finally: a stream that throws mid-body would otherwise
        // leave its partial usage neither counted nor cleared, and the next
        // response would inherit it.
        committed = addUsage(committed, meter.total);
        active.delete(meter);
      }
      config.onUsage?.(currentTotal());
      res.end();
    } catch (error) {
      // Once the 200 and its headers are on the wire there is no way to turn
      // the response into a 502: writeHead would throw ERR_HTTP_HEADERS_SENT,
      // that error would escape this async handler as an unhandled rejection,
      // and the sandbox's request would never complete — the run hangs instead
      // of failing. All that is left is to close the truncated body and let
      // the client see a short read.
      if (res.headersSent) {
        res.end();
        return;
      }

      // A proxy failure must look like an upstream failure, not a hang.
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  });

  function overCeiling(): boolean {
    return config.tokenCeiling > 0 && totalTokens(currentTotal()) >= config.tokenCeiling;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Bind to all interfaces so a container reaching host-gateway can connect.
    server.listen(config.port, "0.0.0.0", resolve);
  });

  const port = addressPort(server) ?? config.port;

  return {
    // The container resolves this name via --add-host.
    baseUrl: `http://polymetis-proxy:${port}`,
    port,
    usage: currentTotal,
    tripped: () => tripped,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Run `fn` with a proxy alive, and always stop it.
 *
 * The lifecycle lives here rather than at each call site so the worker and the
 * one-shot runner cannot drift — a proxy that outlives its run is a credential
 * relay nobody is watching.
 */
export async function withCredentialProxy<T>(
  config: CredentialProxyConfig,
  fn: (proxy: CredentialProxy) => Promise<T>,
): Promise<T> {
  const proxy = await startCredentialProxy(config);
  try {
    return await fn(proxy);
  } finally {
    await proxy.stop();
  }
}

/**
 * Resolve the credential the proxy will inject.
 *
 * Docker mode needs a real API key. A Claude Code subscription credential is
 * held in the OS keychain, is short-lived, and cannot be read and forwarded —
 * so the sandboxed path genuinely requires ANTHROPIC_API_KEY, and should say so
 * at startup rather than failing as a connection error once the agent is
 * already running.
 */
export function resolveProxyCredential(
  apiKey: string | undefined,
): CredentialProxyConfig["credential"] {
  if (!apiKey) {
    throw new Error(
      "SANDBOX_MODE=docker requires ANTHROPIC_API_KEY: the sandbox reaches the API through a proxy that must hold a real credential, and a Claude Code subscription token cannot be forwarded from the keychain.",
    );
  }
  return { kind: "apiKey", value: apiKey };
}

function addressPort(server: Server): number | null {
  const address = server.address();
  return address && typeof address === "object" ? address.port : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
