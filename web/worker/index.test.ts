// @vitest-environment node
// The Worker entry: every response, including a crash, leaves secured.
import { afterEach, describe, expect, it, vi } from "vitest";

const inner = vi.hoisted(() => ({ fetch: vi.fn<(request: Request) => Promise<Response>>() }));
vi.mock("vinext/server/fetch-handler", () => ({ default: inner }));

import worker from "./index";

const call = (url: string) =>
  worker.fetch(new Request(url), {} as Cloudflare.Env, {} as Parameters<typeof worker.fetch>[2]);

describe("worker entry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("secures the renderer's responses", async () => {
    inner.fetch.mockResolvedValueOnce(new Response("<p>ok</p>", { headers: { "content-type": "text/html" } }));
    const response = await call("https://doxxd.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(await response.text()).toBe("<p>ok</p>");
  });

  it("answers a secured plain 500 when the renderer throws, without the error text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    inner.fetch.mockRejectedValueOnce(new Error("renderer exploded at /internal/path"));
    const response = await call("https://doxxd.test/wallet/x");
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(await response.text()).toBe("Internal Server Error");
  });

  it("leaves HSTS off a plain-http local request", async () => {
    inner.fetch.mockResolvedValueOnce(new Response("ok"));
    const response = await call("http://127.0.0.1:4318/");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.has("Strict-Transport-Security")).toBe(false);
  });
});
