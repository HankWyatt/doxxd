// @vitest-environment node
import { readFileSync } from "node:fs";
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

const HSTS = "max-age=31536000";

function expectSecured(response: Response) {
  for (const [name, value] of Object.entries(EXPECTED)) expect(response.headers.get(name)).toBe(value);
}

describe("securityHeaders", () => {
  it("is the fixed set, with no script-src", () => {
    expect(securityHeaders()).toEqual(EXPECTED);
    expect(securityHeaders()["Content-Security-Policy"]).not.toContain("script-src");
  });

  it("adds HSTS, without includeSubDomains or preload, only for HTTPS", () => {
    expect(securityHeaders({ https: true })).toEqual({ ...EXPECTED, "Strict-Transport-Security": HSTS });
    expect(securityHeaders({ https: false })).toEqual(EXPECTED);
    expect(securityHeaders({ https: true })["Strict-Transport-Security"]).toBe("max-age=31536000");
  });
});

// Static assets bypass the Worker; Workers assets apply public/_headers
// (copied to dist/client) to them instead. It must match the Worker's set.
describe("public/_headers", () => {
  function parseHeadersFile(text: string): Record<string, Record<string, string>> {
    const rules: Record<string, Record<string, string>> = {};
    let current: Record<string, string> | undefined;
    for (const line of text.split("\n")) {
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (!/^\s/.test(line)) {
        current = rules[line.trim()] = {};
        continue;
      }
      const colon = line.indexOf(":");
      expect(current, line).toBeDefined();
      expect(colon, line).toBeGreaterThan(0);
      current![line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return rules;
  }

  it("applies exactly the Worker's HTTPS security headers to every asset", () => {
    const text = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    expect(parseHeadersFile(text)).toEqual({ "/*": securityHeaders({ https: true }) });
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
    expect(response.headers.get("Strict-Transport-Security")).toBe(HSTS);
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

  it("sends HSTS over HTTPS only, so local http previews never get it", async () => {
    const { fetch } = wrap(() => new Response("ok"));
    const secure = await fetch(new Request("https://doxxd.test/"));
    expect(secure.headers.get("Strict-Transport-Security")).toBe(HSTS);
    const local = await fetch(new Request("http://127.0.0.1:4318/"));
    expectSecured(local);
    expect(local.headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("answers a plain, secured 500 when the handler throws or rejects, without the error text", async () => {
    const handlers = [
      () => {
        throw new Error("boom https://rpc.provider.test/?api-key=SECRET");
      },
      () => Promise.reject(new Error("boom https://rpc.provider.test/?api-key=SECRET")),
    ];
    for (const handler of handlers) {
      const fetch = withSecurityHeaders(handler as (request: Request) => Promise<Response>);
      const response = await fetch(new Request("https://doxxd.test/boom"));
      expect(response.status).toBe(500);
      expectSecured(response);
      expect(response.headers.get("Strict-Transport-Security")).toBe(HSTS);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const text = await response.text();
      expect(text).toBe("Internal Server Error");
    }
  });

  it("logs a crash's error name and path only: no message, stack or query", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fetch = withSecurityHeaders((): Response => {
        throw new TypeError("boom https://rpc.provider.test/?api-key=SECRET");
      });
      await fetch(new Request("https://doxxd.test/wallet/x?cursor=SECRET"));
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("worker error", { name: "TypeError", path: "/wallet/x" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
    } finally {
      log.mockRestore();
    }
  });

  it("secures error responses", async () => {
    const { fetch } = wrap(() => new Response("Internal Server Error", { status: 500 }));
    const response = await fetch(new Request("https://doxxd.test/boom"));
    expect(response.status).toBe(500);
    expectSecured(response);
  });
});
