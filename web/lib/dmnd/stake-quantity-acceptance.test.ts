// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { APPROVED_WALLETS } from "../../scripts/dmnd-acceptance.mjs";
import { loadExtensionReceipt, resumeExtensionGrant, completeRequest, reserveRequest } from "../../scripts/native-overview-extension.mjs";
import { readStakeScope, runStakeQuantityAcceptance, STAKE_SCOPE_ID } from "../../scripts/stake-quantity-acceptance.mjs";
const roots: string[] = [], wallets = [...APPROVED_WALLETS];
const epoch = Date.parse("2099-10-23T21:00:00Z"), expires = "2099-10-23T21:30:00Z", dummy = "synthetic-private-key/+?not-real";
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.useRealTimers(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function scope() { return {
  at: "2099-10-23T20:54:55Z", controller: "00000000-0000-4000-8000-000000000002", recipient: "00000000-0000-4000-8000-000000000001", relay_capable_coordinators: [], scope_id: STAKE_SCOPE_ID,
  state: "AUTHORIZED_FINITE_CONSUMER_GET_ONLY_NO_PROVIDER_OR_FLAG_OPERATION", expires_at: expires,
  source_evidence: { api: { selected_flags: { API_WALLET_STAKE_ENABLED: { configured: false, effective: "false" } } }, worker: { selected_flags: { WORKER_WALLET_STAKE_ENABLED: { configured: false, effective: "false" } } } },
  requests: { base: "https://api.dmnd.dev/api/v1", method: "GET", path_template: "/wallets/{wallet}/stake-accounts", query: { limit: 5 }, wallets: "Prose deliberately gives no IDs or authority.", max_attempts_total: 2, max_attempts_per_wallet: 1, request_timeout_seconds: 5, response_max_bytes_per_call: 65536, no_retry: true, no_cursor_follow: true, separate_from_existing_core_five: "metadata" },
  provider_budget: { Helius_or_other_upstream_calls_allocated: 0, enqueues_allocated: 0, proof: "metadata", abort_if: "metadata" },
  resource_profile: { program: "Stake11111111111111111111111111111111111111", supported_scope: "native_stake_program_withdrawer", resource_identity: "metadata", role: "authorizedwithdrawer exactwallet, notstaker-only orliquidstakingreceipt" },
  acceptance: [], not_authorized: [], delivery: "synthetic fixture",
}; }
function page(wallet: string, extra: Record<string, unknown> = {}) { return { wallet, data: [{ stake_account: wallets[1], withdrawer: wallet, lamports: "0", delegated_lamports: "9007199254740993123456789", future_unknown: "18446744073709551615" }], cursor: "unfollowed", has_more: true, total_lamports: "0", coverage: { complete: false, fresh: false, status: "disabled", reason: "stake_scan_disabled", scope: "native_stake_program_withdrawer", snapshot_slot: null }, ...extra }; }
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "doxxd-stake-quantity-")); roots.push(root);
  const scopeFile = join(root, "scope.json"), originalGrantFile = join(root, "core.json"), originalReceiptFile = join(root, "old-receipt.json");
  const old = { claimedAt: "2099-10-23T08:00:00.000Z", allocatedRequests: 34, usedRequests: 29, requests: Array.from({ length: 29 }, (_, i) => ({ number: i + 1, wallet: wallets[i % 2], resource: ["overview", "summary", "transactions", "activity"][i % 4], page: "seed", reservedAt: "2099-10-23T08:01:00.000Z", status: 200, finishedAt: "2099-10-23T08:01:01.000Z" })) };
  const originalBytes = JSON.stringify(old) + "\n";
  const oldReceipt = JSON.stringify({ new_bounded_validation_allocation: { additional_requests_max: 8, old_lifetime_cap: 34, new_lifetime_cap: 42, already_used: 29, allowed_resources: ["overview"], allowed_wallets: wallets, unpaged_overview: true, response_max_bytes: 8388608, timeout_ms: 8000, expires_at: "2099-10-23T10:15:00Z" } });
  fs.writeFileSync(originalReceiptFile, oldReceipt, { mode: 0o600 }); fs.writeFileSync(originalGrantFile, originalBytes, { mode: 0o600 });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2099-10-23T09:00:00Z");
  const receipt = loadExtensionReceipt(originalReceiptFile, hash(oldReceipt), []); resumeExtensionGrant(originalGrantFile, 42, 29, receipt);
  for (let i = 0; i < 8; i++) completeRequest(originalGrantFile, reserveRequest(originalGrantFile, wallets[i % 2], "overview", false, true, receipt, "bonus"), 200, receipt);
  vi.useRealTimers(); const packet = JSON.stringify(scope()); fs.writeFileSync(scopeFile, packet, { mode: 0o600 }); let time = epoch;
  return { root, input: { scopeFile, scopeSha256: hash(packet), keyFile: join(root, "missing-real-key"), originalGrantFile, originalReceiptFile }, deps: { stateDirectory: join(root, "state"), now: () => time, network: vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => Response.json(page(new URL(url).pathname.split("/").at(-2)!))), credentialReader: vi.fn((_file: string) => dummy), proofVerifier: vi.fn(() => undefined), historicalPins: { receiptSha256: hash(oldReceipt), originalLedgerSha256: hash(originalBytes) } }, setTime: (t: number) => { time = t; } };
}
function v4Scope(f: ReturnType<typeof fixture>) {
  const keyFile = join(f.root, "dummy-v4-key");
  fs.writeFileSync(keyFile, dummy, { mode: 0o600 }); f.input.keyFile = keyFile;
  const st = fs.lstatSync(keyFile);
  return {
    at: "2099-10-23T21:01:00Z", status: "RENEWED_SAME_TWO_ATTEMPTS_NOT_AN_INCREASE", recipient: "00000000-0000-4000-8000-000000000001", relay: "00000000-0000-4000-8000-000000000003",
    original_expired_preserved: { path: join(f.root, "historical-scope.json"), sha256: "265ea5208f601a264a3bdc56bf385e04f7f245d9b3ec5200981d8eb6a2b62e3b", expires_at: "2026-10-23T21:30:00Z" },
    reported_original_attempts: 0, basis: "metadata", expires_at: expires, max_total_stake_GET_attempts_across_original_and_renewal: 2, original_five_CORE_rights_and_ledger37: "unchanged",
    wallets, endpoint: "https://api.dmnd.dev/api/v1/wallets/{wallet}/stake-accounts?limit=5", per_wallet_attempts: 1,
    limits: { per_attempt_deadline_seconds: 5, max_body_bytes: 65536, retries: 0, cursor_pages: 0, redirects: 0, provider_calls: 0, enqueue_calls: 0, flag_changes: 0, job_or_SQL_or_service_or_build_or_gate_allocation: 0 },
    stop_remaining_on: ["authfailure", "429", "5xx", "expiredscope", "counter/credentialcustodyambiguity"], credential_custody: "non-authorizing metadata", consumer_guard: "metadata", runtime_source: "metadata", acceptance: "metadata", current_rollout_receipt: join(f.root, "unused-rollout.json"), new_user_permission_question_required: false, recipient_ACK: false,
    revision: "V4_EXACT_EXISTING_SERVER_CUSTODY_PATH_NO_NEW_ATTEMPTS", scope_id: STAKE_SCOPE_ID,
    wallet_binding: { path: join(f.root, "unused-binding.json"), sha256: "9036e2fdc0e4202a925d051d6bfea5e665e6a52d2db3df5848a59e57df5e72a3", source: "metadata" },
    previous_renewal_preserved: { path: join(f.root, "unused-v2.json"), sha256: "0b6acf62bd890091a4b1d0c7dd72acc93a2082add359247a8207bf4e8be6c8f2" }, max_total_stake_GET_attempts_across_all_scope_versions: 2,
    previous_v3_preserved: { path: join(f.root, "unused-v3.json"), sha256: "24672e71d761af7b78cb6bcada0de4430bbeb7eff0818e4d0a10d189c294e43f" },
    credential_path: keyFile, credential_path_metadata_only: { regular: true, symlink: false, uid: st.uid, gid: st.gid, mode: "0600", nlink: 1, device: st.dev, inode: st.ino, key_bytes_read_by_root_for_this_metadata: false }, credential_path_allowed: true, credential_path_permission: "metadata", counter_must_resume_never_reset: "metadata",
  };
}
function repin(f: ReturnType<typeof fixture>, value: unknown) { const p = JSON.stringify(value); fs.writeFileSync(f.input.scopeFile, p); f.input.scopeSha256 = hash(p); }
function saved(f: ReturnType<typeof fixture>, name: string) { return JSON.parse(fs.readFileSync(join(f.deps.stateDirectory, name), "utf8")); }
function evidence(f: ReturnType<typeof fixture>) { return fs.readdirSync(f.deps.stateDirectory).map((n) => fs.readFileSync(join(f.deps.stateDirectory, n), "utf8")).join("\n"); }

describe("finite scope and original provenance", () => {
  it("reads a pinned bounded external scope; rejects hash and expiry boundary", () => {
    const f = fixture(); expect(readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: epoch, worktrees: [] })).toMatchObject({ scopeId: STAKE_SCOPE_ID, wallets, maxAttempts: 2, expiresAt: expires });
    expect(() => readStakeScope(f.input.scopeFile, "0".repeat(64), { now: epoch, worktrees: [] })).toThrow("invalid_scope");
    expect(() => readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: Date.parse(expires), worktrees: [] })).toThrow("scope_expired");
  });
  it.each(["query", "cap", "method", "base", "retry", "enqueue", "flag", "extra", "extra-request"])("rejects widened machine allowance %s before custody", async (kind) => {
    const f = fixture(), s = scope(); if (kind === "query") Object.assign(s.requests.query, { cursor: "foreign" }); if (kind === "cap") s.requests.max_attempts_total = 3; if (kind === "method") s.requests.method = "POST"; if (kind === "base") s.requests.base = "https://foreign.invalid"; if (kind === "retry") s.requests.no_retry = false; if (kind === "enqueue") s.provider_budget.enqueues_allocated = 1; if (kind === "flag") s.source_evidence.api.selected_flags.API_WALLET_STAKE_ENABLED.effective = "true"; if (kind === "extra") Object.assign(s, { extra_allowance: 4 }); if (kind === "extra-request") Object.assign(s.requests, { retry: 2 }); repin(f, s);
    await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("invalid_scope"); expect(f.deps.credentialReader).not.toHaveBeenCalled(); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it("refuses unsafe receipt symlinks, modes, owners, worktree custody and size", () => {
    const f = fixture(), link = join(f.root, "linked"); fs.symlinkSync(f.input.scopeFile, link);
    expect(() => readStakeScope(link, f.input.scopeSha256, { now: epoch, worktrees: [] })).toThrow("invalid_scope"); expect(() => readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: epoch, worktrees: [f.root] })).toThrow("invalid_scope");
    fs.chmodSync(f.input.scopeFile, 0o666); expect(() => readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: epoch, worktrees: [] })).toThrow("invalid_scope"); fs.chmodSync(f.input.scopeFile, 0o600);
    const stat = fs.fstatSync; vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => { const s = stat(fd); Object.defineProperty(s, "uid", { value: (process.getuid?.() ?? 0) + 1 }); return s; }) as typeof fs.fstatSync); syncBuiltinESMExports();
    expect(() => readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: epoch, worktrees: [] })).toThrow("invalid_scope"); vi.restoreAllMocks(); syncBuiltinESMExports(); fs.writeFileSync(f.input.scopeFile, " ".repeat(65537)); expect(() => readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: epoch, worktrees: [] })).toThrow("invalid_scope");
  });
  it.each(["counts", "original-bytes", "wallet", "pending", "bonus", "receipt"])("rejects unreconciled original ledger %s before custody", async (kind) => {
    const f = fixture(), g = JSON.parse(fs.readFileSync(f.input.originalGrantFile, "utf8")); if (kind === "counts") g.baseUsedRequests++; if (kind === "original-bytes") g.extension.originalLedgerBase64 = Buffer.from("{}").toString("base64"); if (kind === "wallet") g.requests[0].wallet = "foreign"; if (kind === "pending") g.requests[36].status = null; if (kind === "bonus") g.requests[36].allocation = "original"; if (kind === "receipt") g.extension.receiptSha256 = "0".repeat(64); fs.writeFileSync(f.input.originalGrantFile, JSON.stringify(g));
    await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("invalid_original_grant"); expect(f.deps.credentialReader).not.toHaveBeenCalled(); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it("enforces real historical pins by default and proof before key custody", async () => {
    const f = fixture(); const { historicalPins: _pins, ...deps } = f.deps; expect(_pins.receiptSha256).not.toBe("b1a82b824482e6fdad5ca4cd0d9b96103706996b42d21fa72ad1814b97a380ff");
    await expect(runStakeQuantityAcceptance(f.input, deps)).rejects.toThrow("invalid_original_grant"); f.deps.proofVerifier.mockImplementation(() => { throw new Error(dummy); }); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("runtime_proof"); expect(f.deps.credentialReader).not.toHaveBeenCalled();
  });
  it.each(["expiry", "provenance"])("rechecks scope and provenance after proof and before credential load (%s)", async (kind) => {
    const f = fixture(); f.deps.proofVerifier.mockImplementation(() => { if (kind === "expiry") f.setTime(Date.parse(expires)); else fs.appendFileSync(f.input.originalGrantFile, " "); });
    await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow(kind === "expiry" ? "scope_expired" : "original_grant_changed");
    expect(f.deps.credentialReader).not.toHaveBeenCalled(); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it("uses the existing real credential reader to refuse an unsafe dummy file", async () => {
    const f = fixture(), key = join(f.root, "dummy-key"); fs.writeFileSync(key, dummy, { mode: 0o644 }); const { credentialReader: _reader, ...deps } = f.deps; expect(_reader).not.toHaveBeenCalled(); await expect(runStakeQuantityAcceptance({ ...f.input, keyFile: key }, deps)).rejects.toThrow("credential_unavailable"); expect(f.deps.network).not.toHaveBeenCalled();
  });
});

describe("single-use private finite capture", () => {
  it("fsyncs reservations before two serial exact GETs, retaining decimal strings and original bytes", async () => {
    const f = fixture(), before = fs.readFileSync(f.input.originalGrantFile); let active = 0, peak = 0; const synced: string[] = [], sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); return sync(fd); }); syncBuiltinESMExports();
    f.deps.network.mockImplementation(async (url, init) => { active++; peak = Math.max(active, peak); const n = url.includes(wallets[0]) ? 1 : 2; expect(saved(f, `attempt-${n}.json`)).toMatchObject({ number: n, wallet: wallets[n - 1], scopeId: STAKE_SCOPE_ID, scopeSha256: f.input.scopeSha256, originalGrantSha256: hash(before) }); expect(synced).toContain(join(f.deps.stateDirectory, `attempt-${n}.json`)); expect(synced).toContain(f.deps.stateDirectory); if (n === 2) expect(saved(f, "completion-1.json")).toMatchObject({ ok: true }); expect(init).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" }); expect(init?.headers).toBeUndefined(); expect(new URL(url).searchParams.get("api_key")).toBe(dummy); await Promise.resolve(); active--; return Response.json(page(wallets[n - 1])); });
    const report = await runStakeQuantityAcceptance(f.input, f.deps); expect(report).toMatchObject({ status: "complete", requests: 2 }); expect(peak).toBe(1); expect(f.deps.network.mock.calls.map(([url]) => { const u = new URL(url); u.searchParams.delete("api_key"); return u.href; })).toEqual(wallets.map((w) => `https://api.dmnd.dev/api/v1/wallets/${w}/stake-accounts?limit=5`)); expect(fs.readFileSync(f.input.originalGrantFile)).toEqual(before);
    const r = saved(f, "response-1.json"); expect(r.json.data[0]).toMatchObject({ lamports: "0", delegated_lamports: "9007199254740993123456789", future_unknown: "18446744073709551615" }); const raw = Buffer.from(r.rawBodyBase64, "base64"); expect(r.rawBodySha256).toBe(hash(raw)); expect(JSON.parse(raw.toString())).toEqual(r.json); expect(report.observations[0]).toMatchObject({ rowCount: 1, partialPage: true, qualification: "unverified", coverage: { complete: false } });
    expect(fs.lstatSync(f.deps.stateDirectory).mode & 0o777).toBe(0o700); for (const n of fs.readdirSync(f.deps.stateDirectory)) expect(fs.lstatSync(join(f.deps.stateDirectory, n)).mode & 0o777).toBe(0o600); const output = JSON.stringify(report) + evidence(f); for (const v of [dummy, encodeURIComponent(dummy), new URLSearchParams({ api_key: dummy }).toString().slice(8)]) expect(output).not.toContain(v);
  });
  it("keeps empty disabled coverage unqualified", async () => { const f = fixture(); f.deps.network.mockImplementation(async (url) => Response.json(page(new URL(url).pathname.split("/").at(-2)!, { data: [], has_more: false, cursor: null }))); expect((await runStakeQuantityAcceptance(f.input, f.deps)).observations[0]).toMatchObject({ rowCount: 0, qualification: "unverified" }); });
  it("refuses repeats, renewed pins and interrupted state before key read", async () => { const f = fixture(); await runStakeQuantityAcceptance(f.input, f.deps); f.deps.network.mockClear(); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("allocation_already_claimed"); const s = scope(); s.expires_at = "2099-10-23T22:30:00Z"; repin(f, s); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("allocation_already_claimed"); expect(f.deps.network).not.toHaveBeenCalled(); const g = fixture(); fs.mkdirSync(g.deps.stateDirectory, { mode: 0o700 }); fs.writeFileSync(join(g.deps.stateDirectory, "attempt-1.json"), "{", { mode: 0o600 }); await expect(runStakeQuantityAcceptance(g.input, g.deps)).rejects.toThrow("allocation_already_claimed"); expect(g.deps.credentialReader).not.toHaveBeenCalled(); });
  it("shares the default allocation across two script checkouts using the same authoritative grant", async () => {
    const f = fixture(), before = fs.readFileSync(f.input.originalGrantFile);
    const scriptDirectory = fileURLToPath(new URL("../../scripts/", import.meta.url));
    const source = fs.readFileSync(join(scriptDirectory, "stake-quantity-acceptance.mjs"), "utf8");
    // Only relocate the runner. Its real reviewed dependencies stay unchanged.
    const standalone = source.replace(/from "(\.\/[^"\n]+)"/g, (_match, specifier: string) => `from "${pathToFileURL(resolve(scriptDirectory, specifier)).href}"`);
    const runners = [];
    for (const name of ["checkout-a", "checkout-b"]) {
      const checkout = join(f.root, name), scripts = join(checkout, "web/scripts");
      fs.mkdirSync(scripts, { recursive: true }); execFileSync("git", ["init", "--quiet", checkout]);
      const file = join(scripts, "stake-quantity-acceptance.mjs"); fs.writeFileSync(file, standalone);
      runners.push(await import(/* @vite-ignore */ pathToFileURL(file).href));
    }
    const { stateDirectory: _unused, ...dependencies } = f.deps;
    expect(_unused).toBe(join(f.root, "state"));
    expect(await runners[0].runStakeQuantityAcceptance(f.input, dependencies)).toMatchObject({ status: "complete", requests: 2 });
    await expect(runners[1].runStakeQuantityAcceptance(f.input, dependencies)).rejects.toThrow("allocation_already_claimed");
    expect(f.deps.network).toHaveBeenCalledTimes(2); expect(f.deps.credentialReader).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(f.input.originalGrantFile)).toEqual(before);
    expect(fs.existsSync(join(f.root, "stake-quantity-acceptance", STAKE_SCOPE_ID, "complete.json"))).toBe(true);
    for (const name of ["checkout-a", "checkout-b"]) expect(fs.existsSync(join(f.root, name, "web/.sites-runtime"))).toBe(false);
  });
  it("excludes simultaneous invocation until calls settle", async () => { const f = fixture(); let started!: () => void, finish!: () => void; const began = new Promise<void>((r) => { started = r; }), gate = new Promise<void>((r) => { finish = r; }); f.deps.network.mockImplementation(async (url) => { started(); await gate; return Response.json(page(new URL(url).pathname.split("/").at(-2)!)); }); const first = runStakeQuantityAcceptance(f.input, f.deps); await began; await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("allocation_already_claimed"); expect(fs.existsSync(join(f.deps.stateDirectory, "lease.json"))).toBe(true); finish(); await first; expect(fs.existsSync(join(f.deps.stateDirectory, "lease.json"))).toBe(false); expect(f.deps.network).toHaveBeenCalledTimes(2); });
  it.each([301, 401, 403, 422, 429, 500, 503])("retains a safe HTTP %s body privately then permanently stops", async (status) => { const f = fixture(); f.deps.network.mockResolvedValue(new Response("safe upstream refusal", { status })); const r = await runStakeQuantityAcceptance(f.input, f.deps); expect(r).toMatchObject({ status: "failed", requests: 1, httpStatus: status }); expect(saved(f, "response-1.json")).toMatchObject({ httpStatus: status }); expect(JSON.stringify(r)).not.toContain("safe upstream refusal"); expect(f.deps.network).toHaveBeenCalledTimes(1); f.deps.network.mockClear(); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("allocation_already_claimed"); expect(f.deps.network).not.toHaveBeenCalled(); });
  it.each(["invalid-json", "wallet", "array", "coverage", "too-many"])("stops on unexpected response %s", async (kind) => { const f = fixture(), p = page(wallets[0]); if (kind === "wallet") p.wallet = wallets[1]; if (kind === "array") p.data = null as never; if (kind === "coverage") p.coverage = {} as never; if (kind === "too-many") p.data = Array(6).fill(p.data[0]); f.deps.network.mockResolvedValue(kind === "invalid-json" ? new Response("not json") : Response.json(p)); expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "failed", requests: 1, error: "invalid_response" }); expect(f.deps.network).toHaveBeenCalledTimes(1); expect(saved(f, "response-1.json")).toHaveProperty("rawBodySha256"); });
  it.each(["declared", "streamed"])("stops on the 64KiB cap (%s)", async (kind) => { const f = fixture(); f.deps.network.mockResolvedValue(kind === "declared" ? new Response("x", { headers: { "content-length": "65537" } }) : new Response(new Uint8Array(65537))); expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "failed", requests: 1, error: "response_too_large" }); expect(f.deps.network).toHaveBeenCalledTimes(1); });
  it.each([dummy, encodeURIComponent(dummy), new URLSearchParams({ api_key: dummy }).toString().slice(8), dummy.replace("s", "\\u0073")])("discards credential echoes without writing or returning a secret body", async (echo) => { const f = fixture(); f.deps.network.mockResolvedValue(new Response(`{"echo":"${echo}"}`, { status: 503 })); const r = await runStakeQuantityAcceptance(f.input, f.deps); expect(r).toMatchObject({ status: "failed", requests: 1, error: "credential_echo" }); expect(fs.existsSync(join(f.deps.stateDirectory, "response-1.json"))).toBe(false); const output = JSON.stringify(r) + evidence(f); expect(output).not.toContain(echo); expect(output).not.toContain(dummy); expect(f.deps.network).toHaveBeenCalledTimes(1); });
  it.each([encodeURIComponent(encodeURIComponent(dummy)), [...dummy].map((c) => "%" + c.charCodeAt(0).toString(16)).join("")])("discards percent-encoded credential echoes after decoding", async (echo) => {
    const f = fixture(); f.deps.network.mockResolvedValue(new Response(JSON.stringify({ echo }), { status: 503 }));
    expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "failed", requests: 1, error: "credential_echo" });
    expect(fs.existsSync(join(f.deps.stateDirectory, "response-1.json"))).toBe(false); expect(evidence(f)).not.toContain(echo);
  });
  it("accepts exactly 65536 bytes without truncating unknown fields", async () => {
    const f = fixture(); f.deps.network.mockImplementation(async (url) => { const body = JSON.stringify(page(new URL(url).pathname.split("/").at(-2)!)); return new Response(body + " ".repeat(65536 - Buffer.byteLength(body))); });
    expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "complete", requests: 2 }); expect(saved(f, "response-1.json").bodyBytes).toBe(65536); expect(Buffer.from(saved(f, "response-1.json").rawBodyBase64, "base64")).toHaveLength(65536);
  });
  it("does not expose raw network exception URLs", async () => { const f = fixture(); f.deps.network.mockRejectedValue(new Error(`https://api.dmnd.dev/?api_key=${encodeURIComponent(dummy)}`)); const r = await runStakeQuantityAcceptance(f.input, f.deps); expect(r).toMatchObject({ status: "failed", error: "request_failed", requests: 1 }); expect(JSON.stringify(r) + evidence(f)).not.toContain("api_key"); });
  it("checks unchanged original bytes before the second reservation", async () => { const f = fixture(); f.deps.network.mockImplementation(async (url) => { fs.appendFileSync(f.input.originalGrantFile, " "); return Response.json(page(new URL(url).pathname.split("/").at(-2)!)); }); expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "failed", requests: 1, error: "original_grant_changed" }); expect(f.deps.network).toHaveBeenCalledTimes(1); expect(fs.existsSync(join(f.deps.stateDirectory, "attempt-2.json"))).toBe(false); });
  it("refuses state symlinks without writing their targets", async () => { const f = fixture(), target = join(f.root, "target"); fs.mkdirSync(target, { mode: 0o700 }); fs.symlinkSync(target, f.deps.stateDirectory); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow(); expect(fs.readdirSync(target)).toEqual([]); expect(f.deps.credentialReader).not.toHaveBeenCalled(); });
  it.each([{ stateDirectory: "/another/allocation" }, { wallets }, { baseURL: "https://foreign.invalid" }, { api_key: dummy }])("rejects configuration that supplies authority or an output override", async (extra) => { const f = fixture(); await expect(runStakeQuantityAcceptance({ ...f.input, ...extra }, f.deps)).rejects.toThrow("invalid_configuration"); expect(f.deps.credentialReader).not.toHaveBeenCalled(); });
});

describe("hard request and body deadlines", () => {
  it.each([5000, 1000])("cancels a stalled body at %sms including hard expiry", async (duration) => { const f = fixture(); if (duration === 1000) f.setTime(Date.parse(expires) - 1000); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let began!: () => void, cancelled = false; const start = new Promise<void>((r) => { began = r; }); f.deps.network.mockImplementation(async () => new Response(new ReadableStream({ start() { began(); }, cancel() { cancelled = true; } }))); const pending = runStakeQuantityAcceptance(f.input, f.deps); await start; await vi.advanceTimersByTimeAsync(duration); expect(await pending).toMatchObject({ status: "failed", requests: 1, error: duration === 1000 ? "scope_expired" : "timeout" }); expect(cancelled).toBe(true); expect(f.deps.network).toHaveBeenCalledTimes(1); });
  it("holds the lease until an aborted network promise has actually settled", async () => { const f = fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let began!: () => void, settle!: () => void; const start = new Promise<void>((r) => { began = r; }), gate = new Promise<void>((r) => { settle = r; }); f.deps.network.mockImplementation(async (_url, init) => { began(); await new Promise<void>((r) => init?.signal?.addEventListener("abort", () => r(), { once: true })); await gate; throw new Error(dummy); }); let completed = false; const pending = runStakeQuantityAcceptance(f.input, f.deps).then((r: unknown) => { completed = true; return r; }); await start; await vi.advanceTimersByTimeAsync(5000); expect(completed).toBe(false); expect(fs.existsSync(join(f.deps.stateDirectory, "lease.json"))).toBe(true); settle(); expect(await pending).toMatchObject({ status: "failed", error: "timeout", requests: 1 }); expect(fs.existsSync(join(f.deps.stateDirectory, "lease.json"))).toBe(false); });
  it("retains an uncertain lease when fetch ignores abort and never writes late evidence", async () => {
    const f = fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let began!: () => void, finish!: () => void;
    const start = new Promise<void>((r) => { began = r; }), gate = new Promise<void>((r) => { finish = r; });
    f.deps.network.mockImplementation(async () => { began(); await gate; return Response.json(page(wallets[0])); });
    const pending = runStakeQuantityAcceptance(f.input, f.deps); await start; await vi.advanceTimersByTimeAsync(5100);
    expect(await pending).toMatchObject({ status: "failed", requests: 1, error: "timeout", networkSettled: false }); expect(fs.existsSync(join(f.deps.stateDirectory, "lease.json"))).toBe(true);
    const before = evidence(f); finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(evidence(f)).toBe(before); expect(f.deps.network).toHaveBeenCalledTimes(1); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("allocation_already_claimed");
  });
  it("refuses a body completed exactly at expiry and never starts the second call", async () => { const f = fixture(); f.deps.network.mockImplementation(async (url) => { f.setTime(Date.parse(expires)); return Response.json(page(new URL(url).pathname.split("/").at(-2)!)); }); expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "failed", requests: 1, error: "scope_expired" }); expect(f.deps.network).toHaveBeenCalledTimes(1); });
});

describe("V4 exact custody scope", () => {
  it("normalizes the exact V4 machine scope and makes only two private fixed reads", async () => {
    const f = fixture(), v4 = v4Scope(f); repin(f, v4);
    expect(readStakeScope(f.input.scopeFile, f.input.scopeSha256, { now: epoch, worktrees: [] })).toMatchObject({ scopeId: STAKE_SCOPE_ID, maxAttempts: 2, wallets, credentialPath: f.input.keyFile, expiresAt: expires });
    expect(await runStakeQuantityAcceptance(f.input, f.deps)).toMatchObject({ status: "complete", requests: 2 }); expect(f.deps.network).toHaveBeenCalledTimes(2);
  });
  it.each(["total", "all-versions", "per-wallet", "deadline", "bytes", "provider", "enqueue", "flags", "redirects", "retry", "cursor", "extra", "wallet", "endpoint", "credential-allowed", "uid", "mode", "symlink", "historical-pin"])("rejects widened or inconsistent V4 machine policy %s", async (kind) => {
    const f = fixture(), s = v4Scope(f);
    if (kind === "total") s.max_total_stake_GET_attempts_across_original_and_renewal = 3;
    if (kind === "all-versions") s.max_total_stake_GET_attempts_across_all_scope_versions = 3;
    if (kind === "per-wallet") s.per_wallet_attempts = 2;
    if (kind === "deadline") s.limits.per_attempt_deadline_seconds = 6;
    if (kind === "bytes") s.limits.max_body_bytes = 65537;
    if (kind === "provider") s.limits.provider_calls = 1;
    if (kind === "enqueue") s.limits.enqueue_calls = 1;
    if (kind === "flags") s.limits.flag_changes = 1;
    if (kind === "redirects") s.limits.redirects = 1;
    if (kind === "retry") s.limits.retries = 1;
    if (kind === "cursor") s.limits.cursor_pages = 1;
    if (kind === "extra") Object.assign(s.limits, { another_allocation: 1 });
    if (kind === "wallet") s.wallets = [wallets[0], "foreign"];
    if (kind === "endpoint") s.endpoint += "&cursor=foreign";
    if (kind === "credential-allowed") s.credential_path_allowed = false;
    if (kind === "uid") s.credential_path_metadata_only.uid += 1;
    if (kind === "mode") s.credential_path_metadata_only.mode = "0644";
    if (kind === "symlink") s.credential_path_metadata_only.symlink = true;
    if (kind === "historical-pin") s.original_expired_preserved.sha256 = "0".repeat(64);
    repin(f, s); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("invalid_scope"); expect(f.deps.credentialReader).not.toHaveBeenCalled(); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it.each(["wrong-path", "inode", "device", "actual-mode", "actual-symlink"])("refuses V4 credential custody mismatch before reading bytes (%s)", async (kind) => {
    const f = fixture(), s = v4Scope(f); if (kind === "inode") s.credential_path_metadata_only.inode++; if (kind === "device") s.credential_path_metadata_only.device++;
    if (kind === "wrong-path") f.input.keyFile = join(f.root, "other-key");
    if (kind === "actual-mode") fs.chmodSync(f.input.keyFile, 0o644);
    if (kind === "actual-symlink") { fs.renameSync(f.input.keyFile, f.input.keyFile + ".target"); fs.symlinkSync(f.input.keyFile + ".target", f.input.keyFile); }
    repin(f, s); await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("credential_unavailable"); expect(f.deps.credentialReader).not.toHaveBeenCalled(); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it("rejects expired V4 and metadata replacement during proof before credential reading", async () => {
    const f = fixture(), s = v4Scope(f); repin(f, s); f.setTime(Date.parse(expires));
    await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("scope_expired"); f.setTime(epoch);
    f.deps.proofVerifier.mockImplementation(() => { fs.renameSync(f.input.keyFile, f.input.keyFile + ".old"); fs.writeFileSync(f.input.keyFile, dummy, { mode: 0o600 }); });
    await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("credential_unavailable"); expect(f.deps.credentialReader).not.toHaveBeenCalled();
  });
  it("cannot renew a consumed legacy allocation using V4 or a new hash", async () => {
    const f = fixture(); await runStakeQuantityAcceptance(f.input, f.deps); f.deps.network.mockClear(); f.deps.credentialReader.mockClear(); repin(f, v4Scope(f));
    await expect(runStakeQuantityAcceptance(f.input, f.deps)).rejects.toThrow("allocation_already_claimed"); expect(f.deps.network).not.toHaveBeenCalled(); expect(f.deps.credentialReader).not.toHaveBeenCalled();
  });
});
