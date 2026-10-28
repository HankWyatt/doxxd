// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { APPROVED_WALLETS, compareNativeClockRounds, extractNativeClockObservation, runNativeClockPhase } from "../../scripts/native-clock-validation.mjs";
const baseURL = "http://127.0.0.1:4317/";
const sha = "a".repeat(64);
const epoch = Date.parse("2026-10-23T09:00:00Z");
const directories: string[] = [];
type Receipt = { receiptSha256: string; oldCap: number; newCap: number; alreadyUsed: number; additionalRequests: number; wallets: string[]; resources: string[]; expiresAt: string; maxBytes: number; timeoutMs: number };
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function envelope(wallet: string, extra: Record<string, unknown> = {}, assets = 3) {
  return { ok: true, data: { wallet, assets: Array.from({ length: assets }, (_, i) => ({ mint: `synthetic-${i}`, amount: "9007199254740993123456789", value_usd: null })), coverage: { complete: false, token_snapshot_slot: 999999, balance_live_slot: 999998, native_sol_slot: 8888 }, native_sol_lamports: "0", wrapped_sol_lamports: "9007199254740993123456789", native_sol_slot: 100, wrapped_sol_slot: 80, sol_price_usd: "150.123456789", sol_price_updated_at: "2026-10-23T08:00:00Z", ...extra } };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doxxd-native-clock-")); directories.push(root);
  const config = { baseURL, phase: "initial-trigger", stateDirectory: join(root, "state"), extensionReceiptFile: join(root, "receipt.json"), extensionReceiptSha256: sha };
  let clock = epoch;
  const readReceipt = vi.fn(async (..._args: unknown[]): Promise<Readonly<Receipt>> => Object.freeze({ receiptSha256: sha, oldCap: 34, newCap: 42, alreadyUsed: 29, additionalRequests: 8, wallets: [...APPROVED_WALLETS], resources: ["overview"], expiresAt: "2026-10-23T10:15:00.000Z", maxBytes: 8388608, timeoutMs: 8000 }));
  const network = vi.fn(async (url: string, _init?: RequestInit) => Response.json(envelope(url.split("/").at(-2)!)));
  return { config, deps: { now: () => clock, readReceipt, network }, setClock: (time: number) => { clock = time; } };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, phase: string) { return runNativeClockPhase({ ...f.config, phase }, f.deps); }
async function initial(f: Awaited<ReturnType<typeof fixture>>) { await run(f, "initial-trigger"); return run(f, "initial-confirmation"); }
describe("native clock phase capture", () => {
  it.each([true, false])("checks the real receipt reader with a matching pin: %s", async (matching) => {
    const f = await fixture();
    const packet = JSON.stringify({ new_bounded_validation_allocation: {
      additional_requests_max: 8, old_lifetime_cap: 34, new_lifetime_cap: 42, already_used: 29,
      allowed_wallets: [...APPROVED_WALLETS], allowed_resources: ["overview"],
      unpaged_overview: true, response_max_bytes: 8388608, timeout_ms: 8000,
      expires_at: "2026-10-23T10:15:00Z",
    } });
    await writeFile(f.config.extensionReceiptFile, packet, { mode: 0o600 });
    const config = { ...f.config, extensionReceiptSha256: matching ? createHash("sha256").update(packet).digest("hex") : "0".repeat(64) };
    const runDefault = () => runNativeClockPhase(config, { network: f.deps.network, now: f.deps.now });
    if (matching) {
      expect(await runDefault()).toMatchObject({ status: "complete", requests: 2 });
      expect(f.deps.network).toHaveBeenCalledTimes(2);
    } else {
      await expect(runDefault()).rejects.toThrow("invalid_extension_receipt");
      expect(f.deps.network).not.toHaveBeenCalled();
    }
    expect(f.deps.readReceipt).not.toHaveBeenCalled();
  });
  it("makes two serial exact overview calls and privately retains all 1037 assets", async () => {
    const f = await fixture(); let active = 0; let peak = 0;
    f.deps.network.mockImplementation(async (url: string, init?: RequestInit) => {
      active++; peak = Math.max(peak, active);
      const ordinal = url.includes(APPROVED_WALLETS[0]) ? 1 : 2;
      expect(JSON.parse(await readFile(join(f.config.stateDirectory, `initial-trigger.attempt-${ordinal}.json`), "utf8"))).toMatchObject({ phase: "initial-trigger", wallet: APPROVED_WALLETS[ordinal - 1], requestStartedAt: "2026-10-23T09:00:00.000Z" });
      if (ordinal === 2) expect(JSON.parse(await readFile(join(f.config.stateDirectory, "initial-trigger.result-1.json"), "utf8"))).toMatchObject({ ok: true });
      expect(init).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" }); expect(init?.headers).toBeUndefined();
      await Promise.resolve(); active--; return Response.json(envelope(url.split("/").at(-2)!, {}, 1037));
    });
    const report = await run(f, "initial-trigger"); expect(report.status).toBe("complete"); expect(peak).toBe(1);
    expect(f.deps.network.mock.calls.map(([url]) => url)).toEqual(APPROVED_WALLETS.map((wallet: string) => `${baseURL}api/wallet/${wallet}/overview`));
    expect(f.deps.readReceipt).toHaveBeenCalledWith(f.config.extensionReceiptFile, sha, { now: epoch });
    const names = await readdir(f.config.stateDirectory); const responses = names.filter((name) => name.includes("response")); expect(responses).toHaveLength(2);
    for (const name of names) expect((await lstat(join(f.config.stateDirectory, name))).mode & 0o777).toBe(0o600);
    expect((await lstat(f.config.stateDirectory)).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(await readFile(join(f.config.stateDirectory, responses[0]), "utf8"));
    expect(saved.envelope.data.assets).toHaveLength(1037); expect(saved.envelope.data.assets[1036].amount).toBe("9007199254740993123456789");
    expect(saved.envelope.data.coverage).toEqual(envelope(APPROVED_WALLETS[0]).data.coverage);
    expect(saved).toMatchObject({ status: 200, observedAt: "2026-10-23T09:00:00.000Z" }); expect(JSON.stringify(report)).not.toContain("synthetic-1036");
  });
  it("refuses 119999ms without fetching and accepts 120000ms", async () => {
    const f = await fixture(); await initial(f); f.deps.network.mockClear(); f.setClock(epoch + 119999);
    await expect(run(f, "advance-trigger")).rejects.toThrow("clock_wait_required"); expect(f.deps.network).not.toHaveBeenCalled();
    f.setClock(epoch + 120000); expect((await run(f, "advance-trigger")).status).toBe("complete"); expect(f.deps.network).toHaveBeenCalledTimes(2);
    f.deps.network.mockImplementation(async (url: string) => Response.json(envelope(url.split("/").at(-2)!, { native_sol_slot: 101, wrapped_sol_slot: 81 })));
    expect((await run(f, "advance-confirmation")).comparison).toMatchObject({ clockAdvanceProven: true, reasons: [] });
  });
  it("refuses duplicate, out-of-order and interrupted phases before fetching", async () => {
    const f = await fixture(); await expect(run(f, "initial-confirmation")).rejects.toThrow("phase_order"); expect(f.deps.network).not.toHaveBeenCalled();
    await run(f, "initial-trigger"); f.deps.network.mockClear();
    await expect(run(f, "initial-trigger")).rejects.toThrow("phase_already_started"); await expect(run(f, "advance-confirmation")).rejects.toThrow("phase_order");
    await writeFile(join(f.config.stateDirectory, "initial-confirmation.start.json"), JSON.stringify({ phase: "initial-confirmation", startedAt: new Date(epoch).toISOString() }), { mode: 0o600 });
    await expect(run(f, "initial-confirmation")).rejects.toThrow("phase_already_started"); await expect(run(f, "advance-trigger")).rejects.toThrow("phase_incomplete"); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it.each([301, 401, 403, 429, 500])("halts on HTTP %s and permanently closes later phases", async (status) => {
    const f = await fixture(); f.deps.network.mockImplementation(async () => new Response("raw-upstream-error", { status }));
    const report = await run(f, "initial-trigger"); expect(report).toMatchObject({ status: "failed", requests: 1 }); expect(f.deps.network).toHaveBeenCalledTimes(1); expect(JSON.stringify(report)).not.toContain("raw-upstream-error");
    f.deps.network.mockClear(); for (const phase of ["initial-trigger", "initial-confirmation", "advance-trigger", "advance-confirmation"]) await expect(run(f, phase)).rejects.toThrow(); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it.each([{ ok: false, data: {} }, { ok: true, data: { wallet: "different", assets: [] } }, { ok: true, data: { wallet: "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa", assets: null } }])("halts on a bad envelope", async (body) => {
    const f = await fixture(); f.deps.network.mockImplementation(async () => Response.json(body)); expect(await run(f, "initial-trigger")).toMatchObject({ status: "failed", error: "invalid_response", requests: 1 }); expect(f.deps.network).toHaveBeenCalledTimes(1);
  });
  it.each(["declared", "streamed"])("halts on an oversized %s body", async (kind) => {
    const f = await fixture(); f.deps.network.mockImplementation(async () => kind === "declared" ? new Response("x", { headers: { "content-length": "8388609" } }) : new Response(new Uint8Array(8388609)));
    expect(await run(f, "initial-trigger")).toMatchObject({ status: "failed", error: "response_too_large", requests: 1 }); expect(f.deps.network).toHaveBeenCalledTimes(1);
  });
  it("times out a stalled body at 8000ms without starting the second call", async () => {
    const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let beginBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { beginBody = resolve; });
    f.deps.network.mockImplementation(async (_url: string, init?: RequestInit) => new Response(new ReadableStream({ start(controller) { beginBody(); init?.signal?.addEventListener("abort", () => controller.error(new Error("raw-upstream-error"))); } })));
    const pending = run(f, "initial-trigger"); await bodyStarted; await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toMatchObject({ status: "failed", error: "timeout", requests: 1 }); expect(f.deps.network).toHaveBeenCalledTimes(1);
  });
  it("rechecks expiry before the second call and preserves the first response", async () => {
    const f = await fixture();
    f.deps.network.mockImplementation(async (url: string) => {
      f.setClock(Date.parse("2026-10-23T10:15:00Z"));
      return Response.json(envelope(url.split("/").at(-2)!));
    });
    expect(await run(f, "initial-trigger")).toMatchObject({ status: "failed", error: "extension_expired", requests: 1 });
    expect(f.deps.network).toHaveBeenCalledTimes(1);
    expect((await readdir(f.config.stateDirectory)).filter((name) => name.includes("response"))).toHaveLength(1);
  });
  it("does not repeat a completed first request after the second request fails", async () => {
    const f = await fixture();
    f.deps.network.mockResolvedValueOnce(Response.json(envelope(APPROVED_WALLETS[0]))).mockResolvedValueOnce(new Response("raw-upstream-error", { status: 429 }));
    expect(await run(f, "initial-trigger")).toMatchObject({ status: "failed", requests: 2, httpStatus: 429 });
    f.deps.network.mockClear();
    await expect(run(f, "initial-trigger")).rejects.toThrow();
    await expect(run(f, "initial-confirmation")).rejects.toThrow();
    expect(f.deps.network).not.toHaveBeenCalled();
  });
  it.each([{ baseURL: "http://localhost:4317/" }, { baseURL: "https://127.0.0.1:4317/" }, { baseURL: "http://127.0.0.1:80/" }, { baseURL: "http://127.1:4317/" }, { baseURL: "http://127.0.0.1:4317/api" }, { baseURL: "http://127.0.0.1:4317/?key=x" }, { baseURL: "http://user:secret@127.0.0.1:4317/" }, { token: "secret" }, { wallets: ["foreign"] }])("rejects out-of-scope or secret-bearing configuration", async (extra) => {
    const f = await fixture(); await expect(runNativeClockPhase({ ...f.config, ...extra }, f.deps)).rejects.toThrow("invalid_configuration"); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it("rejects altered or expired receipt policy before fetching", async () => {
    const f = await fixture(); const receipt = await f.deps.readReceipt();
    for (const change of [{ newCap: 43 }, { alreadyUsed: 28 }, { additionalRequests: 9 }, { resources: ["summary"] }, { expiresAt: "2026-10-23T11:15:00Z" }, { maxBytes: 9000000 }, { timeoutMs: 9000 }]) {
      f.deps.readReceipt.mockResolvedValueOnce(Object.freeze({ ...receipt, ...change })); await expect(run(f, "initial-trigger")).rejects.toThrow("invalid_extension_receipt");
    }
    f.setClock(Date.parse("2026-10-23T10:15:00Z")); await expect(run(f, "initial-trigger")).rejects.toThrow("extension_expired"); expect(f.deps.network).not.toHaveBeenCalled();
  });
  it("refuses unsafe directories and symlink evidence without overwriting", async () => {
    const f = await fixture(); await symlink(join(f.config.stateDirectory, ".."), f.config.stateDirectory); await expect(run(f, "initial-trigger")).rejects.toThrow("unsafe_state"); await rm(f.config.stateDirectory);
    await run(f, "initial-trigger"); f.deps.network.mockClear(); await chmod(f.config.stateDirectory, 0o755); await expect(run(f, "initial-confirmation")).rejects.toThrow("unsafe_state"); await chmod(f.config.stateDirectory, 0o700);
    await symlink(join(f.config.stateDirectory, "initial-trigger.start.json"), join(f.config.stateDirectory, "initial-confirmation.start.json"));
    await expect(run(f, "initial-confirmation")).rejects.toThrow("unsafe_state"); expect(f.deps.network).not.toHaveBeenCalled();
  });
});
describe("independent native and wrapped SOL clocks", () => {
  it("retains zero, huge decimal quantities, absent/null clocks and observed prices", () => {
    expect(extractNativeClockObservation(envelope(APPROVED_WALLETS[0], { native_sol_slot: null, wrapped_sol_slot: 0 }), APPROVED_WALLETS[0])).toMatchObject({ native_sol_lamports: "0", wrapped_sol_lamports: "9007199254740993123456789", native_sol_slot: null, wrapped_sol_slot: 0, sol_price_usd: "150.123456789", sol_price_updated_at: "2026-10-23T08:00:00Z" });
    const missing = envelope(APPROVED_WALLETS[0]); delete (missing.data as Record<string, unknown>).native_sol_slot; delete (missing.data as Record<string, unknown>).native_sol_lamports;
    expect(extractNativeClockObservation(missing, APPROVED_WALLETS[0])).not.toHaveProperty("native_sol_slot"); expect(extractNativeClockObservation(missing, APPROVED_WALLETS[0])).not.toHaveProperty("native_sol_lamports");
  });
  function round(phase: string, extra = {}) { const observedAt = phase === "advance-confirmation" ? epoch + 120000 : epoch; return { phase, status: "complete", startedAt: new Date(observedAt).toISOString(), completedAt: new Date(observedAt).toISOString(), advanceTriggerStartedAt: new Date(epoch + 120000).toISOString(), observations: APPROVED_WALLETS.map((wallet: string) => extractNativeClockObservation(envelope(wallet, extra), wallet)) }; }
  it("proves both wallets' strictly advancing independent clocks only", () => {
    expect(compareNativeClockRounds(round("initial-confirmation"), round("advance-confirmation", { native_sol_slot: 101, wrapped_sol_slot: 81 }))).toMatchObject({ clockAdvanceProven: true, reasons: [] });
  });
  it.each([{ native_sol_slot: null }, { wrapped_sol_slot: null }, { wrapped_sol_slot: 80 }, { native_sol_slot: 99 }, { native_sol_lamports: null }, { wrapped_sol_lamports: null }])("reports unproven reasons for unknown, equal or decreasing data", (change) => {
    const result = compareNativeClockRounds(round("initial-confirmation"), round("advance-confirmation", { native_sol_slot: 101, wrapped_sol_slot: 81, ...change })); expect(result.clockAdvanceProven).toBe(false); expect(result.reasons.length).toBeGreaterThan(0);
  });
  it("reports mismatched wallets and insufficient elapsed time as unproven", () => {
    const initial = round("initial-confirmation"); const advanced = round("advance-confirmation", { native_sol_slot: 101, wrapped_sol_slot: 81 }); advanced.observations.pop(); expect(compareNativeClockRounds(initial, advanced)).toMatchObject({ clockAdvanceProven: false });
    const early = round("advance-confirmation", { native_sol_slot: 101, wrapped_sol_slot: 81 }); early.advanceTriggerStartedAt = new Date(epoch + 119999).toISOString(); expect(compareNativeClockRounds(initial, early).reasons).toContain("required_elapsed_time_unproven");
  });
  it("does not prove clocks using invalid round chronology or an unknown initial quantity", () => {
    const before = round("initial-confirmation", { native_sol_lamports: null });
    const after = round("advance-confirmation", { native_sol_slot: 101, wrapped_sol_slot: 81 });
    expect(compareNativeClockRounds(before, after).clockAdvanceProven).toBe(false);
    after.startedAt = new Date(epoch).toISOString();
    expect(compareNativeClockRounds(round("initial-confirmation"), after).reasons).toContain("confirmed_round_chronology_unproven");
  });
});
