// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as rpcGet, POST as rpcPost } from "@/app/api/rpc/route";
import { securityHeaders, withSecurityHeaders } from "./security-headers";

const FIXED = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const CSP_BASE = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

function expectSecured(response: Response, nonce: string) {
  for (const [name, value] of Object.entries(FIXED)) expect(response.headers.get(name)).toBe(value);
  expect(response.headers.get("Content-Security-Policy")).toBe(
    `${CSP_BASE}; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
  );
}

const nonceOf = (response: Response) =>
  /'nonce-([^']+)'/.exec(response.headers.get("Content-Security-Policy") ?? "")?.[1] ?? "";

describe("securityHeaders", () => {
  it("is the fixed set without a nonce", () => {
    expect(securityHeaders()).toEqual({ ...FIXED, "Content-Security-Policy": CSP_BASE });
  });

  it("adds a nonce-based script-src when given a nonce", () => {
    expect(securityHeaders({ scriptNonce: "abc" })["Content-Security-Policy"]).toBe(
      `${CSP_BASE}; script-src 'self' 'nonce-abc' 'strict-dynamic'`,
    );
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

  it("secures an HTML page and hands the renderer the same nonce", async () => {
    const { fetch, seen } = wrap(
      () => new Response("<!doctype html><p>hi</p>", { headers: { "content-type": "text/html" } }),
    );
    const response = await fetch(new Request("https://doxxd.test/wallet/x"));
    const nonce = nonceOf(response);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expectSecured(response, nonce);
    // vinext reads the nonce from the request's CSP header and puts it on its
    // inline hydration scripts.
    expect(seen[0].headers.get("Content-Security-Policy")).toBe(response.headers.get("Content-Security-Policy"));
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<!doctype html><p>hi</p>");
  });

  it("uses a fresh nonce per request and ignores a nonce the client sent", async () => {
    const { fetch, seen } = wrap(() => new Response("ok"));
    const forged = "Content-Security-Policy";
    const a = await fetch(new Request("https://doxxd.test/", { headers: { [forged]: "script-src 'nonce-evil'" } }));
    const b = await fetch(new Request("https://doxxd.test/"));
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    expect(seen[0].headers.get(forged)).not.toContain("evil");
  });

  it("secures a JSON API response and keeps its own headers", async () => {
    const { fetch } = wrap(() =>
      Response.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store" } }),
    );
    const response = await fetch(new Request("https://doxxd.test/api/wallet/x/summary"));
    expectSecured(response, nonceOf(response));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("secures responses whose headers are immutable (redirects)", async () => {
    const { fetch } = wrap(() => Response.redirect("https://doxxd.test/wallet/y", 307));
    const response = await fetch(new Request("https://doxxd.test/wallet/x"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://doxxd.test/wallet/y");
    expectSecured(response, nonceOf(response));
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
      expectSecured(response, nonceOf(response));
    }
  });

  it("secures error responses", async () => {
    const { fetch } = wrap(() => new Response("Internal Server Error", { status: 500 }));
    const response = await fetch(new Request("https://doxxd.test/boom"));
    expect(response.status).toBe(500);
    expectSecured(response, nonceOf(response));
  });
});
