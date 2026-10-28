import {
  constants, openSync, closeSync, fstatSync, readSync, writeSync,
  fsyncSync, renameSync, unlinkSync, realpathSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { APPROVED_WALLETS } from "./dmnd-acceptance.mjs";

export const CORE = ["overview", "summary", "transactions", "activity"];
const BASE = 34, BONUS = 8, TOTAL = 42, INITIAL = 29;
const MAX_LEDGER_BYTES = 262144;
const contexts = new WeakSet();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function timestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  const milliseconds = Date.parse(value);
  return !!match && Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === match[1] + "." + (match[2] ?? "").padEnd(3, "0") + "Z";
}
const status = (value) => Number.isInteger(value) && value >= 100 && value <= 599;
const stopped = (value) => [401, 403, 429].includes(value);

// Bound the read itself, reject links and unsafe ownership before reading bytes.
function readOwned(path, maxBytes, privateMode = true) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (privateMode ? (stat.mode & 0o777) !== 0o600 : (stat.mode & 0o022) !== 0))
      throw new Error();
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0, count;
    do {
      count = readSync(fd, bytes, size, bytes.length - size, null);
      size += count;
    } while (count && size <= maxBytes);
    if (size > maxBytes || size !== stat.size) throw new Error();
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

/** Validate the exact reviewed external receipt before custody is loaded. */
export function loadExtensionReceipt(path, digest, worktrees, allowExpired = false, now = Date.now()) {
  try {
    if (typeof path !== "string" || !isAbsolute(path) ||
      typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) ||
      realpathSync(path) !== resolve(path) ||
      worktrees.some((tree) => {
        const rel = relative(tree, path);
        return !rel || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
      })) throw new Error();
    const bytes = readOwned(path, 65536, false);
    if (hash(bytes) !== digest) throw new Error();
    const scope = JSON.parse(bytes.toString("utf8")).new_bounded_validation_allocation;
    if (!scope || scope.additional_requests_max !== BONUS ||
      scope.old_lifetime_cap !== BASE || scope.new_lifetime_cap !== TOTAL ||
      scope.already_used !== INITIAL ||
      !same(scope.allowed_resources, ["overview"]) ||
      !Array.isArray(scope.allowed_wallets) || scope.allowed_wallets.length !== 2 ||
      new Set(scope.allowed_wallets).size !== 2 ||
      scope.allowed_wallets.some((wallet) => !APPROVED_WALLETS.includes(wallet)) ||
      scope.unpaged_overview !== true || scope.response_max_bytes !== 8388608 ||
      scope.timeout_ms !== 8000 || !timestamp(scope.expires_at) ||
      !Number.isFinite(now) || (!allowExpired && now >= Date.parse(scope.expires_at))) throw new Error();
    const receipt = Object.freeze({
      version: 1, receiptSha256: digest,
      originalAllocatedRequests: BASE, additionalRequests: BONUS,
      initialUsedRequests: INITIAL,
      allowedResources: Object.freeze(["overview"]),
      allowedWallets: Object.freeze([...APPROVED_WALLETS]),
      unpagedOverview: true, responseMaxBytes: 8388608, timeoutMs: 8000,
      expiresAt: scope.expires_at,
    });
    contexts.add(receipt);
    return receipt;
  } catch {
    throw new Error("Extension receipt is unavailable, unsafe or invalid");
  }
}

/** Shared nonsecret reader for the parent-owned, loopback-only capture runner.
 * @param {string} path @param {string} digest
 * @param {{now?:number,allowExpired?:boolean}} [options]
 */
export function readOverviewExtensionReceipt(path, digest, options = {}) {
  if (Object.keys(options).some((key) => !["now", "allowExpired"].includes(key)) ||
    (options.allowExpired !== undefined && typeof options.allowExpired !== "boolean"))
    throw new Error("Extension receipt is unavailable, unsafe or invalid");
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8",
  }).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  const receipt = loadExtensionReceipt(path, digest, worktrees, options.allowExpired, options.now);
  return Object.freeze({
    receiptSha256: receipt.receiptSha256, oldCap: receipt.originalAllocatedRequests,
    newCap: receipt.originalAllocatedRequests + receipt.additionalRequests,
    alreadyUsed: receipt.initialUsedRequests, additionalRequests: receipt.additionalRequests,
    wallets: receipt.allowedWallets, resources: receipt.allowedResources,
    expiresAt: receipt.expiresAt, maxBytes: receipt.responseMaxBytes, timeoutMs: receipt.timeoutMs,
  });
}

export function readGrant(path) {
  const bytes = readOwned(path, MAX_LEDGER_BYTES);
  return { bytes, state: JSON.parse(bytes.toString("utf8")) };
}

function baseState(state, strict = false, pending = false) {
  if (!state || !Number.isInteger(state.allocatedRequests) ||
    state.allocatedRequests < 1 || state.allocatedRequests > BASE ||
    !Number.isInteger(state.usedRequests) || state.usedRequests < 0 ||
    state.usedRequests > state.allocatedRequests || !Array.isArray(state.requests) ||
    state.requests.length !== state.usedRequests ||
    ["extension", "baseUsedRequests", "bonusUsedRequests", "extensionHalt"].some((key) => key in state))
    throw new Error();
  for (const [index, row] of state.requests.entries()) {
    if (!row || !APPROVED_WALLETS.includes(row.wallet) ||
      !(status(row.status) || (pending && row.status === null && index === state.usedRequests - 1)))
      throw new Error();
    if (strict && (!CORE.includes(row.resource) || row.number !== index + 1 ||
      !["seed", "continuation"].includes(row.page) || !timestamp(row.reservedAt) ||
      !timestamp(row.finishedAt) || Date.parse(row.finishedAt) < Date.parse(row.reservedAt) ||
      row.allocation !== undefined)) throw new Error();
  }
}

/** Every extended operation revalidates provenance, the old audit and counters. */
export function validateGrant(state, receipt, pending = false) {
  if (state?.allocatedRequests !== TOTAL) {
    if (receipt) throw new Error();
    baseState(state, false, pending);
    return;
  }
  if (!receipt || !contexts.has(receipt)) throw new Error();
  const extension = state.extension;
  if (!extension || Object.keys(extension).length !== Object.keys(receipt).length + 3 ||
    Object.entries(receipt).some(([key, value]) => !same(extension[key], value)) ||
    typeof extension.originalLedgerBase64 !== "string" ||
    !timestamp(extension.appliedAt) || Date.parse(extension.appliedAt) >= Date.parse(receipt.expiresAt))
    throw new Error();
  const originalBytes = Buffer.from(extension.originalLedgerBase64, "base64");
  if (originalBytes.length > 65536 || originalBytes.toString("base64") !== extension.originalLedgerBase64 ||
    hash(originalBytes) !== extension.originalLedgerSha256) throw new Error();
  const original = JSON.parse(originalBytes.toString("utf8"));
  baseState(original, true);
  if (original.allocatedRequests !== BASE || original.usedRequests !== INITIAL ||
    !Number.isInteger(state.usedRequests) || state.usedRequests < INITIAL || state.usedRequests > TOTAL ||
    !Array.isArray(state.requests) || state.requests.length !== state.usedRequests ||
    !same(original.requests, state.requests.slice(0, INITIAL)) ||
    Object.entries(original).some(([key, value]) =>
      !["allocatedRequests", "usedRequests", "requests"].includes(key) && !same(state[key], value)))
    throw new Error();
  let base = INITIAL, bonus = 0, halt;
  for (let index = INITIAL; index < state.requests.length; index++) {
    const row = state.requests[index];
    if (!row || row.number !== index + 1 || !APPROVED_WALLETS.includes(row.wallet) ||
      !CORE.includes(row.resource) || !["seed", "continuation"].includes(row.page) ||
      !timestamp(row.reservedAt) || Date.parse(row.reservedAt) < Date.parse(extension.appliedAt) ||
      !(status(row.status) || (pending && row.status === null && index === state.requests.length - 1)) ||
      (row.status !== null && (!timestamp(row.finishedAt) || Date.parse(row.finishedAt) < Date.parse(row.reservedAt))))
      throw new Error();
    if (halt) throw new Error();
    if (row.allocation === "overview-extension") {
      if (row.resource !== "overview" || row.page !== "seed" || row.unpaged !== true ||
        row.receiptSha256 !== receipt.receiptSha256 || Date.parse(row.reservedAt) >= Date.parse(receipt.expiresAt))
        throw new Error();
      bonus++;
    } else if (row.allocation === "original") {
      base++;
    } else throw new Error();
    if (stopped(row.status)) halt = { requestNumber: row.number, status: row.status, at: row.finishedAt };
  }
  if (base > BASE || bonus > BONUS || state.baseUsedRequests !== base || state.bonusUsedRequests !== bonus ||
    !same(state.extensionHalt, halt)) throw new Error();
}

// Same-directory rename plus both fsyncs: interrupted writes cannot leave a
// partially rewritten grant or erase the old audit during the one-time migration.
function storeGrant(path, state) {
  const bytes = Buffer.from(JSON.stringify(state) + "\n");
  if (bytes.length > MAX_LEDGER_BYTES) throw new Error();
  const temporary = path + "." + randomBytes(16).toString("hex") + ".pending";
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

export function resumeExtensionGrant(path, budget, used, receipt) {
  if (!receipt || !contexts.has(receipt) || ![BASE, TOTAL].includes(budget) ||
    !Number.isInteger(used) || used < INITIAL || used > TOTAL) throw new Error();
  const { state, bytes } = readGrant(path);
  if (state.allocatedRequests === TOTAL) {
    validateGrant(state, receipt);
    if (state.usedRequests !== used || state.extensionHalt ||
      (budget === TOTAL && (Date.now() >= Date.parse(receipt.expiresAt) || state.bonusUsedRequests >= BONUS)) ||
      (budget === BASE && state.baseUsedRequests >= BASE)) throw new Error();
    return;
  }
  baseState(state, true);
  if (budget !== TOTAL || state.allocatedRequests !== BASE || state.usedRequests !== INITIAL ||
    used !== INITIAL || bytes.length > 65536 || Date.now() >= Date.parse(receipt.expiresAt)) throw new Error();
  const next = {
    ...state, allocatedRequests: TOTAL,
    baseUsedRequests: INITIAL, bonusUsedRequests: 0,
    extension: {
      ...receipt, originalLedgerSha256: hash(bytes), originalLedgerBase64: bytes.toString("base64"),
      appliedAt: new Date().toISOString(),
    },
  };
  validateGrant(next, receipt);
  storeGrant(path, next);
}

export function reserveRequest(path, wallet, resource, continuation, unpaged, receipt, mode) {
  const { state } = readGrant(path);
  validateGrant(state, receipt);
  const now = new Date().toISOString();
  const row = { number: state.usedRequests + 1, wallet, resource,
    page: continuation ? "continuation" : "seed", reservedAt: now, status: null };
  if (receipt) {
    if (state.extensionHalt || !["bonus", "original"].includes(mode)) throw new Error();
    if (mode === "bonus") {
      if (resource !== "overview" || continuation || !unpaged ||
        Date.now() >= Date.parse(receipt.expiresAt) || state.bonusUsedRequests >= BONUS) throw new Error();
      state.bonusUsedRequests++;
      Object.assign(row, { allocation: "overview-extension", receiptSha256: receipt.receiptSha256, unpaged: true });
    } else {
      if (state.baseUsedRequests >= BASE) throw new Error();
      state.baseUsedRequests++;
      Object.assign(row, { allocation: "original" });
    }
  } else if (state.usedRequests >= state.allocatedRequests || mode === "bonus") throw new Error();
  const index = state.usedRequests++;
  state.requests.push(row);
  validateGrant(state, receipt, true);
  storeGrant(path, state);
  return index;
}

export function completeRequest(path, index, resultStatus, receipt) {
  const { state } = readGrant(path);
  validateGrant(state, receipt, true);
  const row = state.requests[index];
  if (index !== state.usedRequests - 1 || row?.status !== null || !status(resultStatus)) throw new Error();
  row.status = resultStatus;
  row.finishedAt = new Date().toISOString();
  if (receipt && stopped(resultStatus))
    state.extensionHalt = { requestNumber: row.number, status: resultStatus, at: row.finishedAt };
  validateGrant(state, receipt);
  storeGrant(path, state);
}
