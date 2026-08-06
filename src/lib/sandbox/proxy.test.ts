import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { buildUpstreamHeaders, startCredentialProxy, type CredentialProxy } from "./proxy";

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

describe("the proxy end to end", () => {
  test("injects the credential and forwards the body upstream", async () => {
    const upstream = await fakeUpstream(() => ({ body: JSON.stringify({ ok: true }) }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "sk-ant-real" },
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer sk-placeholder", "content-type": "application/json" },
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
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
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
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const received = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
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
      tokenCeiling: 100,
      upstream: upstream.url,
    });

    // First two requests total 120 tokens, crossing the ceiling.
    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
      r.text(),
    );
    expect(proxy.tripped()).toBe(false);
    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
      r.text(),
    );
    expect(proxy.tripped()).toBe(true);

    const refused = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
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
      tokenCeiling: 0,
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });

    await Promise.all(
      [200, 50].map((tokens) =>
        fetch(`${local(proxy!)}/v1/messages`, {
          method: "POST",
          body: JSON.stringify({ tokens }),
        }).then((r) => r.text()),
      ),
    );

    expect(proxy.usage().outputTokens).toBe(250);
  });

  test("a response that fails mid-stream does not leak into the next count", async () => {
    let failNext = true;
    const upstream = await fakeUpstream(() => {
      if (failNext) {
        failNext = false;
        // Declare more than we send, then end: the client sees a truncated body.
        return { sse: true, body: sseBody({ type: "message_delta", usage: { output_tokens: 30 } }) };
      }
      return { sse: true, body: sseBody({ type: "message_delta", usage: { output_tokens: 70 } }) };
    });
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
      r.text(),
    );
    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
      r.text(),
    );

    // 30 then 70 — each response's own count, neither inherited nor dropped.
    expect(proxy.usage().outputTokens).toBe(100);
  });

  test("a ceiling of zero disables the breaker rather than refusing everything", async () => {
    const upstream = await fakeUpstream(() => ({
      sse: true,
      body: sseBody({ type: "message_delta", usage: { output_tokens: 10_000 } }),
    }));
    upstreamClose = upstream.close;
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" }).then((r) =>
      r.text(),
    );
    expect(proxy.tripped()).toBe(false);
    expect((await fetch(`${local(proxy)}/v1/messages`, { method: "POST", body: "{}" })).status).toBe(
      200,
    );
  });

  test("an upstream failure surfaces as an error rather than a hang", async () => {
    proxy = await startCredentialProxy({
      port: 0,
      credential: { kind: "apiKey", value: "k" },
      tokenCeiling: 0,
      // Nothing is listening here.
      upstream: "http://127.0.0.1:1",
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
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
      tokenCeiling: 0,
      upstream: upstream.url,
    });

    const response = await fetch(`${local(proxy)}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});
