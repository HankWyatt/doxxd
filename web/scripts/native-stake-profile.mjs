import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync,
  fsyncSync, writeSync, renameSync, unlinkSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const NATIVE_STAKE_SCOPE = "native-stake-small-wallet-3-20261025";
export const NATIVE_STAKE_WALLET = "Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X";
const SCOPE_SHA = "d4a95fab17032f625ea7f33f2f980fcbfb5910d0aba6e2be2b840ff62392001c";
const BUILD = "38f9f5b8206b338bf537685712f021bc27d950de34d4beb6b9c1b0fe751dcf24";
const resources = ["overview", "summary", "stake"];
const contexts = new WeakSet();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = value => { if (!value) throw new Error("Native-stake profile refused"); };
const recent = (at, now, max) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) <= max;

function ownedRead(path, maximum = 262144, privateMode = false) {
  check(typeof path === "string" && isAbsolute(path) && realpathSync(path) === resolve(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() &&
      (privateMode ? (stat.mode & 0o777) === 0o600 : (stat.mode & 0o022) === 0) &&
      stat.size > 0 && stat.size <= maximum);
    const bytes = readFileSync(fd);
    check(bytes.length === stat.size);
    return bytes;
  } finally { closeSync(fd); }
}

export function loadNativeStakeProfile(scopeFile, readinessFile, readinessSha256, now = Date.now()) {
  const bytes = ownedRead(scopeFile);
  check(sha(bytes) === SCOPE_SHA);
  const scope = JSON.parse(bytes), healthBytes = ownedRead(readinessFile);
  check(/^[a-f0-9]{64}$/.test(readinessSha256) && sha(healthBytes) === readinessSha256);
  const health = JSON.parse(healthBytes);
  check(scope.scope_id === NATIVE_STAKE_SCOPE && scope.wallet === NATIVE_STAKE_WALLET &&
    health.all_health_200 === true && health.provider_requests === 0 && health.wallet_GETs === 0 &&
    health.production_mutations === 0 && recent(health.at, now, 15 * 60000) && Array.isArray(health.services));
  for (const [name, qualified, flag] of [
    ["upstream-api", scope.fresh_readiness.api, "API_WALLET_STAKE_ENABLED"],
    ["upstream-worker", scope.fresh_readiness.worker, "WORKER_WALLET_STAKE_ENABLED"],
  ]) {
    const matches = health.services.filter(service => service.name === name);
    check(matches.length === 1);
    const current = matches[0];
    check(current.id === qualified.id && current.source === qualified.source &&
      current.image === qualified.image && current.running === true && current.restarts === 0 &&
      current.health_http === 200 && current.nonsecret_flags?.[flag] === "true");
    if (name === "upstream-worker") check(current.snapshot_rpc_configured === true);
  }
  const profile = Object.freeze({ scopeId: NATIVE_STAKE_SCOPE, scopeSha256: SCOPE_SHA,
    readinessSha256, readinessAt: health.at });
  contexts.add(profile);
  return profile;
}

export function assertNativeStakeProfile(profile) { check(contexts.has(profile)); }

// One path per user and authority, shared by every checkout. Never remove or resume it.
export function nativeStakeGrantPath() {
  const directory = join(homedir(), ".local/state/doxxd", NATIVE_STAKE_SCOPE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = statSync(directory);
  check(realpathSync(directory) === directory && stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
  return join(directory, "grant.json");
}

export function claimNativeStakeGrant(path, profile) {
  assertNativeStakeProfile(profile);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...profile, claimedAt: new Date().toISOString(),
      allocatedRequests: 3, usedRequests: 0, requests: [] }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(path);
}

function syncDirectory(path) {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readState(path, profile, allowPending = false) {
  assertNativeStakeProfile(profile);
  const state = JSON.parse(ownedRead(path, 16384, true));
  check(state.scopeId === profile.scopeId && state.scopeSha256 === profile.scopeSha256 &&
    state.readinessSha256 === profile.readinessSha256 && state.readinessAt === profile.readinessAt &&
    state.allocatedRequests === 3 && Number.isInteger(state.usedRequests) && state.usedRequests >= 0 &&
    state.usedRequests <= 3 && Array.isArray(state.requests) && state.requests.length === state.usedRequests);
  const seen = new Set();
  for (const [index, row] of state.requests.entries()) {
    check(row.number === index + 1 && row.wallet === NATIVE_STAKE_WALLET && resources.includes(row.resource) &&
      !seen.has(row.resource) && typeof row.reservedAt === "string" && Number.isFinite(Date.parse(row.reservedAt)) &&
      (row.status === null ? allowPending && index === state.requests.length - 1 :
        Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 && Number.isFinite(Date.parse(row.finishedAt))));
    seen.add(row.resource);
  }
  return state;
}
function store(path, state) {
  const temporary = path + "." + randomBytes(16).toString("hex") + ".pending";
  let fd;
  try {
    const bytes = Buffer.from(JSON.stringify(state) + "\n");
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path); syncDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

// Shared file primitives only; each finite profile retains its own authority,
// ledger validation and allocation. Exporting these never grants a read.
export { ownedRead as readProfileEvidence, store as storeProfileState,
  syncDirectory as syncProfileDirectory };

export function nativeStakeRouteAllowed(profile, request) {
  assertNativeStakeProfile(profile);
  const url = new URL(request.url);
  const base = "/api/wallet/" + NATIVE_STAKE_WALLET + "/";
  return request.method === "GET" && (
    [base + "overview", base + "summary"].includes(url.pathname) && !url.search ||
    url.pathname === base + "stake" && url.search === "?limit=50"
  );
}
export function reserveNativeStakeRequest(path, profile, resource) {
  const state = readState(path, profile);
  check(resources.includes(resource) && state.usedRequests < 3 &&
    state.requests.every(row => row.resource !== resource && row.status === 200));
  const index = state.usedRequests++;
  state.requests.push({ number: index + 1, wallet: NATIVE_STAKE_WALLET, resource,
    reservedAt: new Date().toISOString(), status: null });
  store(path, state);
  return index;
}
export function completeNativeStakeRequest(path, profile, index, status) {
  const state = readState(path, profile, true), row = state.requests[index];
  check(index === state.usedRequests - 1 && row?.status === null && Number.isInteger(status) && status >= 100 && status <= 599);
  row.status = status; row.finishedAt = new Date().toISOString();
  store(path, state);
}

export function nativeStakeSourceFingerprint() {
  const hash = createHash("sha256");
  for (const file of ["native-stake-profile.mjs", "new-address-profile.mjs", "run-dmnd.mjs", "acceptance-proxy.mjs", "verify-dmnd-runtime.mjs"])
    hash.update(file + "\0").update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
export function assertNativeStakeRehearsal(config, buildFingerprint, fourGateProofPath, now = Date.now()) {
  const bytes = ownedRead(config.syntheticProofFile), proof = JSON.parse(bytes);
  check(sha(bytes) === config.syntheticProofSha256 && proof.version === 1 && proof.syntheticOnly === true &&
    proof.scopeSha256 === SCOPE_SHA && proof.scopeId === NATIVE_STAKE_SCOPE &&
    proof.sourceFingerprint === nativeStakeSourceFingerprint() && proof.buildFingerprint === BUILD &&
    buildFingerprint === BUILD && proof.fourGateProofSha256 === sha(ownedRead(fourGateProofPath)) &&
    recent(proof.at, now, 60 * 60000) && proof.allowedRequests === 3 && proof.deniedRequests >= 6 &&
    proof.desktop === true && proof.mobileReusesState === true && proof.credentialReads === 0 && proof.actualDmndCalls === 0);
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  check(proof.sourceHead === git(["rev-parse", "HEAD"]) && git(["status", "--porcelain", "--", "web"]) === "");
}
