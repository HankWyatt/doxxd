// @vitest-environment node
import { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

// Run web3.js's browser build, which is what visitors' browsers load. It
// builds the same requests, and skips node-fetch, whose punycode import
// prints a deprecation warning under Node 22.
vi.mock("@solana/web3.js", () => {
  const browserBuild = "@solana/web3.js/lib/index.browser.esm.js";
  return import(/* @vite-ignore */ browserBuild);
});
import { handleRpc } from "./passthrough.server";
import { createRateLimiter } from "./rate-limit";

const ORIGIN = "https://doxxd.test";
const URL_ = `${ORIGIN}/api/rpc`;
// A stub upstream whose URL carries a key, as a paid provider's would.
const UPSTREAM = "https://rpc.provider.test/v1/?api-key=SECRET";
const LEAKS = ["SECRET", "rpc.provider.test", "api-key"];
const ID = "5f0c2a2e-0000-4000-8000-000000000001";
const slotRequest = { jsonrpc: "2.0", id: ID, method: "getSlot", params: [] };

type Upstream = (input: string, init: RequestInit) => Promise<Response>;

// An upstream answer to the request in `init`, echoing its id as a JSON-RPC
// server does (the pass-through sends its own id, not the client's).
const answer = (init: RequestInit, body: Record<string, unknown>) =>
  Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, ...body });

function setup(upstream?: Upstream, enabled = true, upstreamUrl = UPSTREAM) {
  const fetch = vi.fn<Upstream>(upstream ?? (async (_input, init) => answer(init, { result: 42 })));
  const limiter = createRateLimiter({ windowMs: 60_000, general: 120, send: 20 });
  const env = {
    enabled,
    upstream: upstreamUrl,
    fetch: fetch as unknown as typeof globalThis.fetch,
    limiter,
  };
  return { env, fetch, limiter };
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

async function call(request: Request, env: Parameters<typeof handleRpc>[1]) {
  const response = await handleRpc(request, env);
  const text = await response.text();
  expect(response.headers.get("cache-control")).toBe("no-store");
  for (const leak of LEAKS) expect(text).not.toContain(leak);
  for (const [, value] of response.headers)
    for (const leak of LEAKS) expect(value).not.toContain(leak);
  return { response, text, json: () => JSON.parse(text) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handleRpc", () => {
  it("returns 404 when actions are disabled", async () => {
    const { env, fetch } = setup(undefined, false);
    const { response } = await call(post(slotRequest), env);
    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const get = await call(new Request(URL_), env);
    expect(get.response.status).toBe(404);
  });

  it("returns 405 for anything but POST", async () => {
    const { env, fetch } = setup();
    const { response } = await call(new Request(URL_), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 413 for a body over 64 KiB, declared or streamed", async () => {
    const { env, fetch } = setup();
    const big = JSON.stringify({ ...slotRequest, pad: "x".repeat(64 * 1024) });
    expect((await call(post(big), env)).response.status).toBe(413);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 70; i++) controller.enqueue(encoder.encode("x".repeat(1024)));
        controller.close();
      },
    });
    const streamed = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await call(streamed, env)).response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-JSON content type", async () => {
    const { env, fetch } = setup();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "", "application/jsonx"]) {
      const { response } = await call(post(slotRequest, { "content-type": type }), env);
      expect(response.status).toBe(415);
    }
    const ok = await call(
      post(slotRequest, { "content-type": "application/json; charset=utf-8" }),
      env,
    );
    expect(ok.response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns 403 for an Origin that differs from the request URL origin", async () => {
    const { env, fetch } = setup();
    for (const origin of ["https://evil.test", "null", "http://doxxd.test", "https://doxxd.test:8443"]) {
      const { response } = await call(post(slotRequest, { origin }), env);
      expect(response.status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
    const noOrigin = new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slotRequest),
    });
    expect((await call(noOrigin, env)).response.status).toBe(200);
  });

  it("rejects invalid JSON and policy violations with 400 and does not forward", async () => {
    const { env, fetch } = setup();
    const parse = await call(post("{not json"), env);
    expect(parse.response.status).toBe(400);
    expect(parse.json().error.code).toBe(-32700);
    const batch = await call(post([slotRequest]), env);
    expect(batch.response.status).toBe(400);
    expect(batch.json().error.code).toBe(-32600);
    const airdrop = await call(
      post({ ...slotRequest, method: "requestAirdrop", params: [] }),
      env,
    );
    expect(airdrop.response.status).toBe(400);
    expect(airdrop.json()).toMatchObject({ jsonrpc: "2.0", id: ID, error: { code: -32601 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards allowed requests with only content-type: application/json", async () => {
    const { env, fetch } = setup();
    const { response, json } = await call(
      post(slotRequest, {
        cookie: "session=abc",
        authorization: "Bearer abc",
        "x-forwarded-for": "203.0.113.9",
        "cf-connecting-ip": "203.0.113.9",
        "solana-client": "js/1.99.0",
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(json()).toEqual({ jsonrpc: "2.0", id: ID, result: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    expect(input).toBe(UPSTREAM);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers)).toEqual(
      new Headers({ "content-type": "application/json" }),
    );
    expect([...new Headers(init.headers).keys()]).toEqual(["content-type"]);
    const { id: upstreamId, ...forwarded } = JSON.parse(String(init.body));
    expect(forwarded).toEqual({ jsonrpc: "2.0", method: "getSlot", params: [] });
    expect(upstreamId).not.toBe(ID);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("manual");
  });

  it("never returns the upstream URL or an upstream error body", async () => {
    const leakyBody = `upstream failure at ${UPSTREAM} key SECRET`;
    const cases: Upstream[] = [
      async () => new Response(leakyBody, { status: 500 }),
      async () => new Response(leakyBody, { status: 401 }),
      async () => new Response(leakyBody, { status: 403 }),
      async () => new Response(leakyBody, { status: 200 }),
      async () => new Response(leakyBody, { status: 302, headers: { location: UPSTREAM } }),
      async (_input, init) =>
        answer(init, { error: { code: -32000, message: `bad api-key=SECRET for ${UPSTREAM}` } }),
      async (_input, init) => answer(init, { result: UPSTREAM }),
      async () => Response.json({ jsonrpc: "2.0", id: "other", result: 1 }),
      // The client's own id is not the one the pass-through sent.
      async () => Response.json({ jsonrpc: "2.0", id: ID, result: 1 }),
      async (_input, init) => answer(init, {}),
      async () => {
        throw new TypeError(`fetch failed: ${UPSTREAM}`);
      },
    ];
    for (const upstream of cases) {
      const { env } = setup(upstream);
      const { response } = await call(post(slotRequest), env);
      expect(response.status).toBe(502);
    }
  });

  it("does not treat query parameter names as secrets, only their values (#12)", async () => {
    // Synthetic provider URLs: a Helius-style ?api-key= and a ?token= whose
    // name shows up in ordinary program logs.
    const cases = [
      { url: "https://rpc.example.test/?api-key=SYNTHETIC-KEY-1", name: "api-key", value: "SYNTHETIC-KEY-1" },
      { url: "https://rpc.example.test/v2?token=SYNTHETIC-TOKEN-2", name: "token", value: "SYNTHETIC-TOKEN-2" },
    ];
    for (const { url, name, value } of cases) {
      const logs = [`Program log: Instruction: Transfer ${name}`, "Program log: token account closed"];
      const { env } = setup(async (_input, init) => answer(init, { result: { logs } }), true, url);
      const ok = await handleRpc(post(slotRequest), env);
      expect(ok.status, name).toBe(200);
      expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: ID, result: { logs } });

      const leaky = setup(
        async (_input, init) => answer(init, { result: { logs: [`Program log: ${value}`] } }),
        true,
        url,
      );
      const refused = await handleRpc(post(slotRequest), leaky.env);
      expect(refused.status, name).toBe(502);
      expect(await refused.text()).not.toContain(value);
    }
  });

  it("scans a bare query parameter name, which can be the key itself (#12)", async () => {
    const url = "https://rpc.example.test/?SYNTHETICBAREKEY9&cluster=mainnet";
    const { env } = setup(
      async (_input, init) => answer(init, { result: { logs: ["Program log: SYNTHETICBAREKEY9"] } }),
      true,
      url,
    );
    const response = await handleRpc(post(slotRequest), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SYNTHETICBAREKEY9");
    // A named parameter's name is still not a secret.
    const named = setup(
      async (_input, init) => answer(init, { result: { logs: ["Program log: cluster"] } }),
      true,
      url,
    );
    expect((await handleRpc(post(slotRequest), named.env)).status).toBe(200);
  });

  it("scans the JSON-escaped form of a secret with quotes or backslashes (#12)", async () => {
    // The key is SYN"TH\ETIC: re-serialised, it reads SYN\"TH\\ETIC.
    const url = "https://rpc.example.test/?api-key=SYN%22TH%5CETIC";
    const { env } = setup(
      async (_input, init) => answer(init, { result: { logs: ['Program log: SYN"TH\\ETIC'] } }),
      true,
      url,
    );
    const response = await handleRpc(post(slotRequest), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("ETIC");
  });

  it("scans the re-serialised reply, so a \\u-escaped secret cannot slip through (#12)", async () => {
    const escape = (text: string) =>
      [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    for (const secret of ["SECRET", "rpc.provider.test"]) {
      const { env } = setup(
        async () =>
          new Response(`{"jsonrpc":"2.0","id":1,"result":{"logs":["Program log: ${escape(secret)}"]}}`, {
            status: 200,
          }),
      );
      const { response } = await call(post(slotRequest), env);
      expect(response.status, secret).toBe(502);
    }
    const { env } = setup(
      async () =>
        new Response(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"${escape("SECRET")}"}}`, {
          status: 200,
        }),
    );
    expect((await call(post(slotRequest), env)).response.status).toBe(502);
  });

  it("answers a reply of exactly 2 MiB and refuses one byte more (#12)", async () => {
    const CAP = 2 * 1024 * 1024;
    const sized = (bytes: number) => {
      const prefix = '{"jsonrpc":"2.0","id":1,"result":"';
      const suffix = '"}';
      return prefix + "A".repeat(bytes - prefix.length - suffix.length) + suffix;
    };
    // Streamed in 64 KiB chunks, as a provider would send it.
    const streamed = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) return controller.close();
          controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
          offset += 64 * 1024;
        },
      });
    };
    const atCap = setup(async () => new Response(streamed(sized(CAP)), { status: 200 }));
    const ok = await call(post(slotRequest), atCap.env);
    expect(ok.response.status).toBe(200);
    expect(ok.json().result).toMatch(/^A+$/);

    const overCap = setup(async () => new Response(streamed(sized(CAP + 1)), { status: 200 }));
    expect((await call(post(slotRequest), overCap.env)).response.status).toBe(502);
  });

  it("stops reading an endless reply at the cap and cancels it (#12)", async () => {
    let pulled = 0;
    let cancelled = false;
    const { env } = setup(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(64 * 1024).fill(0x41));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const { response } = await call(post(slotRequest), env);
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
    // 2 MiB is 32 chunks; the 33rd crosses the cap (plus the stream's own read-ahead).
    expect(pulled).toBeLessThanOrEqual(34);
  });

  it("passes JSON-RPC errors from the node through (preflight logs)", async () => {
    const error = {
      code: -32002,
      message: "Transaction simulation failed",
      data: { logs: ["Program log: synthetic"] },
    };
    const { env } = setup(async (_input, init) => answer(init, { error }));
    const { response, json } = await call(post(slotRequest), env);
    expect(response.status).toBe(200);
    expect(json()).toEqual({ jsonrpc: "2.0", id: ID, error });
  });

  it("does not follow upstream redirects: any 3xx is a 502 (T2 R-005)", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { env, fetch } = setup(
        async () => new Response(null, { status, headers: { location: "https://elsewhere.test/" } }),
      );
      const { response } = await call(post(slotRequest), env);
      expect(response.status, String(status)).toBe(502);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    }
  });

  it("forwards with its own id and answers with the client's, so ids cannot probe the upstream (S-R004)", async () => {
    const { env, fetch } = setup();
    // As a probe would: guess parts of the upstream URL as ids. Each gets the
    // same answer, its own id back, and none reaches the upstream.
    for (const guess of ["rpc.provider.test", "rpc.other.test", "api-key", "apikey", 7]) {
      const response = await handleRpc(post({ ...slotRequest, id: guess }), env);
      expect(response.status, String(guess)).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: guess, result: 42 });
    }
    const sent = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)).id);
    expect(new Set(sent).size).toBe(1);
    expect(["rpc.provider.test", "rpc.other.test", "api-key", "apikey", 7]).not.toContain(sent[0]);
  });

  it("maps upstream 429 to 429 with retry-after", async () => {
    const withHeader = setup(
      async () => new Response("slow down SECRET", { status: 429, headers: { "retry-after": "7" } }),
    );
    const a = await call(post(slotRequest), withHeader.env);
    expect(a.response.status).toBe(429);
    expect(a.response.headers.get("retry-after")).toBe("7");
    const without = setup(async () => new Response("slow down", { status: 429 }));
    const b = await call(post(slotRequest), without.env);
    expect(b.response.status).toBe(429);
    expect(Number(b.response.headers.get("retry-after"))).toBeGreaterThan(0);
    const odd = setup(
      async () => new Response("", { status: 429, headers: { "retry-after": "soon SECRET" } }),
    );
    const c = await call(post(slotRequest), odd.env);
    expect(Number(c.response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("returns 504 when the upstream does not answer within 10 s", async () => {
    vi.useFakeTimers();
    const { env, fetch } = setup(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException(`aborted ${UPSTREAM}`, "AbortError")),
          );
        }),
    );
    const pending = handleRpc(post(slotRequest), env);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    vi.useRealTimers();
    expect(response.status).toBe(504);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("SECRET");
  });

  it("returns 504 when the upstream body stalls past 10 s", async () => {
    vi.useFakeTimers();
    const { env } = setup(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"jsonrpc":'));
              init.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 200 },
        ),
    );
    const pending = handleRpc(post(slotRequest), env);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    vi.useRealTimers();
    expect(response.status).toBe(504);
  });

  it("rate-limits per cf-connecting-ip, or one 'local' bucket without it", async () => {
    const { env, fetch } = setup();
    env.limiter = createRateLimiter({ windowMs: 60_000, general: 2, send: 1 });
    const from = (ip?: string) => post(slotRequest, ip ? { "cf-connecting-ip": ip } : {});
    expect((await call(from("198.51.100.1"), env)).response.status).toBe(200);
    expect((await call(from("198.51.100.1"), env)).response.status).toBe(200);
    const limited = await call(from("198.51.100.1"), env);
    expect(limited.response.status).toBe(429);
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(from("198.51.100.2"), env)).response.status).toBe(200);
    expect((await call(from(), env)).response.status).toBe(200);
    expect((await call(from(), env)).response.status).toBe(200);
    expect((await call(from(), env)).response.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("rate-limits IPv6 clients per /64 (S-R002)", async () => {
    const { env } = setup();
    env.limiter = createRateLimiter({ windowMs: 60_000, general: 2, send: 1 });
    const from = (ip: string) => post(slotRequest, { "cf-connecting-ip": ip });
    expect((await call(from("2001:db8:1:2::1"), env)).response.status).toBe(200);
    expect((await call(from("2001:db8:1:2::2"), env)).response.status).toBe(200);
    expect((await call(from("2001:db8:1:2:ffff::9"), env)).response.status).toBe(429);
    expect((await call(from("2001:db8:1:3::1"), env)).response.status).toBe(200);
  });

  it("serves web3.js Connection end to end", async () => {
    const { env, fetch } = setup(async (_input, init) => {
      const { id } = JSON.parse(String(init.body));
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          context: { slot: 1 },
          value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 150 },
        },
      });
    });
    const connection = new Connection(URL_, {
      commitment: "confirmed",
      fetch: (async (input: string, init: RequestInit) =>
        handleRpc(
          new Request(input, {
            ...init,
            headers: { ...(init.headers as Record<string, string>), origin: ORIGIN },
          }),
          env,
        )) as unknown as typeof globalThis.fetch,
    });
    await expect(connection.getLatestBlockhash()).resolves.toEqual({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 150,
    });
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toMatchObject({
      method: "getLatestBlockhash",
      params: [{ commitment: "confirmed" }],
    });
  });
});
