// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimGrant, claimLease, resumeGrant, runtimeConfiguration } from "../../scripts/run-dmnd.mjs";
import { boundedProxyHandler } from "../../scripts/acceptance-proxy.mjs";
import { loadExtensionReceipt, readOverviewExtensionReceipt } from "../../scripts/native-overview-extension.mjs";
import { APPROVED_WALLETS } from "../../scripts/dmnd-acceptance.mjs";

const paths: string[] = [];
const wallets = [...APPROVED_WALLETS];
const NOW = "2099-10-23T09:00:00.000Z", EXPIRES = "2099-10-23T10:15:00Z";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => {
  vi.useRealTimers();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "doxxd-extension-test-"));
  paths.push(path);
  return path;
}
function scope() {
  return {
    additional_requests_max: 8, old_lifetime_cap: 34, new_lifetime_cap: 42,
    already_used: 29, expires_at: EXPIRES,
    allowed_resources: ["overview"], allowed_wallets: wallets,
    unpaged_overview: true, response_max_bytes: 8388608, timeout_ms: 8000,
  };
}
function receiptFile(allocation: Record<string, unknown> = scope()) {
  const root = directory(), path = join(root, "controller.json");
  const bytes = JSON.stringify({ new_bounded_validation_allocation: allocation });
  writeFileSync(path, bytes, { mode: 0o600 });
  return { root, path, bytes, sha256: digest(bytes) };
}
function oldState() {
  return {
    claimedAt: "2099-10-23T08:00:00.000Z", allocatedRequests: 34, usedRequests: 29,
    requests: Array.from({ length: 29 }, (_, i) => ({
      number: i + 1, wallet: wallets[i % 2], resource: ["overview", "summary", "transactions", "activity"][i % 4],
      page: "seed", reservedAt: "2099-10-23T08:01:00.000Z", status: 200,
      finishedAt: "2099-10-23T08:01:01.000Z",
    })),
  };
}
function fixture(extend = true) {
  const file = receiptFile(), grantPath = join(file.root, "grant.json");
  const originalBytes = JSON.stringify(oldState(), null, 2) + "\n";
  writeFileSync(grantPath, originalBytes, { mode: 0o600 });
  const extension = loadExtensionReceipt(file.path, file.sha256, []);
  if (extend) resumeGrant(grantPath, 42, 29, extension);
  const config = { grantPath, target: "http://127.0.0.1:54321", token: "synthetic-token", extension, extensionMode: "bonus" };
  return { ...file, grantPath, originalBytes, extension, config };
}
const request = (resource = "overview", wallet = wallets[0], query = "") =>
  new Request("http://127.0.0.1:4317/api/wallet/" + wallet + "/" + resource + query);
const state = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const save = (path: string, value: any) => writeFileSync(path, JSON.stringify(value) + "\n");

it.each([
  ["additional_requests_max", 9], ["old_lifetime_cap", 35], ["new_lifetime_cap", 43],
  ["already_used", 28], ["allowed_resources", ["overview", "summary"]],
  ["allowed_wallets", [wallets[0]]], ["allowed_wallets", [wallets[0], wallets[0]]],
  ["allowed_wallets", [wallets[0], "11111111111111111111111111111111"]],
  ["unpaged_overview", false], ["response_max_bytes", 8388609], ["timeout_ms", 9000],
  ["expires_at", "2099-10-23T08:59:59Z"], ["expires_at", "tomorrow"],
  ["expires_at", "2099-10-24T24:00:00Z"],
  ["allowed_resources", undefined], ["unpaged_overview", undefined],
])("rejects a pinned receipt with invalid machine scope %s=%j", (field, value) => {
  const file = receiptFile({ ...scope(), [field as string]: value });
  expect(() => loadExtensionReceipt(file.path, file.sha256, [])).toThrow("Extension receipt");
});

it("rejects missing, wrong-hash, writable, symlinked, oversized and worktree-local receipts before custody", () => {
  const file = receiptFile();
  const config = { keyFile: join(file.root, "missing-secret"), requestBudget: 42, resumeUsedRequests: 29,
    extensionReceiptFile: file.path, extensionReceiptSha256: "0".repeat(64) };
  expect(() => runtimeConfiguration(config, {})).toThrow("Extension receipt");
  expect(() => loadExtensionReceipt(file.path + "-missing", file.sha256, [])).toThrow("Extension receipt");
  expect(() => loadExtensionReceipt(file.path, file.sha256, [file.root])).toThrow("Extension receipt");
  const disguised = join(file.root, "..receipt.json");
  writeFileSync(disguised, file.bytes, { mode: 0o600 });
  expect(() => loadExtensionReceipt(disguised, file.sha256, [file.root])).toThrow("Extension receipt");
  const link = join(file.root, "linked.json");
  symlinkSync(file.path, link);
  expect(() => loadExtensionReceipt(link, file.sha256, [])).toThrow("Extension receipt");
  chmodSync(file.path, 0o666);
  expect(() => loadExtensionReceipt(file.path, file.sha256, [])).toThrow("Extension receipt");
  chmodSync(file.path, 0o600);
  writeFileSync(file.path, " ".repeat(65537));
  expect(() => loadExtensionReceipt(file.path, file.sha256, [])).toThrow("Extension receipt");
});

it("does not grant 42 without an exact old grant and explicit pinned resume", () => {
  const file = receiptFile(), keyFile = join(file.root, "missing-secret");
  const pin = { extensionReceiptFile: file.path, extensionReceiptSha256: file.sha256 };
  for (const config of [
    { keyFile, requestBudget: 42 }, { keyFile, requestBudget: 42, resumeUsedRequests: 29 },
    { keyFile, requestBudget: 42, ...pin },
    { keyFile, requestBudget: 35, resumeUsedRequests: 29, ...pin },
    { keyFile, requestBudget: 42, resumeUsedRequests: 29, extensionReceiptFile: file.path },
    { keyFile, requestBudget: 42, resumeUsedRequests: 29, extensionReceiptSha256: file.sha256 },
  ]) expect(() => runtimeConfiguration(config, {})).toThrow();
  expect(() => claimGrant(join(file.root, "new-grant.json"), 42)).toThrow();
  const extension = loadExtensionReceipt(file.path, file.sha256, []);
  expect(() => resumeGrant(join(file.root, "missing-grant.json"), 42, 29, extension)).toThrow("cannot be reconciled");
});

it("exposes the same bounded receipt schema to the parent capture runner with an explicit clock", () => {
  const file = receiptFile();
  expect(readOverviewExtensionReceipt(file.path, file.sha256, { now: Date.parse(NOW) })).toEqual({
    receiptSha256: file.sha256, oldCap: 34, newCap: 42, alreadyUsed: 29, additionalRequests: 8,
    wallets, resources: ["overview"], expiresAt: EXPIRES, maxBytes: 8388608, timeoutMs: 8000,
  });
  expect(() => readOverviewExtensionReceipt(file.path, file.sha256, { now: Date.parse(EXPIRES) })).toThrow("Extension receipt");
  expect(readOverviewExtensionReceipt(file.path, file.sha256, { now: Date.parse(EXPIRES), allowExpired: true }).alreadyUsed).toBe(29);
  expect(() => readOverviewExtensionReceipt(file.path, file.sha256, { now: NaN })).toThrow("Extension receipt");
});

it("atomically preserves the old 29 rows and exact old bytes, with immutable digest and scope", () => {
  const f = fixture(), next = state(f.grantPath);
  expect(next.allocatedRequests).toBe(42);
  expect(next.usedRequests).toBe(29);
  expect(next.baseUsedRequests).toBe(29);
  expect(next.bonusUsedRequests).toBe(0);
  expect(next.requests).toEqual(oldState().requests);
  expect(next.claimedAt).toBe(oldState().claimedAt);
  expect(Buffer.from(next.extension.originalLedgerBase64, "base64").toString()).toBe(f.originalBytes);
  expect(next.extension.originalLedgerSha256).toBe(digest(f.originalBytes));
  expect(next.extension.receiptSha256).toBe(f.sha256);
  expect(next.extension.allowedResources).toEqual(["overview"]);
  const bytes = readFileSync(f.grantPath, "utf8");
  resumeGrant(f.grantPath, 42, 29, f.extension);
  expect(readFileSync(f.grantPath, "utf8")).toBe(bytes);
});

it.each(["count", "cap", "partial", "wallet", "resource", "sequence"])("refuses an invalid original ledger (%s) without modifying it", (variant) => {
  const f = fixture(false), old: any = oldState();
  if (variant === "count") old.usedRequests = 28;
  if (variant === "cap") old.allocatedRequests = 33;
  if (variant === "partial") old.requests[28].status = null;
  if (variant === "wallet") old.requests[28].wallet = "11111111111111111111111111111111";
  if (variant === "resource") old.requests[28].resource = "kamino";
  if (variant === "sequence") old.requests[28].number = 28;
  save(f.grantPath, old);
  const bytes = readFileSync(f.grantPath, "utf8");
  expect(() => resumeGrant(f.grantPath, 42, 29, f.extension)).toThrow("cannot be reconciled");
  expect(readFileSync(f.grantPath, "utf8")).toBe(bytes);
});

it("retains the exclusive launcher lease before an extension can start", () => {
  const f = fixture(false), leasePath = join(f.root, "lease.json");
  const release = claimLease(leasePath);
  try { expect(() => claimLease(leasePath)).toThrow("already owned"); }
  finally { release(); }
  expect(readFileSync(f.grantPath, "utf8")).toBe(f.originalBytes);
});

it("reserves serially before forwarding across handlers and reloads, never grants bonus again", async () => {
  const f = fixture();
  let active = 0, peak = 0, calls = 0;
  const network = async (_url: string, init: RequestInit) => {
    calls++; active++; peak = Math.max(peak, active);
    const ledger = state(f.grantPath);
    expect(ledger.usedRequests).toBe(29 + calls);
    expect(ledger.requests.at(-1).status).toBeNull();
    expect(new Headers(init.headers).get("x-doxxd-acceptance-token")).toBe("synthetic-token");
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return Response.json({ ok: true, assets: Array.from({ length: 1037 }, () => ({ amount: "1" })) });
  };
  const handle = boundedProxyHandler(f.config, network);
  expect((await handle(request())).status).toBe(200);
  expect((await handle(request("overview", wallets[1]))).status).toBe(200);
  const at31 = readFileSync(f.grantPath, "utf8");
  expect(() => resumeGrant(f.grantPath, 42, 29, f.extension)).toThrow("cannot be reconciled");
  resumeGrant(f.grantPath, 42, 31, f.extension);
  expect(readFileSync(f.grantPath, "utf8")).toBe(at31);
  const reload = boundedProxyHandler(f.config, network);
  const replies = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    (i % 2 ? reload : handle)(request("overview", wallets[i % 2]))));
  expect(replies.map((r) => r.status)).toEqual(Array(6).fill(200));
  expect(peak).toBe(1);
  expect(calls).toBe(8);
  const ledger = state(f.grantPath);
  expect(ledger.usedRequests).toBe(37);
  expect(ledger.baseUsedRequests).toBe(29);
  expect(ledger.bonusUsedRequests).toBe(8);
  expect(ledger.requests.slice(0, 29)).toEqual(oldState().requests);
  expect((await boundedProxyHandler(f.config, network)(request())).status).toBe(422);
  expect(calls).toBe(8);
  expect(() => resumeGrant(f.grantPath, 42, 37, f.extension)).toThrow("cannot be reconciled");
  resumeGrant(f.grantPath, 34, 37, f.extension);
});

it("preserves the original five for explicit CORE resumption and caps the combined lifetime at 42", async () => {
  const f = fixture();
  let calls = 0;
  const network = async () => { calls++; return Response.json({}); };
  const bonus = boundedProxyHandler(f.config, network);
  for (let i = 0; i < 8; i++) expect((await bonus(request())).status).toBe(200);
  const keyFile = join(f.root, "synthetic.private");
  writeFileSync(keyFile, "synthetic-key", { mode: 0o600 });
  const original = runtimeConfiguration({ keyFile, requestBudget: 34, resumeUsedRequests: 37,
    extensionReceiptFile: f.path, extensionReceiptSha256: f.sha256 }, {});
  expect(original.extensionMode).toBe("original");
  expect(original.env.DMND_REQUEST_BUDGET).toBe("34");
  resumeGrant(f.grantPath, 34, 37, original.extension);
  const normal = boundedProxyHandler({ ...f.config, extension: original.extension, extensionMode: "original" }, network);
  for (const resource of ["summary", "transactions", "activity", "overview", "activity"])
    expect((await normal(request(resource))).status).toBe(200);
  expect((await normal(request())).status).toBe(422);
  expect(calls).toBe(13);
  expect(state(f.grantPath).usedRequests).toBe(42);
  expect(state(f.grantPath).baseUsedRequests).toBe(34);
  expect(state(f.grantPath).bonusUsedRequests).toBe(8);
});

it("refuses summary, activity, protocols, new wallets, continuation and paging without spending either allocation", async () => {
  const f = fixture();
  let calls = 0;
  const handle = boundedProxyHandler(f.config, async () => { calls++; return Response.json({}); });
  for (const input of [request("summary"), request("activity"), request("transactions"), request("kamino"),
    request("overview", "11111111111111111111111111111111"), request("overview", wallets[0], "?cursor=opaque"),
    request("overview", wallets[0], "?limit=10"), new Request(request().url, { method: "POST" })])
    expect((await handle(input)).status).not.toBe(200);
  expect(calls).toBe(0);
  expect(state(f.grantPath).usedRequests).toBe(29);
  expect((await handle(request())).status).toBe(200);
});

it("expires only the bonus; the original five remain resumable after expiry", async () => {
  const f = fixture();
  vi.setSystemTime(EXPIRES);
  let calls = 0;
  const network = async () => { calls++; return Response.json({}); };
  expect((await boundedProxyHandler(f.config, network)(request())).status).toBe(422);
  expect(calls).toBe(0);
  expect(() => resumeGrant(f.grantPath, 42, 29, f.extension)).toThrow("cannot be reconciled");
  const receipt = loadExtensionReceipt(f.path, f.sha256, [], true);
  resumeGrant(f.grantPath, 34, 29, receipt);
  const original = boundedProxyHandler({ ...f.config, extension: receipt, extensionMode: "original" }, network);
  expect((await original(request("summary"))).status).toBe(200);
  expect(state(f.grantPath).baseUsedRequests).toBe(30);
  expect(state(f.grantPath).bonusUsedRequests).toBe(0);
});

it.each([401, 403, 429])("persists a %i stop across reloads and mode changes even for an invalid body", async (httpStatus) => {
  const f = fixture();
  let calls = 0;
  const network = async () => { calls++; return new Response("not JSON", { status: httpStatus }); };
  const first = boundedProxyHandler(f.config, network);
  expect((await first(request())).status).toBe(502);
  const ledger = state(f.grantPath);
  expect(ledger.usedRequests).toBe(30);
  expect(ledger.requests[29].status).toBe(httpStatus);
  expect(ledger.extensionHalt.status).toBe(httpStatus);
  for (const mode of ["bonus", "original"]) {
    expect((await boundedProxyHandler({ ...f.config, extensionMode: mode }, network)(request())).status).toBe(422);
    expect(() => resumeGrant(f.grantPath, mode === "bonus" ? 42 : 34, 30, f.extension)).toThrow("cannot be reconciled");
  }
  expect(calls).toBe(1);
});

it.each(["original", "bonus"].flatMap((allocation) => [401, 403, 429].flatMap((httpStatus) =>
  ["valid", "invalid", "oversized"].map((body) => ({ allocation, httpStatus, body })))))(
  "globally halts after $allocation allocation HTTP $httpStatus with a $body body", async ({ allocation, httpStatus, body }) => {
    const f = fixture();
    let calls = 0;
    const network = async () => {
      calls++;
      if (body === "valid") return Response.json({ ok: false }, { status: httpStatus });
      return new Response(body === "invalid" ? "not JSON" : "{}", {
        status: httpStatus,
        headers: body === "oversized" ? { "content-length": "8388609" } : {},
      });
    };
    const handle = boundedProxyHandler({ ...f.config, extensionMode: allocation }, network);
    const input = request(allocation === "original" ? "summary" : "overview");
    expect((await handle(input)).status).toBe(body === "valid" ? httpStatus : 502);
    const ledger = state(f.grantPath);
    expect(ledger.usedRequests).toBe(30);
    expect(ledger.baseUsedRequests).toBe(allocation === "original" ? 30 : 29);
    expect(ledger.bonusUsedRequests).toBe(allocation === "original" ? 0 : 1);
    expect(ledger.requests[29].allocation).toBe(allocation === "original" ? "original" : "overview-extension");
    expect(ledger.requests[29].status).toBe(httpStatus);
    expect(ledger.extensionHalt).toEqual({ requestNumber: 30, status: httpStatus, at: ledger.requests[29].finishedAt });
    for (const mode of ["bonus", "original"]) {
      expect((await boundedProxyHandler({ ...f.config, extensionMode: mode }, network)(request())).status).toBe(422);
      expect(() => resumeGrant(f.grantPath, mode === "bonus" ? 42 : 34, 30, f.extension)).toThrow("cannot be reconciled");
    }
    expect((await handle(input)).status).toBe(422);
    expect(calls).toBe(1);
    expect(state(f.grantPath).usedRequests).toBe(30);
  });

it("counts network failures and oversized bodies once without retrying or refunding", async () => {
  const f = fixture();
  let calls = 0;
  const network = async () => {
    calls++;
    if (calls === 1) throw new Error("synthetic-secret");
    return new Response("{}", { headers: { "content-length": "8388609" } });
  };
  const handle = boundedProxyHandler(f.config, network);
  expect((await handle(request())).status).toBe(502);
  expect((await handle(request())).status).toBe(502);
  expect(calls).toBe(2);
  expect(state(f.grantPath).usedRequests).toBe(31);
  expect(state(f.grantPath).bonusUsedRequests).toBe(2);
  expect(readFileSync(f.grantPath, "utf8")).not.toContain("synthetic-secret");
});

it("enforces the byte cap on streamed bodies without trusting content-length", async () => {
  const f = fixture();
  let cancelled = false;
  const handle = boundedProxyHandler(f.config, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8388608));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  })));
  expect((await handle(request())).status).toBe(502);
  expect(cancelled).toBe(true);
  expect(state(f.grantPath).bonusUsedRequests).toBe(1);
});

it("keeps a timed-out attempt charged at the receipt's eight-second bound", async () => {
  const f = fixture();
  vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  let calls = 0;
  const handle = boundedProxyHandler(f.config, async (_url: string, init: RequestInit) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) =>
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const pending = handle(request());
  await vi.advanceTimersByTimeAsync(7999);
  expect(state(f.grantPath).requests.at(-1).status).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).status).toBe(504);
  expect(calls).toBe(1);
  expect(state(f.grantPath).usedRequests).toBe(30);
});

it.each(["bare42", "digest", "audit", "old-row", "bonus-counter", "base-counter", "bonus-scope", "partial", "halt-erased", "corrupt"])(
  "fails closed for ledger corruption (%s) before network or resume", async (variant) => {
    const f = fixture();
    if (["bonus-scope", "partial", "halt-erased"].includes(variant)) {
      const status = variant === "halt-erased" ? 401 : 200;
      await boundedProxyHandler(f.config, async () => Response.json({}, { status }))(request());
    }
    const ledger = state(f.grantPath);
    if (variant === "bare42") delete ledger.extension;
    if (variant === "digest") ledger.extension.receiptSha256 = "0".repeat(64);
    if (variant === "audit") ledger.extension.originalLedgerBase64 = Buffer.from("{}").toString("base64");
    if (variant === "old-row") ledger.requests[0].status = 201;
    if (variant === "bonus-counter") ledger.bonusUsedRequests++;
    if (variant === "base-counter") ledger.baseUsedRequests++;
    if (variant === "bonus-scope") ledger.requests[29].resource = "summary";
    if (variant === "partial") ledger.requests[29].status = null;
    if (variant === "halt-erased") delete ledger.extensionHalt;
    save(f.grantPath, ledger);
    if (variant === "corrupt") writeFileSync(f.grantPath, "{");
    const bytes = readFileSync(f.grantPath, "utf8");
    let calls = 0;
    const handle = boundedProxyHandler(f.config, async () => { calls++; return Response.json({}); });
    expect((await handle(request())).status).toBe(422);
    expect(calls).toBe(0);
    expect(() => resumeGrant(f.grantPath, 42, ledger.usedRequests, f.extension)).toThrow("cannot be reconciled");
    expect(readFileSync(f.grantPath, "utf8")).toBe(bytes);
  });

it("requires the same pinned receipt on every extended restart and refuses a forged context", async () => {
  const f = fixture(), other = receiptFile();
  writeFileSync(other.path, other.bytes + "\n");
  const otherReceipt = loadExtensionReceipt(other.path, digest(other.bytes + "\n"), []);
  expect(() => resumeGrant(f.grantPath, 42, 29, otherReceipt)).toThrow("cannot be reconciled");
  expect(() => resumeGrant(f.grantPath, 42, 29)).toThrow("cannot be reconciled");
  expect(() => resumeGrant(f.grantPath, 34, 29)).toThrow("cannot be reconciled");
  let calls = 0;
  const network = async () => { calls++; return Response.json({}); };
  expect((await boundedProxyHandler({ ...f.config, extension: undefined }, network)(request())).status).toBe(422);
  expect((await boundedProxyHandler({ ...f.config, extension: { ...f.extension } }, network)(request())).status).toBe(422);
  expect(calls).toBe(0);
});
