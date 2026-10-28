import { constants, openSync, closeSync, writeFileSync, fsyncSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readProfileEvidence, storeProfileState, syncProfileDirectory,
  nativeStakeSourceFingerprint } from "./native-stake-profile.mjs";

export const NEW_ADDRESS_SCOPE = "new-address-initial-refresh-4-20261025";
export const NEW_ADDRESS_WALLET = "aLqXroJ6z41nDQ9zEmqj5mPU86DJ1LXfABfAKxFzDS2";
const SCOPE_SHA = "c13ab0b9c070af526542bdc163806fe2afb97c3696a07fcd479cf820ddaa6a24";
const BUILD = "38f9f5b8206b338bf537685712f021bc27d950de34d4beb6b9c1b0fe751dcf24";
const contexts = new WeakSet();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = value => { if (!value) throw new Error("New-address profile refused"); };
const recent = (at, now, max) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) <= max;
const resources = ["overview", "summary"];

export function loadNewAddressProfile(scopeFile, readinessFile, readinessSha256, now = Date.now()) {
  const bytes = readProfileEvidence(scopeFile);
  check(sha(bytes) === SCOPE_SHA);
  const scope = JSON.parse(bytes), healthBytes = readProfileEvidence(readinessFile);
  check(/^[a-f0-9]{64}$/.test(readinessSha256) && sha(healthBytes) === readinessSha256);
  const health = JSON.parse(healthBytes);
  check(scope.scope_id === NEW_ADDRESS_SCOPE && scope.wallet === NEW_ADDRESS_WALLET &&
    scope.max_actual_DMND_GET_attempts === 4 && recent(health.at, now, 15 * 60000) &&
    health.all_health_200 === true && health.provider_requests === 0 && health.wallet_GETs === 0 &&
    health.production_mutations === 0 && Array.isArray(health.services));
  // Scope4 requires the same serving-qualified API55/worker56, not any later deployment.
  for (const [name, id, source, image, flag] of [
    ["upstream-api", "044aa26637e33cde993205e19f64cd0f193e04ef724301399cef207be4ac3920",
      "9e936a986bdc0a7b1d8e7e7fb0ac1da54d5d6706", "sha256:25470c6161159d56ffe50fc3e2b0d37ccdd3e171eaf204b2b42a95e32956d0ea", "API_WALLET_STAKE_ENABLED"],
    ["upstream-worker", "b4b0c96bfadb7f2032393fcde3eb2f23dc79546120b43d1e4b0bc46200f04e39",
      "6e6f99d9262bf0e9f2a69fc3f57aecefbbc5027a", "sha256:3258a3c89ea0c0e5666727649bcfb08c6452155a58341cef06c4e4a061c65a9e", "WORKER_WALLET_STAKE_ENABLED"],
  ]) {
    const rows = health.services.filter(row => row.name === name);
    check(rows.length === 1);
    const row = rows[0];
    check(row.id === id && row.source === source && row.image === image && row.running === true &&
      row.restarts === 0 && row.health_http === 200 && row.nonsecret_flags?.[flag] === "true");
    if (name === "upstream-worker") check(row.snapshot_rpc_configured === true);
  }
  const profile = Object.freeze({ scopeId: NEW_ADDRESS_SCOPE, scopeSha256: SCOPE_SHA,
    readinessSha256, readinessAt: health.at });
  contexts.add(profile);
  return profile;
}
export function assertNewAddressProfile(profile) { check(contexts.has(profile)); }

export function newAddressGrantPath() {
  const directory = join(homedir(), ".local/state/doxxd", NEW_ADDRESS_SCOPE);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = statSync(directory);
  check(realpathSync(directory) === directory && stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
  return join(directory, "grant.json");
}
export function claimNewAddressGrant(path, profile) {
  assertNewAddressProfile(profile);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...profile, claimedAt: new Date().toISOString(),
      allocatedRequests: 4, usedRequests: 0, requests: [] }) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncProfileDirectory(path);
}
function readState(path, profile, allowPending = false) {
  assertNewAddressProfile(profile);
  const state = JSON.parse(readProfileEvidence(path, 16384, true));
  check(state.scopeId === profile.scopeId && state.scopeSha256 === profile.scopeSha256 &&
    state.readinessSha256 === profile.readinessSha256 && state.readinessAt === profile.readinessAt &&
    state.allocatedRequests === 4 && Number.isInteger(state.usedRequests) && state.usedRequests >= 0 &&
    state.usedRequests <= 4 && Array.isArray(state.requests) && state.requests.length === state.usedRequests);
  const seen = new Set();
  for (const [index, row] of state.requests.entries()) {
    const phase = Math.floor(index / 2), identity = phase + ":" + row.resource;
    check(row.number === index + 1 && row.phase === phase && row.wallet === NEW_ADDRESS_WALLET &&
      resources.includes(row.resource) && !seen.has(identity) && Number.isFinite(Date.parse(row.reservedAt)) &&
      (row.status === null ? allowPending && index === state.requests.length - 1 :
        Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 && Number.isFinite(Date.parse(row.finishedAt))));
    if (phase === 1) check(Date.parse(row.reservedAt) - Date.parse(state.requests[1].finishedAt) >= 5000);
    seen.add(identity);
  }
  return state;
}
export function newAddressRouteAllowed(profile, request) {
  assertNewAddressProfile(profile);
  const url = new URL(request.url);
  return request.method === "GET" && !url.search && resources.some(resource =>
    url.pathname === "/api/wallet/" + NEW_ADDRESS_WALLET + "/" + resource);
}
export function reserveNewAddressRequest(path, profile, resource) {
  const state = readState(path, profile), phase = Math.floor(state.usedRequests / 2), now = Date.now();
  check(resources.includes(resource) && state.usedRequests < 4 && state.requests.every(row => row.status === 200) &&
    !state.requests.some(row => row.phase === phase && row.resource === resource));
  if (phase === 1) check(now - Date.parse(state.requests[1].finishedAt) >= 5000);
  const index = state.usedRequests++;
  state.requests.push({ number: index + 1, phase, wallet: NEW_ADDRESS_WALLET, resource,
    reservedAt: new Date(now).toISOString(), status: null });
  storeProfileState(path, state);
  return index;
}
export function completeNewAddressRequest(path, profile, index, status) {
  const state = readState(path, profile, true), row = state.requests[index];
  check(index === state.usedRequests - 1 && row?.status === null && Number.isInteger(status) && status >= 100 && status <= 599);
  row.status = status; row.finishedAt = new Date().toISOString();
  storeProfileState(path, state);
}
export function assertNewAddressRehearsal(config, buildFingerprint, fourGateProofPath, now = Date.now()) {
  const bytes = readProfileEvidence(config.syntheticProofFile), proof = JSON.parse(bytes);
  check(sha(bytes) === config.syntheticProofSha256 && proof.version === 1 && proof.outcome === "passed" &&
    proof.syntheticOnly === true && proof.scopeId === NEW_ADDRESS_SCOPE && proof.scopeSha256 === SCOPE_SHA &&
    proof.sourceFingerprint === nativeStakeSourceFingerprint() && proof.buildFingerprint === BUILD && buildFingerprint === BUILD &&
    proof.fourGateProofSha256 === sha(readProfileEvidence(fourGateProofPath)) && recent(proof.at, now, 60 * 60000) &&
    proof.allowedRequests === 4 && proof.browserRequests === 4 && proof.deniedRequests >= 6 &&
    proof.manualRefreshes === 1 && proof.minimumRefreshWaitMs >= 5000 && proof.desktop === true &&
    proof.mobileReusesState === true && proof.initialUnknownVerified === true && proof.refreshedZeroVerified === true &&
    proof.rejectionSchedulesPassed === 6 && proof.credentialReads === 0 && proof.actualDmndCalls === 0);
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  check(proof.sourceHead === git(["rev-parse", "HEAD"]) && git(["status", "--porcelain", "--", "web"]) === "");
}
