// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimGrant } from "../../scripts/run-dmnd.mjs";
import { boundedProxyHandler, startAcceptanceProxy } from "../../scripts/acceptance-proxy.mjs";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const wallet = "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa";
const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true });
});
function grant(budget = 2) {
  const dir = mkdtempSync(join(tmpdir(), "doxxd-proxy-test-"));
  paths.push(dir);
  const path = join(dir, "grant.json");
  claimGrant(path, budget);
  return path;
}
const config = (grantPath: string) => ({
  grantPath,
  target: "http://127.0.0.1:54321",
  token: "synthetic-proxy-token",
});
const request = (resource = "summary") =>
  new Request("http://127.0.0.1:4317/api/wallet/" + wallet + "/" + resource);
it("shares persisted reservations across Worker reloads and refuses exhaustion", async () => {
  const path = grant(1);
  let calls = 0;
  const network = async () => {
    calls++;
    return Response.json({ ok: false, kind: "unavailable" }, { status: 503 });
  };
  const first = boundedProxyHandler(config(path), network);
  expect((await first(request())).status).toBe(503);
  const afterReload = boundedProxyHandler(config(path), network);
  expect((await afterReload(request())).status).toBe(422);
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(path, "utf8")).usedRequests).toBe(1);
});
it("serializes all wallet requests and enforces the approved page size", async () => {
  const path = grant();
  let active = 0;
  let peak = 0;
  const network = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("http://127.0.0.1:54321");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(new Headers(init.headers).get("x-doxxd-acceptance-token")).toBe(
      "synthetic-proxy-token",
    );
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return Response.json({
      ok: true,
      data: {
        wallet,
        data: [],
        has_more: false,
        coverage: { complete_since_slot: false },
      },
    });
  };
  const handle = boundedProxyHandler(config(path), network);
  const replies = await Promise.all([
    handle(request("transactions")),
    handle(request("activity")),
  ]);
  expect(replies.map((r) => r.status)).toEqual([200, 200]);
  expect(peak).toBe(1);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  expect(receipt.usedRequests).toBe(2);
  expect(receipt.requests.map((r: any) => r.status)).toEqual([200, 200]);
  expect(JSON.stringify(receipt)).not.toContain("synthetic-proxy-token");
});
it("fails closed for unknown wallets, write methods, redirects and malformed grants", async () => {
  const path = grant();
  let calls = 0;
  const handle = boundedProxyHandler(config(path), async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://remote.invalid/?api_key=synthetic-secret" },
    });
  });
  const wrong = new Request(
    "http://127.0.0.1:4317/api/wallet/11111111111111111111111111111111/summary",
  );
  expect((await handle(wrong)).status).toBe(403);
  expect(await (await handle(wrong.clone())).json()).toEqual({
    ok: false,
    kind: "not_enabled",
    scope: "wallet",
  });
  expect(calls).toBe(0);
  expect(
    (await handle(new Request(request().url, { method: "POST" }))).status,
  ).toBe(405);
  const redirect = await handle(request());
  expect(redirect.status).toBe(502);
  expect(redirect.headers.has("location")).toBe(false);
  expect(calls).toBe(1);
  const missing = boundedProxyHandler(config(path + "-missing"), async () => {
    calls++;
    return Response.json({});
  });
  expect((await missing(request())).status).toBe(422);
  expect(calls).toBe(1);
});
it("answers a protocol read the validation proxy does not serve as not enabled, not unavailable", async () => {
  const path = grant();
  let calls = 0;
  const handle = boundedProxyHandler(config(path), async () => {
    calls++;
    return Response.json({});
  });
  const response = await handle(request("kamino"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, kind: "not_enabled" });
  expect(calls).toBe(0);
});
it("reserves before a failed attempt and does not retry or release it", async () => {
  const path = grant(1);
  let calls = 0;
  const handle = boundedProxyHandler(config(path), async () => {
    calls++;
    throw new Error("synthetic-secret");
  });
  expect((await handle(request())).status).toBe(502);
  expect((await handle(request())).status).toBe(422);
  expect(calls).toBe(1);
  expect(readFileSync(path, "utf8")).not.toContain("synthetic-secret");
});
it("keeps non-API paths on the internal Worker instead of interpreting a network-path URL", async () => {
  const path = grant();
  let destination = "";
  const handle = boundedProxyHandler(config(path), async (input: string) => {
    destination = input;
    return new Response("page");
  });
  await handle(
    new Request(
      "http://127.0.0.1:4317//api.dmnd.dev/api/v1/wallets/anything/overview",
    ),
  );
  expect(new URL(destination).origin).toBe("http://127.0.0.1:54321");
});

it("forwards decoded HTML without stale compression or byte-count headers", async () => {
  const html = "<html><body>" + "read-only portfolio ".repeat(100) + "</body></html>";
  const zipped = gzipSync(html);
  const worker = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html", "content-encoding": "gzip",
      "content-length": String(zipped.length),
    });
    res.end(zipped);
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const target = "http://127.0.0.1:" + (worker.address() as any).port;
  const proxy = await startAcceptanceProxy({ ...config(grant()), target, port: 0 });
  try {
    const response = await fetch("http://127.0.0.1:" + (proxy.address() as any).port + "/demo");
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(await response.text()).toBe(html);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
  }
});
