// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadNativeStakeProfile, claimNativeStakeGrant, reserveNativeStakeRequest,
  completeNativeStakeRequest, assertNativeStakeRehearsal } from "../../scripts/native-stake-profile.mjs";
import { boundedProxyHandler } from "../../scripts/acceptance-proxy.mjs";
import { runtimeConfiguration } from "../../scripts/run-dmnd.mjs";

const wallet = "Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X";
const scopeFile = new URL("../../tests/fixtures/dmnd-native-stake-scope-20261025.json", import.meta.url).pathname;
const directories: string[] = [];
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "doxxd-stake-scope-")); directories.push(dir);
  const scope = JSON.parse(readFileSync(scopeFile, "utf8"));
  const health = { at: new Date().toISOString(), all_health_200: true, provider_requests: 0,
    wallet_GETs: 0, production_mutations: 0, services: [scope.fresh_readiness.api, scope.fresh_readiness.worker] };
  const readinessFile = join(dir, "health.json"), grantPath = join(dir, "grant.json");
  function writeHealth() {
    const bytes = JSON.stringify(health); writeFileSync(readinessFile, bytes, { mode: 0o600 });
    return hash(bytes);
  }
  const readinessSha256 = writeHealth();
  const profile = loadNativeStakeProfile(scopeFile, readinessFile, readinessSha256);
  claimNativeStakeGrant(grantPath, profile);
  return { dir, health, writeHealth, readinessFile, readinessSha256, grantPath, profile };
}
const request = (resource: string, query = "", subject = wallet, method = "GET") =>
  new Request(`http://127.0.0.1:4317/api/wallet/${subject}/${resource}${query}`, { method });
const config = (f: ReturnType<typeof fixture>) => ({ grantPath: f.grantPath,
  target: "http://127.0.0.1:54321", token: "synthetic-token", nativeStakeProfile: f.profile });

it("reserves exactly one seed read per route across concurrent handlers and reloads", async () => {
  const f = fixture(), calls: string[] = [];
  const network = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("http://127.0.0.1:54321");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("x-doxxd-acceptance-token")).toBe("synthetic-token");
    calls.push(url.pathname.split("/").at(-1)! + url.search);
    expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(calls.length);
    return Response.json({ ok: true, data: {} });
  };
  const first = boundedProxyHandler(config(f), network), second = boundedProxyHandler(config(f), network);
  expect((await Promise.all([first(request("overview")), second(request("summary")), first(request("stake", "?limit=50"))])).map(r => r.status)).toEqual([200, 200, 200]);
  const reload = boundedProxyHandler(config(f), network);
  expect((await reload(request("overview"))).status).toBe(422);
  expect(calls).toEqual(["overview", "summary", "stake?limit=50"]);
  const state = JSON.parse(readFileSync(f.grantPath, "utf8"));
  expect(state.usedRequests).toBe(3);
  expect(state.requests.map((r: any) => r.status)).toEqual([200, 200, 200]);
  expect(() => claimNativeStakeGrant(f.grantPath, f.profile)).toThrow();
});

it("rejects other wallets, resources, paging, ambiguous queries and writes before forwarding", async () => {
  const f = fixture(); let calls = 0;
  const handle = boundedProxyHandler(config(f), async () => { calls++; return Response.json({}); });
  for (const denied of [request("overview", "", "11111111111111111111111111111111"),
    request("activity"), request("stake", "?limit=50&cursor=opaque"), request("stake", "?limit=5"),
    request("stake", "?limit=50&limit=50"), request("summary", "?ignored=1"), request("overview", "", wallet, "POST")])
    expect((await handle(denied)).status).toBe(422);
  expect(calls).toBe(0);
  expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(0);
  expect((await handle(request("overview"))).status).toBe(200);
});

it.each(["redirect", "network", "authentication"])("counts %s failures and never retries or continues", async kind => {
  const f = fixture(); let calls = 0;
  const handle = boundedProxyHandler(config(f), async () => {
    calls++;
    if (kind === "network") throw new Error("synthetic-secret");
    if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://external.invalid/" } });
    return Response.json({ ok: false, kind: "authentication" }, { status: 403 });
  });
  const response = await handle(request("overview"));
  expect(response.status).toBe(kind === "authentication" ? 403 : 502);
  expect(await response.text()).not.toContain("synthetic-secret");
  expect((await handle(request("summary"))).status).toBe(422);
  const reload = boundedProxyHandler(config(f), async () => { calls++; return Response.json({}); });
  expect((await reload(request("stake", "?limit=50"))).status).toBe(422);
  expect(calls).toBe(1);
  expect(JSON.parse(readFileSync(f.grantPath, "utf8")).usedRequests).toBe(1);
});

it("keeps uncertain reservations spent and refuses malformed or unsafe ledgers", () => {
  const f = fixture();
  reserveNativeStakeRequest(f.grantPath, f.profile, "overview");
  expect(() => reserveNativeStakeRequest(f.grantPath, f.profile, "summary")).toThrow();
  completeNativeStakeRequest(f.grantPath, f.profile, 0, 200);
  const original = readFileSync(f.grantPath, "utf8");
  const forged = JSON.parse(original); forged.requests[0].resource = "stake"; forged.requests.push(forged.requests[0]); forged.usedRequests = 2;
  writeFileSync(f.grantPath, JSON.stringify(forged));
  expect(() => reserveNativeStakeRequest(f.grantPath, f.profile, "summary")).toThrow();
  writeFileSync(f.grantPath, original); chmodSync(f.grantPath, 0o644);
  expect(() => reserveNativeStakeRequest(f.grantPath, f.profile, "summary")).toThrow();
  chmodSync(f.grantPath, 0o600);
  const link = join(f.dir, "link"); symlinkSync(f.grantPath, link);
  expect(() => reserveNativeStakeRequest(link, f.profile, "summary")).toThrow();
});

it("requires unchanged healthy stake-enabled services and fresh pinned evidence before custody", () => {
  const f = fixture();
  const input = { profile: "native-stake-small-wallet-3-20261025", keyFile: "/does-not-exist.private", scopeFile,
    readinessFile: f.readinessFile, readinessSha256: f.readinessSha256 };
  f.health.services[1].source = "0000000000000000000000000000000000000000";
  expect(() => runtimeConfiguration({ ...input, readinessSha256: f.writeHealth() }, {})).toThrow("Native-stake profile refused");
  f.health.services[1] = JSON.parse(readFileSync(scopeFile, "utf8")).fresh_readiness.worker;
  f.health.at = "2026-10-23T00:00:00Z";
  expect(() => loadNativeStakeProfile(scopeFile, f.readinessFile, f.writeHealth())).toThrow();
  expect(() => runtimeConfiguration({ ...input, requestBudget: 34 }, {})).toThrow("Invalid runtime configuration");
  expect(() => boundedProxyHandler({ ...config(f), nativeStakeProfile: { ...f.profile } })).toThrow();
});

it("refuses a fabricated or outdated synthetic proof before it can authorize custody", () => {
  const f = fixture(), path = join(f.dir, "proof.json");
  const bytes = JSON.stringify({ version: 1, syntheticOnly: true, at: "2026-10-23T00:00:00Z", allowedRequests: 3 });
  writeFileSync(path, bytes, { mode: 0o600 });
  expect(() => assertNativeStakeRehearsal({ syntheticProofFile: path, syntheticProofSha256: hash(bytes) }, "wrong-build", path)).toThrow();
});
