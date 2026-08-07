import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";

import {
  buildUpstreamHeaders,
  newRunToken,
  resolveProxyCredential,
  resolveUpstreamUrl,
  startCredentialProxy,
  withCredentialProxy,
  type CredentialProxy,
} from "./proxy";

/**
 * Runs the proxy against a fake upstream on localhost. No network, no
 * credentials, no Docker — but it exercises the parts that matter: what
 * reaches upstream, and whether the breaker actually stops traffic.
 */

type Recorded = { headers: Record<string, string | string[] | undefined>; body: string };

async function fakeUpstream(
  respond: (recorded: Recorded) => { status?: number; body: string; sse?: boolean },
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded = { headers: req.headers, body: Buffer.concat(chunks).toString() };
    requests.push(recorded);

    const reply = respond(recorded);
    res.writeHead(reply.status ?? 200, {
      "content-type": reply.sse ? "text/event-stream" : "application/json",
    });
    res.end(reply.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Write a request to the proxy socket verbatim and return its status code.
 * `fetch` normalizes the request line, so anything that tests how the proxy
 * parses that line has to bypass it.
 */
function rawRequest(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let received = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(received);
      if (!match) return reject(new Error(`no status line in: ${received.slice(0, 200)}`));
      resolve(Number(match[1]));
    });
  });
}

const RUN_TOKEN = newRunToken();

let proxy: CredentialProxy | undefined;
let upstreamClose: (() => Promise<void>) | undefined;

afterEach(async () => {
  await proxy?.stop();
  await upstreamClose?.();
  proxy = undefined;
  upstreamClose = undefined;
});

/** The proxy advertises a container-resolvable hostname; tests dial localhost. */
const local = (p: CredentialProxy) => `http://127.0.0.1:${p.port}`;

const sseBody = (...frames: object[]) =>
  frames.map((f) => `event: x\ndata: ${JSON.stringify(f)}\n\n`).join("");

describe("buildUpstreamHeaders", () => {
  test("replaces the sandbox's placeholder credential with the real one", () => {
    const headers = buildUpstreamHeaders(
      { authorization: "Bearer sk-placeholder", "content-type": "application/json" },
      { kind: "apiKey", value: "sk-ant-real" },
    );
    expect(headers.get("x-api-key")).toBe("sk-ant-real");
    // The placeholder must not survive alongside it.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("strips a forged x-api-key from the sandbox", () => {
    const headers = buildUpstreamHeaders(
      { "x-api-key": "sk-attacker-supplied" },
      { kind: "authToken", value: "oat-real" },
    );
    expect(headers.get("authorization")).toBe("Bearer oat-real");
    expect(headers.get("x-api-key")).toBeNull();
  });

  test("drops hop-by-hop headers that would confuse upstream", () => {
    const headers = buildUpstreamHeaders(
      { host: "polymetis-proxy:7777", "content-length": "12", connection: "keep-alive" },
      { kind: "apiKey", value: "k" },
    );
    expect(headers.get("host")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("connection")).toBeNull();
  });
});

describe("withCredentialProxy", () => {
  const config = () => ({
    port: 0,
    credential: { kind: "apiKey" as const, value: "k" },
    runToken: RUN_TOKEN,
    tokenCeiling: 0,
    upstream: "http://127.0.0.1:1",
  });

  const isListening = async (port: number) => {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        signal: AbortSignal.timeout(500),
      });
      return true;
    } catch {
      return false;
    }
  };

  test("stops the proxy after the run completes", async () => {
    let port = 0;
    await withCredentialProxy(config(), async (p) => {
      port = p.port;
      expect(await isListening(port)).toBe(true);
    });
    expect(await isListening(port)).toBe(false);
  });

  test("stops the proxy even when the run throws", async () => {
    // A proxy that outlives its run is a credential relay nobody is watching.
    let port = 0;
    await expect(
      withCredentialProxy(config(), async (p) => {
        port = p.port;
        throw new Error("run blew up");
      }),
    ).rejects.toThrow("run blew up");
    expect(await isListening(port)).toBe(false);
  });
});

describe("resolveProxyCredential", () => {
  test("refuses docker mode without an API key, and says why", () => {
    // A subscription credential lives in the keychain and cannot be forwarded,
    // so this must fail at startup rather than as a connection error once the
    // agent is already running.
    expect(() => resolveProxyCredential(undefined)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => resolveProxyCredential("")).toThrow(/cannot be forwarded/);
  });

  test("uses a supplied key as an api key credential", () => {
    expect(resolveProxyCredential("sk-ant-x")).toEqual({
      kind: "apiKey",
      value: "sk-ant-x",
    });
  });
});

describe("authorization", () => {
  test("a request without the run token is refused and never reaches upstream", async () => {
    // The proxy must listen where a container can reach it, which is not
    // loopback. Without this check it is an open credential-injecting relay to
    // the Anthropic API for anything sharing that network.
    const upstream = await fakeUpstream(() => ({ body: "{}" }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  test("a request with the wrong token is refused", async () => {
    const upstream = await fakeUpstream(() => ({ body: "{}" }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer plm-not-the-right-token" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  test("run tokens are unguessable and distinct", () => {
    const a = newRunToken();
    const b = newRunToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });
});

describe("resolveUpstreamUrl", () => {
  const UP = "https://api.anthropic.com";

  test("accepts an ordinary origin-form path", () => {
    expect(resolveUpstreamUrl("/v1/messages", UP)?.href).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  test("keeps the query string", () => {
    expect(resolveUpstreamUrl("/v1/models?limit=2", UP)?.href).toBe(
      "https://api.anthropic.com/v1/models?limit=2",
    );
  });

  test("dot segments cannot climb off the origin", () => {
    // They resolve, but they stay on the upstream host, which is all we require.
    expect(resolveUpstreamUrl("/v1/../../x", UP)?.origin).toBe(UP);
  });

  // Each of these resolves to a DIFFERENT origin under `new URL(target, base)`,
  // which is what the unfixed proxy fed straight into fetch() with the real
  // credential attached. Verified against the WHATWG parser, not assumed.
  test.each([
    ["absolute-form request line", "http://evil.tld/steal"],
    ["absolute-form, https", "https://evil.tld/steal"],
    ["protocol-relative", "//evil.tld/steal"],
    ["three slashes", "///evil.tld/steal"],
    // WHATWG URL treats a backslash as a slash for special schemes, so this
    // starts with a single "/" and still escapes. A prefix test alone misses it.
    ["backslash authority", "/\\evil.tld/steal"],
    ["mixed slash authority", "/\\/evil.tld/steal"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
  ])("refuses %s", (_label, target) => {
    expect(resolveUpstreamUrl(target, UP)).toBeNull();
  });

  test("refuses a target that is not a path at all", () => {
    expect(resolveUpstreamUrl("v1/messages", UP)).toBeNull();
    expect(resolveUpstreamUrl("", UP)).toBeNull();
    expect(resolveUpstreamUrl(undefined, UP)).toBeNull();
  });
});

describe("upstream confinement", () => {
  /**
   * The attacker-controlled destination. A real second server rather than an
   * unroutable name: asserting it recorded nothing is what proves the
   * credential did not leave, which "the fake upstream saw nothing" cannot.
   */
  let sinkClose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await sinkClose?.();
    sinkClose = undefined;
  });

  test("a protocol-relative target is refused and reaches neither host", async () => {
    const sink = await fakeUpstream(() => ({ body: '{"stolen":true}' }));
    sinkClose = sink.close;
    const upstream = await fakeUpstream(() => ({ body: "{}" }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    // Bun's fetch collapses a leading "//" in the path to "/", so this shape
    // cannot be produced through fetch — it has to go on the wire by hand,
    // which is precisely what a process inside the container would do.
    const host = sink.url.replace(/^http:\/\//, "");
    const status = await rawRequest(
      proxy.port,
      [
        `GET //${host}/steal HTTP/1.1`,
        `Host: 127.0.0.1:${proxy.port}`,
        `Authorization: Bearer ${RUN_TOKEN}`,
        "Connection: close",
      ].join("\r\n") + "\r\n\r\n",
    );

    expect(status).toBe(400);
    expect(sink.requests).toHaveLength(0);
    expect(upstream.requests).toHaveLength(0);
  });

  test("an absolute-form request line is refused and reaches neither host", async () => {
    const sink = await fakeUpstream(() => ({ body: '{"stolen":true}' }));
    sinkClose = sink.close;
    const upstream = await fakeUpstream(() => ({ body: "{}" }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    // fetch() cannot emit an absolute-form request line, and it is exactly what
    // a process inside the container would write to the socket by hand.
    const status = await rawRequest(
      proxy.port,
      [
        `GET ${sink.url}/steal HTTP/1.1`,
        `Host: 127.0.0.1:${proxy.port}`,
        `Authorization: Bearer ${RUN_TOKEN}`,
        "Connection: close",
      ].join("\r\n") + "\r\n\r\n",
    );

    expect(status).toBe(400);
    expect(sink.requests).toHaveLength(0);
    expect(upstream.requests).toHaveLength(0);
  });

  test("a legitimate path still reaches upstream with the credential", async () => {
    // The confinement must not have closed the door it exists to keep open.
    const upstream = await fakeUpstream(() => ({ body: '{"ok":true}' }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.headers["x-api-key"]).toBe("sk-ant-real");
  });
});

describe("the proxy end to end", () => {
  test("injects the credential and forwards the body upstream", async () => {
    const upstream = await fakeUpstream(() => ({ body: JSON.stringify({ ok: true }) }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5" }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].headers["x-api-key"]).toBe("sk-ant-real");
    expect(upstream.requests[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(upstream.requests[0].body).model).toBe("claude-opus-5");
  });

  test("counts tokens from a streamed response", async () => {
    const upstream = await fakeUpstream(() => ({
      sse: true,
      body: sseBody(
        { type: "message_start", message: { usage: { input_tokens: 100 } } },
        { type: "message_delta", usage: { output_tokens: 250 } },
      ),
    }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${RUN_TOKEN}` }, body: "{}" }).then((r) =>
      r.text(),
    );

    expect(proxy.usage().inputTokens).toBe(100);
    expect(proxy.usage().outputTokens).toBe(250);
  });

  test("passes the response body through unchanged", async () => {
    const body = sseBody({ type: "message_delta", usage: { output_tokens: 3 } });
    const upstream = await fakeUpstream(() => ({ sse: true, body }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const received = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
    }).then((r) => r.text());
    // Metering must observe without altering: the agent has to see exactly
    // what upstream sent.
    expect(received).toBe(body);
  });

  test("trips the breaker once the ceiling is reached and stops traffic", async () => {
    const upstream = await fakeUpstream(() => ({
      sse: true,
      body: sseBody({ type: "message_delta", usage: { output_tokens: 60 } }),
    }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 100,
      upstream: upstream.url,
    });

    // First two requests total 120 tokens, crossing the ceiling.
    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${RUN_TOKEN}` }, body: "{}" }).then((r) =>
      r.text(),
    );
    expect(proxy.tripped()).toBe(false);
    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${RUN_TOKEN}` }, body: "{}" }).then((r) =>
      r.text(),
    );
    expect(proxy.tripped()).toBe(true);

    const refused = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
    });
    expect(refused.status).toBe(429);
    // The refused request must never have reached upstream — that is the whole
    // point of a breaker.
    expect(upstream.requests).toHaveLength(2);
  });

  test("concurrent responses are counted separately, not collapsed", async () => {
    // The bug this replaces: one UsageMeter shared by every request. A meter
    // buffers partial SSE lines and takes a high-water mark per field, because
    // a stream re-sends its running totals — so two overlapping responses of
    // 200 and 50 tokens were counted as 200, and a chunk boundary could
    // destroy a frame outright.
    //
    // Reproducing it needs the two responses to genuinely overlap. A small
    // body arrives in a single chunk, so push() and end() happen atomically
    // per request and the meters never interleave — an earlier version of this
    // test passed against the buggy code for exactly that reason. So the
    // upstream here dribbles each frame out in pieces with the event loop
    // yielding in between.
    const slowUpstream: Server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const tokens = JSON.parse(Buffer.concat(chunks).toString()).tokens as number;
      const body = sseBody({ type: "message_delta", usage: { output_tokens: tokens } });

      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < body.length; i += 12) {
        res.write(body.slice(i, i + 12));
        await new Promise((r) => setTimeout(r, 5));
      }
      res.end();
    });
    await new Promise<void>((r) => slowUpstream.listen(0, "127.0.0.1", r));
    const addr = slowUpstream.address();
    const upstreamPort = addr && typeof addr === "object" ? addr.port : 0;
    upstreamClose = () =>
      new Promise<void>((r) => {
        slowUpstream.closeAllConnections?.();
        slowUpstream.close(() => r());
      });

    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });

    await Promise.all(
      [200, 50].map((tokens) =>
        fetch(`${local(proxy!)}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${RUN_TOKEN}` },
          body: JSON.stringify({ tokens }),
        }).then((r) => r.text()),
      ),
    );

    expect(proxy.usage().outputTokens).toBe(250);
  });

  test("a response destroyed mid-stream still completes and does not leak", async () => {
    // An earlier version of this test called res.end(body) on both branches,
    // so nothing was ever truncated and it asserted nothing. The first
    // response now writes a partial frame and destroys the socket, which is
    // what a real mid-stream failure looks like.
    let first = true;
    const flaky: Server = createServer(async (req, res) => {
      for await (const _ of req) void _;
      const complete = sseBody({ type: "message_delta", usage: { output_tokens: 70 } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (first) {
        first = false;
        res.write(sseBody({ type: "message_delta", usage: { output_tokens: 30 } }).slice(0, 25));
        res.socket?.destroy();
        return;
      }
      res.end(complete);
    });
    await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
    const addr = flaky.address();
    const flakyPort = addr && typeof addr === "object" ? addr.port : 0;
    upstreamClose = () =>
      new Promise<void>((r) => {
        flaky.closeAllConnections?.();
        flaky.close(() => r());
      });

    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: `http://127.0.0.1:${flakyPort}`,
    });

    // The truncated response must not hang the caller. Before the headers-sent
    // guard, the catch tried a second writeHead, threw ERR_HTTP_HEADERS_SENT
    // out of the async handler, and the request never completed.
    await expect(
      fetch(`${local(proxy)}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${RUN_TOKEN}` },
        body: "{}",
        signal: AbortSignal.timeout(4_000),
      }).then((r) => r.text()),
    ).resolves.toBeDefined();

    await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
    }).then((r) => r.text());

    // The second response's own 70 is counted, and nothing from the truncated
    // first response was carried into it.
    expect(proxy.usage().outputTokens).toBe(70);
  }, 15_000);

  test("a stalled upstream is abandoned rather than held open", async () => {
    // Sends headers, then nothing. Without an idle timeout the proxy holds the
    // sandbox's connection open with no error and no 502, and the run stops
    // with no explanation.
    const stalled: Server = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Never write, never end.
    });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", r));
    const addr = stalled.address();
    const stalledPort = addr && typeof addr === "object" ? addr.port : 0;
    upstreamClose = () =>
      new Promise<void>((r) => {
        stalled.closeAllConnections?.();
        stalled.close(() => r());
      });

    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: `http://127.0.0.1:${stalledPort}`,
      idleTimeoutMs: 300,
    });

    const started = Date.now();
    await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.text());

    expect(Date.now() - started).toBeLessThan(4_000);
  }, 15_000);

  test("a ceiling of zero disables the breaker rather than refusing everything", async () => {
    const upstream = await fakeUpstream(() => ({
      sse: true,
      body: sseBody({ type: "message_delta", usage: { output_tokens: 10_000 } }),
    }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${RUN_TOKEN}` }, body: "{}" }).then((r) =>
      r.text(),
    );
    expect(proxy.tripped()).toBe(false);
    expect((await fetch(`${local(proxy)}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${RUN_TOKEN}` }, body: "{}" })).status).toBe(
      200,
    );
  });

  test("an upstream failure surfaces as an error rather than a hang", async () => {
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      // Nothing is listening here.
      upstream: "http://127.0.0.1:1",
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.type).toBe("api_error");
  });

  test("preserves the upstream status code", async () => {
    const upstream = await fakeUpstream(() => ({
      status: 400,
      body: JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }),
    }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      runToken: RUN_TOKEN,
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});
