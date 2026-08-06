import { createServer, type IncomingMessage, type Server } from "node:http";

import {
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

export type CredentialProxyConfig = {
  port: number;
  /** Real credential, held only in this process. */
  credential: { kind: "apiKey" | "authToken"; value: string };
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
  const meter = new UsageMeter();
  let tripped = false;

  const server = createServer(async (req, res) => {
    try {
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
            ([name]) => !["content-encoding", "content-length"].includes(name),
          ),
        ),
      );

      if (!response.body) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        meter.push(decoder.decode(chunk, { stream: true }));
        config.onUsage?.(meter.total);
        if (overCeiling()) tripped = true;
        res.write(chunk);
      }
      meter.end();
      config.onUsage?.(meter.total);
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
    return config.tokenCeiling > 0 && totalTokens(meter.total) >= config.tokenCeiling;
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
    usage: () => meter.total ?? EMPTY_USAGE,
    tripped: () => tripped,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
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
