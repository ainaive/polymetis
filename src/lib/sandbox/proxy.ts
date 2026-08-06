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

export async function startCredentialProxy(
  config: CredentialProxyConfig,
): Promise<CredentialProxy> {
  const upstream = config.upstream ?? UPSTREAM;
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

      const body = await readBody(req);
      const response = await fetch(new URL(req.url ?? "/", upstream), {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, config.credential),
        // Buffer is a Uint8Array view; fetch accepts the view, not the Buffer type.
        body: body.length > 0 ? new Uint8Array(body) : undefined,
        // Streaming responses must not be buffered whole before the agent
        // sees them, or the run appears to hang.
        redirect: "manual",
      });

      res.writeHead(
        response.status,
        Object.fromEntries(
          [...response.headers.entries()].filter(
            ([name]) => !STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()),
          ),
        ),
      );

      if (!response.body) {
        res.end();
        return;
      }

      const meter = new UsageMeter();
      active.add(meter);
      try {
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          meter.push(decoder.decode(chunk, { stream: true }));
          config.onUsage?.(currentTotal());
          if (overCeiling()) tripped = true;
          res.write(chunk);
        }
        meter.end();
      } finally {
        // Commit in a finally: a stream that throws mid-body would otherwise
        // leave its partial usage neither counted nor cleared, and the next
        // response would inherit it.
        committed = addUsage(committed, meter.total);
        active.delete(meter);
      }
      config.onUsage?.(currentTotal());
      res.end();
    } catch (error) {
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
