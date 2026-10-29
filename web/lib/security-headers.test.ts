// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as rpcGet, POST as rpcPost } from "@/app/api/rpc/route";
import { securityHeaders, withSecurityHeaders } from "./security-headers";

const EXPECTED = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
};

function expectSecured(response: Response) {
  for (const [name, value] of Object.entries(EXPECTED)) expect(response.headers.get(name)).toBe(value);
}

describe("securityHeaders", () => {
  it("is the fixed set, with no script-src", () => {
    expect(securityHeaders()).toEqual(EXPECTED);
    expect(securityHeaders()["Content-Security-Policy"]).not.toContain("script-src");
  });
});

describe("withSecurityHeaders", () => {
  afterEach(() => vi.unstubAllEnvs());

  const wrap = (respond: (request: Request) => Response | Promise<Response>) => {
    const seen: Request[] = [];
    const fetch = withSecurityHeaders((request: Request) => {
      seen.push(request);
      return respond(request);
    });
    return { fetch, seen };
  };

  it("secures an HTML page and keeps its body and headers", async () => {
    const { fetch } = wrap(
      () => new Response("<!doctype html><p>hi</p>", { headers: { "content-type": "text/html" } }),
    );
    const response = await fetch(new Request("https://doxxd.test/wallet/x"));
    expectSecured(response);
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<!doctype html><p>hi</p>");
  });

  it("strips client-sent CSP request headers before the renderer sees them", async () => {
    const { fetch, seen } = wrap(() => new Response("ok"));
    await fetch(
      new Request("https://doxxd.test/", {
        headers: {
          "Content-Security-Policy": "script-src 'nonce-<evil>'",
          "Content-Security-Policy-Report-Only": "script-src 'nonce-abc'",
          "x-other": "kept",
        },
      }),
    );
    expect(seen[0].headers.has("Content-Security-Policy")).toBe(false);
    expect(seen[0].headers.has("Content-Security-Policy-Report-Only")).toBe(false);
    expect(seen[0].headers.get("x-other")).toBe("kept");
  });

  it("passes a POST body through after stripping", async () => {
    const { fetch } = wrap(async (request) => new Response(await request.text()));
    const response = await fetch(
      new Request("https://doxxd.test/api/rpc", {
        method: "POST",
        headers: { "Content-Security-Policy": "script-src 'nonce-x'" },
        body: "payload",
      }),
    );
    expect(await response.text()).toBe("payload");
  });

  it("secures a JSON API response and keeps its own headers", async () => {
    const { fetch } = wrap(() =>
      Response.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store" } }),
    );
    const response = await fetch(new Request("https://doxxd.test/api/wallet/x/summary"));
    expectSecured(response);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("secures responses whose headers are immutable (redirects)", async () => {
    const { fetch } = wrap(() => Response.redirect("https://doxxd.test/wallet/y", 307));
    const response = await fetch(new Request("https://doxxd.test/wallet/x"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://doxxd.test/wallet/y");
    expectSecured(response);
  });

  it("secures the /api/rpc 404 when actions are off", async () => {
    vi.stubEnv("DOXXD_ACTIONS_ENABLED", "");
    for (const route of [rpcGet, rpcPost]) {
      const { fetch } = wrap((request) => route(request));
      const response = await fetch(
        new Request("https://doxxd.test/api/rpc", {
          method: route === rpcPost ? "POST" : "GET",
          ...(route === rpcPost ? { body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' } : {}),
        }),
      );
      expect(response.status).toBe(404);
      expectSecured(response);
    }
  });

  it("secures error responses", async () => {
    const { fetch } = wrap(() => new Response("Internal Server Error", { status: 500 }));
    const response = await fetch(new Request("https://doxxd.test/boom"));
    expect(response.status).toBe(500);
    expectSecured(response);
  });
});
