import {
  constants, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync,
  lstatSync, mkdirSync, realpathSync, unlinkSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APPROVED_WALLETS } from "./dmnd-acceptance.mjs";
import { loadExtensionReceipt, readGrant, validateGrant } from "./native-overview-extension.mjs";
import { runtimeConfiguration } from "./run-dmnd.mjs";
import { assertRuntimeProof } from "./verify-dmnd-runtime.mjs";

export const STAKE_SCOPE_ID = "doxxd-native-stake-quantity-read-two-existing-wallets-20261023";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const BASE = "https://api.dmnd.dev/api/v1";
const PROGRAM = "Stake11111111111111111111111111111111111111";
const SUPPORTED_SCOPE = "native_stake_program_withdrawer";
const MAX_BYTES = 65536, TIMEOUT_MS = 5000, CLEANUP_MS = 100;
const HISTORICAL_PINS = Object.freeze({
  receiptSha256: "b1a82b824482e6fdad5ca4cd0d9b96103706996b42d21fa72ad1814b97a380ff",
  originalLedgerSha256: "1f0e31bff26e273652e3a94dc9c17b737bfd36e6a88667103579ff74c341e973",
});
const inputFields = ["scopeFile", "scopeSha256", "keyFile", "originalGrantFile", "originalReceiptFile"];
const scopeFields = ["at", "controller", "recipient", "relay_capable_coordinators", "scope_id", "state", "expires_at", "source_evidence", "requests", "provider_budget", "resource_profile", "acceptance", "not_authorized", "delivery"];
const requestFields = ["base", "method", "path_template", "query", "wallets", "max_attempts_total", "max_attempts_per_wallet", "request_timeout_seconds", "response_max_bytes_per_call", "no_retry", "no_cursor_follow", "separate_from_existing_core_five"];
const fail = (code) => { throw new Error(code); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const keys = (v, allowed) => plain(v) && Object.keys(v).every((key) => allowed.includes(key));
const exact = (v, fields) => keys(v, fields) && fields.every((key) => Object.hasOwn(v, key));
const absolute = (v) => typeof v === "string" && v.length <= 4096 && !v.includes("\0") && isAbsolute(v) && resolve(v) === v;
function clock(now) {
  const n = now();
  if (!Number.isSafeInteger(n) || n < 0) fail("invalid_clock");
  return n;
}
const timestamp = (now) => new Date(clock(now)).toISOString();
function expiry(v) {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return NaN;
  const n = Date.parse(v);
  return Number.isFinite(n) && new Date(n).toISOString() === v.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => "." + (fraction ?? "").padEnd(3, "0") + "Z") ? n : NaN;
}
function worktrees() {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot, encoding: "utf8" }).split("\n").filter((v) => v.startsWith("worktree ")).map((v) => v.slice(9));
}
function inTree(file, tree) {
  const r = relative(tree, file);
  return !r || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
function readOwned(file, maxBytes, privateMode) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.size < 1 || st.size > maxBytes ||
        (privateMode ? (st.mode & 0o7777) !== 0o600 : (st.mode & 0o022) !== 0)) throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1); let size = 0, count;
    do { count = readSync(fd, bytes, size, bytes.length - size, null); size += count; } while (count && size <= maxBytes);
    if (size !== st.size || size > maxBytes) throw new Error();
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

const V4_REVISION = "V4_EXACT_EXISTING_SERVER_CUSTODY_PATH_NO_NEW_ATTEMPTS";
const originalStakeScopeSha256 = "265ea5208f601a264a3bdc56bf385e04f7f245d9b3ec5200981d8eb6a2b62e3b";
const v4Fields = ["at", "status", "recipient", "relay", "original_expired_preserved", "reported_original_attempts", "basis", "expires_at", "max_total_stake_GET_attempts_across_original_and_renewal", "original_five_CORE_rights_and_ledger37", "wallets", "endpoint", "per_wallet_attempts", "limits", "stop_remaining_on", "credential_custody", "consumer_guard", "runtime_source", "acceptance", "current_rollout_receipt", "new_user_permission_question_required", "recipient_ACK", "revision", "scope_id", "wallet_binding", "previous_renewal_preserved", "max_total_stake_GET_attempts_across_all_scope_versions", "previous_v3_preserved", "credential_path", "credential_path_metadata_only", "credential_path_allowed", "credential_path_permission", "counter_must_resume_never_reset"];
function v4Scope(scope) {
  const limits = scope.limits, old = scope.original_expired_preserved, metadata = scope.credential_path_metadata_only;
  if (!exact(scope, v4Fields) || scope.revision !== V4_REVISION || scope.status !== "RENEWED_SAME_TWO_ATTEMPTS_NOT_AN_INCREASE" ||
      scope.recipient !== "00000000-0000-4000-8000-000000000001" || scope.scope_id !== STAKE_SCOPE_ID || !Number.isFinite(expiry(scope.expires_at)) ||
      scope.max_total_stake_GET_attempts_across_original_and_renewal !== 2 || scope.max_total_stake_GET_attempts_across_all_scope_versions !== 2 ||
      scope.per_wallet_attempts !== 1 || !same(scope.wallets, APPROVED_WALLETS) || scope.endpoint !== BASE + "/wallets/{wallet}/stake-accounts?limit=5" ||
      !exact(limits, ["per_attempt_deadline_seconds", "max_body_bytes", "retries", "cursor_pages", "redirects", "provider_calls", "enqueue_calls", "flag_changes", "job_or_SQL_or_service_or_build_or_gate_allocation"]) ||
      limits.per_attempt_deadline_seconds !== 5 || limits.max_body_bytes !== MAX_BYTES ||
      ["retries", "cursor_pages", "redirects", "provider_calls", "enqueue_calls", "flag_changes", "job_or_SQL_or_service_or_build_or_gate_allocation"].some((key) => limits[key] !== 0) ||
      !exact(old, ["path", "sha256", "expires_at"]) || !absolute(old.path) || old.sha256 !== originalStakeScopeSha256 || old.expires_at !== "2026-10-23T21:30:00Z" ||
      scope.reported_original_attempts !== 0 || scope.credential_path_allowed !== true || !absolute(scope.credential_path) ||
      !exact(metadata, ["regular", "symlink", "uid", "gid", "mode", "nlink", "device", "inode", "key_bytes_read_by_root_for_this_metadata"]) ||
      metadata.regular !== true || metadata.symlink !== false || metadata.uid !== process.getuid?.() || metadata.gid !== process.getgid?.() || metadata.mode !== "0600" || metadata.nlink !== 1 ||
      !Number.isSafeInteger(metadata.device) || metadata.device < 0 || !Number.isSafeInteger(metadata.inode) || metadata.inode < 1 || metadata.key_bytes_read_by_root_for_this_metadata !== false ||
      scope.new_user_permission_question_required !== false || typeof scope.recipient_ACK !== "boolean" ||
      !same(scope.stop_remaining_on, ["authfailure", "429", "5xx", "expiredscope", "counter/credentialcustodyambiguity"])) throw new Error();
  // Historical pointers and descriptive text do not allocate attempts or override the counter.
  return { credentialPath: scope.credential_path, credentialMetadata: Object.freeze({ ...metadata }), originalStakeScopeSha256 };
}
function assertScopedCredential(scope, file, trees) {
  if (scope.credentialPath === undefined) return;
  try {
    if (file !== scope.credentialPath || realpathSync(file) !== file || trees.some((tree) => inTree(file, tree))) throw new Error();
    const st = lstatSync(file), expected = scope.credentialMetadata;
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.uid !== expected.uid || st.gid !== expected.gid ||
        (st.mode & 0o7777) !== 0o600 || st.nlink !== 1 || st.dev !== expected.device || st.ino !== expected.inode) throw new Error();
  } catch { fail("credential_unavailable"); }
}

/** Machine fields grant authority; descriptive wallet text is never interpreted.
 * @param {string} file @param {string} digest
 * @param {{now?:number,worktrees?:string[]}} [options]
 */
export function readStakeScope(file, digest, options = {}) {
  let result;
  try {
    const now = options.now ?? Date.now(), trees = options.worktrees ?? worktrees();
    if (!absolute(file) || !sha(digest) || !Number.isSafeInteger(now) || !Array.isArray(trees) ||
        realpathSync(file) !== file || trees.some((tree) => inTree(file, tree))) throw new Error();
    const bytes = readOwned(file, MAX_BYTES, false);
    if (hash(bytes) !== digest) throw new Error();
    const scope = JSON.parse(bytes.toString("utf8")), r = scope.requests, p = scope.provider_budget, profile = scope.resource_profile;
    let custody = {};
    if (scope.revision === V4_REVISION) custody = v4Scope(scope);
    else {
    if (!exact(scope, scopeFields) || scope.scope_id !== STAKE_SCOPE_ID ||
        scope.controller !== "00000000-0000-4000-8000-000000000002" || scope.recipient !== "00000000-0000-4000-8000-000000000001" ||
        scope.state !== "AUTHORIZED_FINITE_CONSUMER_GET_ONLY_NO_PROVIDER_OR_FLAG_OPERATION" || !Number.isFinite(expiry(scope.expires_at)) ||
        !exact(r, requestFields) || r.base !== BASE || r.method !== "GET" || r.path_template !== "/wallets/{wallet}/stake-accounts" ||
        !exact(r.query, ["limit"]) || r.query.limit !== 5 || r.max_attempts_total !== 2 || r.max_attempts_per_wallet !== 1 ||
        r.request_timeout_seconds !== 5 || r.response_max_bytes_per_call !== MAX_BYTES || r.no_retry !== true || r.no_cursor_follow !== true ||
        typeof r.wallets !== "string" ||
        !exact(p, ["Helius_or_other_upstream_calls_allocated", "enqueues_allocated", "proof", "abort_if"]) ||
        p.Helius_or_other_upstream_calls_allocated !== 0 || p.enqueues_allocated !== 0 ||
        !exact(profile, ["program", "supported_scope", "resource_identity", "role"]) || profile.program !== PROGRAM || profile.supported_scope !== SUPPORTED_SCOPE ||
        !keys(scope.source_evidence, ["actual_flag_read", "api", "worker", "receipt", "source_pins"])) throw new Error();
    for (const [actor, flag] of [["api", "API_WALLET_STAKE_ENABLED"], ["worker", "WORKER_WALLET_STAKE_ENABLED"]]) {
      const identity = scope.source_evidence[actor];
      if (!keys(identity, ["at", "read_only", "id", "image", "pid", "restart_count", "source", "selected_flags"]) ||
          !plain(identity.selected_flags) || identity.selected_flags[flag]?.effective !== "false") throw new Error();
      for (const [name, selected] of Object.entries(identity.selected_flags)) {
        if (!new RegExp("^" + actor.toUpperCase() + "_(?:WALLET_STAKE|DEFI_KAMINO|DEFI_SOLEND|DEFI_MARGINFI|ORCA|RAYDIUM_CLMM)_ENABLED$").test(name) ||
            !exact(selected, ["configured", "effective"]) || typeof selected.configured !== "boolean" || selected.effective !== "false") throw new Error();
      }
    }
    }
    result = Object.freeze({ ...custody, scopeId: STAKE_SCOPE_ID, scopeSha256: digest, wallets: Object.freeze([...APPROVED_WALLETS]), maxAttempts: 2, expiresAt: scope.expires_at, expiresMs: expiry(scope.expires_at) });
    if (now >= result.expiresMs) fail("scope_expired");
  } catch (error) { if (error?.message === "scope_expired") fail("scope_expired"); fail("invalid_scope"); }
  return result;
}
function originalGrant(input, trees, pins, now) {
  try {
    if (!exact(pins, ["receiptSha256", "originalLedgerSha256"]) || !sha(pins.receiptSha256) || !sha(pins.originalLedgerSha256) || realpathSync(input.originalGrantFile) !== input.originalGrantFile) throw new Error();
    const receipt = loadExtensionReceipt(input.originalReceiptFile, pins.receiptSha256, trees, true, now);
    const { state, bytes } = readGrant(input.originalGrantFile);
    validateGrant(state, receipt);
    if (state.allocatedRequests !== 42 || state.usedRequests !== 37 || state.baseUsedRequests !== 29 || state.bonusUsedRequests !== 8 ||
        state.extensionHalt !== undefined || state.extension.originalLedgerSha256 !== pins.originalLedgerSha256 ||
        state.requests.some((row) => row.status !== 200) ||
        !same([...new Set(state.requests.slice(0, 29).map((row) => row.wallet))].sort(), [...APPROVED_WALLETS].sort())) throw new Error();
    return { originalGrantSha256: hash(bytes), originalLedgerSha256: state.extension.originalLedgerSha256, originalReceiptSha256: receipt.receiptSha256 };
  } catch { fail("invalid_original_grant"); }
}
function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function noSymlinkDirectories(directory, create = false) {
  let current = sep;
  for (const part of directory.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }); syncDirectory(dirname(current)); }
      catch (e) { if (e?.code !== "EEXIST") fail("unsafe_state"); }
    }
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail("unsafe_state");
  }
}
function privateDirectory(directory) {
  noSymlinkDirectories(directory);
  const st = lstatSync(directory);
  if (st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o700) fail("unsafe_state");
}
function writePrivate(directory, name, value) {
  privateDirectory(directory);
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > MAX_BYTES * 4) fail("unsafe_state");
  let fd;
  try {
    fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o600) fail("unsafe_state");
    let offset = 0;
    while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset, offset); if (!written) fail("unsafe_state"); offset += written; }
    fsyncSync(fd);
  } catch { fail("unsafe_state"); }
  finally { if (fd !== undefined) closeSync(fd); }
  syncDirectory(directory);
}
function claimState(directory, binding, now) {
  try {
    noSymlinkDirectories(dirname(directory), true);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (e) { if (e?.code === "EEXIST") fail("allocation_already_claimed"); throw e; }
    syncDirectory(dirname(directory)); privateDirectory(directory);
    const token = randomBytes(16).toString("hex");
    writePrivate(directory, "lease.json", { pid: process.pid, token });
    writePrivate(directory, "allocation.json", { version: 1, ...binding, wallets: APPROVED_WALLETS, maxAttempts: 2, maxAttemptsPerWallet: 1, createdAt: timestamp(now) });
    return () => {
      try {
        privateDirectory(directory);
        const lease = JSON.parse(readOwned(join(directory, "lease.json"), 4096, true).toString("utf8"));
        if (lease.pid !== process.pid || lease.token !== token) fail("unsafe_state");
        unlinkSync(join(directory, "lease.json")); syncDirectory(directory);
      } catch { fail("unsafe_state"); }
    };
  } catch (e) { if (e?.message === "allocation_already_claimed") throw e; fail("unsafe_state"); }
}
function summary(page, wallet) {
  const c = page?.coverage;
  if (!plain(page) || page.wallet !== wallet || !Array.isArray(page.data) || page.data.length > 5 || page.data.some((row) => !plain(row)) ||
      typeof page.has_more !== "boolean" || !(page.cursor === null || typeof page.cursor === "string") ||
      !plain(c) || typeof c.complete !== "boolean" || typeof c.fresh !== "boolean" || c.scope !== SUPPORTED_SCOPE ||
      [c.status, c.reason].some((v) => typeof v !== "string" || v.length > 256 || /[\x00-\x1f]/.test(v))) fail("invalid_response");
  return { wallet, rowCount: page.data.length, partialPage: true, hasMore: page.has_more, qualification: "unverified", coverage: { complete: c.complete, fresh: c.fresh, status: c.status, reason: c.reason, scope: c.scope } };
}
function defaultCredentialReader(file) {
  const runtime = runtimeConfiguration({ keyFile: file, requestBudget: 2 }, {});
  const key = runtime.env.DMND_API_KEY;
  delete runtime.env.DMND_API_KEY;
  return key;
}
function echoDetector(key) {
  const forms = [...new Set([key, encodeURIComponent(key), new URLSearchParams({ api_key: key }).toString().slice(8)])].map((v) => v.toLowerCase());
  return (text) => {
    // Upstream errors may quote a query after one or two encoding layers.
    // Decode bounded text only in memory before deciding whether it is safe to retain.
    for (let layer = 0; layer < 4; layer++) {
      if (forms.some((v) => text.toLowerCase().includes(v))) return true;
      const decoded = text.replace(/(?:%[a-f0-9]{2})+/gi, (encoded) => {
        try { return decodeURIComponent(encoded); } catch { return encoded; }
      });
      if (decoded === text) break;
      text = decoded;
    }
    return false;
  };
}

// Only this server/private closure sees the key or computed authenticated URL.
// The network task never writes evidence, including after an uncertain timeout.
function privateStakeReader(keyFile, credentialReader, network, now, scope) {
  let key;
  try { key = credentialReader(keyFile); if (typeof key !== "string" || !key || /\s/.test(key) || key.length > 4096) throw new Error(); }
  catch { fail("credential_unavailable"); }
  const echoed = echoDetector(key);
  return async (wallet) => {
    const controller = new AbortController();
    const remaining = scope.expiresMs - clock(now);
    if (remaining <= 0) fail("scope_expired");
    const duration = Math.min(TIMEOUT_MS, remaining), expiryDeadline = remaining <= TIMEOUT_MS;
    let timer, reader, settled = false, timedOut = false, httpStatus;
    let abortReject;
    const aborted = new Promise((_, reject) => { abortReject = reject; });
    const task = (async () => {
      const url = new URL(`${BASE}/wallets/${wallet}/stake-accounts`);
      url.searchParams.set("limit", "5"); url.searchParams.set("api_key", key);
      const response = await network(url.href, { method: "GET", redirect: "manual", cache: "no-store", signal: controller.signal });
      httpStatus = response.status;
      if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) fail("invalid_response");
      if (controller.signal.aborted) { await response.body?.cancel(); fail("timeout"); }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel(); fail("response_too_large"); }
      reader = response.body?.getReader();
      if (!reader) fail("invalid_response");
      const chunks = []; let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) fail("timeout");
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); fail("response_too_large"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); reader = undefined; }
      const raw = Buffer.concat(chunks, bytes), rawBodySha256 = hash(raw);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      let json;
      try { json = JSON.parse(text); } catch {}
      // Check decoded JSON too, so escaped Unicode cannot hide a raw/encoded key.
      if (echoed(text) || (json !== undefined && echoed(JSON.stringify(json)))) fail("credential_echo");
      if (clock(now) >= scope.expiresMs) fail("scope_expired");
      return { httpStatus, bodyBytes: bytes, rawBodySha256, rawBodyBase64: raw.toString("base64"), ...(json === undefined ? {} : { json }) };
    })();
    const settlement = task.then(() => { settled = true; }, () => { settled = true; });
    timer = setTimeout(() => {
      timedOut = true; controller.abort();
      // Cancel the stream as well: a synthetic/noncooperative body may ignore signal.
      if (reader) void reader.cancel().catch(() => {});
      abortReject(new Error(expiryDeadline ? "scope_expired" : "timeout"));
    }, duration);
    try {
      const capture = await Promise.race([task, aborted]);
      return { ...capture, networkSettled: true };
    } catch (error) {
      const code = timedOut ? (expiryDeadline ? "scope_expired" : "timeout") : ["response_too_large", "credential_echo", "invalid_response", "scope_expired"].includes(error?.message) ? error.message : "request_failed";
      if (timedOut && !settled) {
        let cleanupTimer;
        await Promise.race([settlement, new Promise((r) => { cleanupTimer = setTimeout(r, CLEANUP_MS); })]);
        clearTimeout(cleanupTimer);
      }
      return { ...(httpStatus === undefined ? {} : { httpStatus }), error: code, networkSettled: settled };
    } finally { clearTimeout(timer); }
  };
}

/** Programmatic dependency overrides are for synthetic tests only. CLI accepts only paths and a receipt pin.
 * @param {any} input
 * @param {{network?:(url:string, init:RequestInit)=>Promise<Response>,now?:()=>number,credentialReader?:(file:string)=>string,proofVerifier?:(buildRoot:string,proofFile:string)=>void,stateDirectory?:string,historicalPins?:{receiptSha256:string,originalLedgerSha256:string}}} [dependencies]
 * @returns {Promise<any>}
 */
export async function runStakeQuantityAcceptance(input, dependencies = {}) {
  if (!exact(input, inputFields) || !inputFields.filter((v) => v !== "scopeSha256").every((v) => absolute(input[v])) || !sha(input.scopeSha256)) fail("invalid_configuration");
  const now = dependencies.now ?? Date.now, trees = worktrees(), pins = dependencies.historicalPins ?? HISTORICAL_PINS;
  const scope = readStakeScope(input.scopeFile, input.scopeSha256, { now: clock(now), worktrees: trees });
  const provenance = originalGrant(input, trees, pins, clock(now));
  assertScopedCredential(scope, input.keyFile, trees);
  const binding = { scopeId: STAKE_SCOPE_ID, scopeSha256: scope.scopeSha256, ...provenance };
  // Every script checkout sharing the authoritative grant must share its one allocation.
  const directory = dependencies.stateDirectory ?? join(dirname(realpathSync(input.originalGrantFile)), "stake-quantity-acceptance", STAKE_SCOPE_ID);
  if (!absolute(directory)) fail("invalid_configuration");
  // Proof still precedes custody even though this reader does not start the Worker.
  try { (dependencies.proofVerifier ?? assertRuntimeProof)(join(projectRoot, "dist"), join(projectRoot, ".sites-runtime/dmnd-runtime-proof.json")); }
  catch { fail("runtime_proof"); }
  const releaseLease = claimState(directory, binding, now);
  let requests = 0, mayRelease = true, terminalWritten = false;
  const observations = [], startedAt = timestamp(now);
  try {
    // Proof and durable state creation may take time. Rebind immediately before custody.
    readStakeScope(input.scopeFile, input.scopeSha256, { now: clock(now), worktrees: trees });
    if (originalGrant(input, trees, pins, clock(now)).originalGrantSha256 !== provenance.originalGrantSha256) fail("original_grant_changed");
    const credentialReader = (file) => {
      assertScopedCredential(scope, file, trees);
      const key = (dependencies.credentialReader ?? defaultCredentialReader)(file);
      assertScopedCredential(scope, file, trees);
      return key;
    };
    const read = privateStakeReader(input.keyFile, credentialReader, dependencies.network ?? ((url, init) => fetch(url, init)), now, scope);
    for (const [i, wallet] of APPROVED_WALLETS.entries()) {
      readStakeScope(input.scopeFile, input.scopeSha256, { now: clock(now), worktrees: trees });
      const current = originalGrant(input, trees, pins, clock(now));
      if (current.originalGrantSha256 !== provenance.originalGrantSha256) fail("original_grant_changed");
      const number = i + 1, requestStartedAt = timestamp(now);
      const attempt = { ...binding, number, wallet, resource: "stake-accounts", program: PROGRAM, role: "authorized_withdrawer", requestStartedAt };
      writePrivate(directory, `attempt-${number}.json`, attempt);
      // Reservation is durable before any fetch; expiry is checked again in read().
      requests++;
      const capture = await read(wallet);
      const completedAt = timestamp(now);
      mayRelease = capture.networkSettled;
      if (capture.rawBodyBase64 !== undefined) writePrivate(directory, `response-${number}.json`, { ...attempt, completedAt, ...capture });
      let error = capture.error, observation;
      if (!error && capture.httpStatus !== 200) error = capture.httpStatus === 401 ? "authentication" : capture.httpStatus === 403 ? "refused" : capture.httpStatus === 429 ? "rate_limited" : "http_error";
      if (!error) {
        try { observation = summary(capture.json, wallet); }
        catch { error = "invalid_response"; }
      }
      writePrivate(directory, `completion-${number}.json`, { ...attempt, completedAt, ok: !error, ...(capture.httpStatus === undefined ? {} : { httpStatus: capture.httpStatus }), ...(error ? { error } : {}), networkSettled: capture.networkSettled });
      if (error) {
        const report = { ...binding, status: "failed", startedAt, completedAt, requests, error, networkSettled: capture.networkSettled, observations, ...(capture.httpStatus === undefined ? {} : { httpStatus: capture.httpStatus }) };
        writePrivate(directory, "failure.json", report); terminalWritten = true; return report;
      }
      observations.push(observation);
    }
    const report = { ...binding, status: "complete", startedAt, completedAt: timestamp(now), requests, observations };
    writePrivate(directory, "complete.json", report); terminalWritten = true; return report;
  } catch (error) {
    const code = ["credential_unavailable", "original_grant_changed", "scope_expired", "invalid_scope", "invalid_original_grant", "unsafe_state", "invalid_clock"].includes(error?.message) ? error.message : "request_failed";
    if (!terminalWritten) writePrivate(directory, "failure.json", { ...binding, status: "failed", startedAt, completedAt: timestamp(now), requests, error: code, observations });
    if (requests === 0) fail(code);
    return { ...binding, status: "failed", startedAt, completedAt: timestamp(now), requests, error: code, observations };
  } finally { if (mayRelease) releaseLease(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) fail("invalid_configuration");
    let text = "";
    for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 16384) fail("invalid_configuration"); }
    const report = await runStakeQuantityAcceptance(JSON.parse(text));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.status !== "complete") process.exitCode = 1;
  } catch {
    process.stderr.write("Stake quantity acceptance refused or failed. Preserve private evidence; this allocation cannot be retried.\n");
    process.exitCode = 1;
  }
}
