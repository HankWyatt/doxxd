// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadNewAddressProfile, claimNewAddressGrant, reserveNewAddressRequest,
  completeNewAddressRequest, assertNewAddressRehearsal } from "../../scripts/new-address-profile.mjs";
import { boundedProxyHandler } from "../../scripts/acceptance-proxy.mjs";
import { claimNativeStakeGrant } from "../../scripts/native-stake-profile.mjs";
import { runtimeConfiguration } from "../../scripts/run-dmnd.mjs";

const wallet = "aLqXroJ6z41nDQ9zEmqj5mPU86DJ1LXfABfAKxFzDS2";
const scopeFile = new URL("../../tests/fixtures/dmnd-new-address-scope-20261025.json", import.meta.url).pathname;
const nativeScopeFile = new URL("../../tests/fixtures/dmnd-native-stake-scope-20261025.json", import.meta.url).pathname;
const directories: string[] = [];
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "doxxd-new-address-scope-")); directories.push(dir);
  const qualified = JSON.parse(readFileSync(nativeScopeFile, "utf8")).fresh_readiness;
  const health = { at: new Date().toISOString(), all_health_200: true, provider_requests: 0,
    wallet_GETs: 0, production_mutations: 0, services: [qualified.api, qualified.worker] };
  const readinessFile = join(dir, "health.json"), grantPath = join(dir, "grant.json");
  function writeHealth() {
    const bytes = JSON.stringify(health); writeFileSync(readinessFile, bytes, { mode: 0o600 });
    return hash(bytes);
  }
  const readinessSha256 = writeHealth();
  const profile = loadNewAddressProfile(scopeFile, readinessFile, readinessSha256);
  claimNewAddressGrant(grantPath, profile);
  return { dir, health, writeHealth, readinessFile, readinessSha256, grantPath, profile };
}
const request = (resource: string, query = "", subject = wallet, method = "GET") =>
  new Request(`http://127.0.0.1:4317/api/wallet/${subject}/${resource}${query}`, { method });
const config = (f: ReturnType<typeof fixture>) => ({ grantPath: f.grantPath,
  target: "http://127.0.0.1:54321", token: "synthetic-token", newAddressProfile: f.profile });

it("accepts two serial pairs with a five-second gap and never renews the four-read allocation", async () => {
  vi.useFakeTimers();
  const f = fixture(), calls: string[] = [];
  const network = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("http://127.0.0.1:54321"); expect(url.search).toBe("");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("x-doxxd-acceptance-token")).toBe("synthetic-token");
    calls.push(url.pathname.split("/").at(-1)!);
    expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(calls.length);
    return Response.json({ ok: true, data: {} });
  };
  const first = boundedProxyHandler(config(f), network), second = boundedProxyHandler(config(f), network);
  expect((await Promise.all([first(request("overview")), second(request("summary"))])).map(r => r.status)).toEqual([200, 200]);
  vi.advanceTimersByTime(5000);
  expect((await Promise.all([second(request("overview")), first(request("summary"))])).map(r => r.status)).toEqual([200, 200]);
  expect((await boundedProxyHandler(config(f), network)(request("summary"))).status).toBe(422);
  expect(calls).toEqual(["overview", "summary", "overview", "summary"]);
  const state = JSON.parse(readFileSync(f.grantPath, "utf8"));
  expect(state.usedRequests).toBe(4); expect(state.requests.map((r: any) => r.phase)).toEqual([0, 0, 1, 1]);
  expect(() => claimNewAddressGrant(f.grantPath, f.profile)).toThrow();
});

it("refuses a premature refresh before forwarding a third read", async () => {
  vi.useFakeTimers(); const f = fixture(); let calls = 0;
  const handle = boundedProxyHandler(config(f), async () => { calls++; return Response.json({}); });
  expect((await handle(request("overview"))).status).toBe(200);
  expect((await handle(request("summary"))).status).toBe(200);
  vi.advanceTimersByTime(4999);
  expect((await handle(request("overview"))).status).toBe(422);
  expect(calls).toBe(2); expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(2);
});

it("refuses a duplicate within a pair even if fewer than four reads are spent", async () => {
  const f = fixture(); let calls = 0;
  const handle = boundedProxyHandler(config(f), async () => { calls++; return Response.json({}); });
  expect((await handle(request("summary"))).status).toBe(200);
  expect((await handle(request("summary"))).status).toBe(422);
  expect(calls).toBe(1);
});

it("rejects queries, protocols, older wallets and writes without spending or forwarding", async () => {
  const f = fixture(); let calls = 0;
  const handle = boundedProxyHandler(config(f), async () => { calls++; return Response.json({}); });
  for (const denied of [request("stake"), request("activity"), request("overview", "?cursor=x"),
    request("summary", "?limit=50"), request("overview", "", "Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X"),
    request("summary", "", wallet, "POST")]) expect((await handle(denied)).status).toBe(422);
  expect(calls).toBe(0); expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(0);
});

it.each(["redirect", "network", "authentication"])("keeps %s failed attempts spent across reloads", async kind => {
  const f = fixture(); let calls = 0;
  const handle = boundedProxyHandler(config(f), async () => {
    calls++;
    if (kind === "network") throw new Error("synthetic-secret");
    if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://external.invalid" } });
    return Response.json({ ok: false, kind: "authentication" }, { status: 403 });
  });
  const response = await handle(request("overview"));
  expect(response.status).toBe(kind === "authentication" ? 403 : 502);
  expect(await response.text()).not.toContain("synthetic-secret");
  const reload = boundedProxyHandler(config(f), async () => { calls++; return Response.json({}); });
  expect((await reload(request("summary"))).status).toBe(422);
  expect(calls).toBe(1); expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(1);
});

it("refuses incomplete, forged, unsafe and cross-profile state", () => {
  const f = fixture();
  reserveNewAddressRequest(f.grantPath, f.profile, "overview");
  expect(() => reserveNewAddressRequest(f.grantPath, f.profile, "summary")).toThrow();
  completeNewAddressRequest(f.grantPath, f.profile, 0, 200);
  const original = readFileSync(f.grantPath, "utf8"), state = JSON.parse(original);
  state.scopeId = "native-stake-small-wallet-3-20261025"; writeFileSync(f.grantPath, JSON.stringify(state));
  expect(() => reserveNewAddressRequest(f.grantPath, f.profile, "summary")).toThrow();
  writeFileSync(f.grantPath, original); chmodSync(f.grantPath, 0o644);
  expect(() => reserveNewAddressRequest(f.grantPath, f.profile, "summary")).toThrow();
  chmodSync(f.grantPath, 0o600); const link = join(f.dir, "link"); symlinkSync(f.grantPath, link);
  expect(() => reserveNewAddressRequest(link, f.profile, "summary")).toThrow();
  expect(() => claimNativeStakeGrant(join(f.dir, "native.json"), f.profile)).toThrow();
});

it("rejects changed service identity before touching custody or accepting a broader budget", () => {
  const f = fixture(); f.health.services[1].id = "wrong";
  const input = { profile: "new-address-initial-refresh-4-20261025", keyFile: "/does-not-exist.private", scopeFile,
    readinessFile: f.readinessFile, readinessSha256: f.writeHealth() };
  expect(() => runtimeConfiguration(input, {})).toThrow("New-address profile refused");
  expect(() => runtimeConfiguration({ ...input, requestBudget: 34 }, {})).toThrow("Invalid runtime configuration");
  expect(() => boundedProxyHandler({ ...config(f), newAddressProfile: { ...f.profile } })).toThrow();
});

it("does not treat an unproven synthetic result as permission to load real custody", () => {
  const f = fixture(), path = join(f.dir, "proof.json");
  const bytes = JSON.stringify({ version: 1, outcome: "passed", allowedRequests: 4 });
  writeFileSync(path, bytes, { mode: 0o600 });
  expect(() => assertNewAddressRehearsal({ syntheticProofFile: path, syntheticProofSha256: hash(bytes) }, "wrong", path)).toThrow();
});
