import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { APPROVED_WALLETS as acceptanceWallets } from "./dmnd-acceptance.mjs";
import { bodyJson } from "../lib/dmnd/read-json.mjs";

export const APPROVED_WALLETS = Object.freeze([...acceptanceWallets]);
export const PHASES = Object.freeze([
  "initial-trigger",
  "initial-confirmation",
  "advance-trigger",
  "advance-confirmation",
]);
const MAX_BYTES = 8388608;
const TIMEOUT_MS = 8000;
const GAP_MS = 120000;
const EXPIRES_AT = Date.parse("2026-10-23T10:15:00Z");
const fields = ["baseURL", "phase", "stateDirectory", "extensionReceiptFile", "extensionReceiptSha256"];
const fail = (code) => { throw new Error(code); };
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const decimal = (value) => typeof value === "string" && /^\d+$/.test(value);
const slot = (value) => Number.isSafeInteger(value) && value >= 0;
const time = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function configuration(input) {
  if (!plain(input) || Object.keys(input).length !== fields.length || fields.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !fields.includes(key))) fail("invalid_configuration");
  const match = typeof input.baseURL === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/$/.exec(input.baseURL);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535 || !PHASES.includes(input.phase)) fail("invalid_configuration");
  for (const key of ["stateDirectory", "extensionReceiptFile"]) {
    if (typeof input[key] !== "string" || input[key].length > 4096 || input[key].includes("\0") || !isAbsolute(input[key]) || resolve(input[key]) !== input[key]) fail("invalid_configuration");
  }
  if (typeof input.extensionReceiptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.extensionReceiptSha256)) fail("invalid_configuration");
  return { ...input };
}
async function defaultReceiptReader(file, sha256, options) {
  // Resolve only when invoked: pure tests supply the shared receipt reader's API.
  const modulePath = "./native-overview-extension.mjs";
  const { readOverviewExtensionReceipt } = await import(modulePath);
  return readOverviewExtensionReceipt(file, sha256, options);
}
function validateReceipt(receipt, sha256, now) {
  if (!plain(receipt) || receipt.receiptSha256 !== sha256 || receipt.oldCap !== 34 || receipt.newCap !== 42 || receipt.alreadyUsed !== 29 || receipt.additionalRequests !== 8 || !same(receipt.wallets, APPROVED_WALLETS) || !same(receipt.resources, ["overview"]) || !time(receipt.expiresAt) || Date.parse(receipt.expiresAt) !== EXPIRES_AT || receipt.maxBytes !== MAX_BYTES || receipt.timeoutMs !== TIMEOUT_MS) fail("invalid_extension_receipt");
  if (now >= EXPIRES_AT) fail("extension_expired");
}
function clock(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_clock");
  return value;
}
function timestamp(now) { return new Date(clock(now)).toISOString(); }

/** Extract only independently reported overview clocks; coverage remains in the raw envelope.
 * @param {any} envelope @param {string} expectedWallet @returns {Record<string, any>}
 */
export function extractNativeClockObservation(envelope, expectedWallet) {
  if (!APPROVED_WALLETS.includes(expectedWallet) || !plain(envelope) || envelope.ok !== true || !plain(envelope.data) || envelope.data.wallet !== expectedWallet || !Array.isArray(envelope.data.assets) || !plain(envelope.data.coverage)) fail("invalid_response");
  const data = envelope.data;
  const result = { wallet: expectedWallet, assetCount: data.assets.length };
  for (const key of ["native_sol_lamports", "wrapped_sol_lamports"]) {
    if (!Object.hasOwn(data, key)) continue;
    if (data[key] !== null && !decimal(data[key])) fail("invalid_response");
    result[key] = data[key];
  }
  for (const key of ["native_sol_slot", "wrapped_sol_slot"]) {
    if (!Object.hasOwn(data, key)) continue;
    if (data[key] !== null && !slot(data[key])) fail("invalid_response");
    result[key] = data[key];
  }
  for (const key of ["sol_price_usd", "sol_price_updated_at"]) {
    if (!Object.hasOwn(data, key)) continue;
    if (data[key] !== null && (typeof data[key] !== "string" || (key === "sol_price_usd" ? !/^\d+(?:\.\d+)?$/.test(data[key]) : !Number.isFinite(Date.parse(data[key]))))) fail("invalid_response");
    result[key] = data[key];
  }
  return result;
}

/** @param {any} initial @param {any} advanced */
export function compareNativeClockRounds(initial, advanced) {
  const reasons = [];
  if (initial?.phase !== "initial-confirmation" || advanced?.phase !== "advance-confirmation" || initial?.status !== "complete" || advanced?.status !== "complete") reasons.push("confirmed_rounds_unproven");
  if (![initial?.startedAt, initial?.completedAt, advanced?.startedAt, advanced?.completedAt, advanced?.advanceTriggerStartedAt].every(time) || Date.parse(initial.completedAt) < Date.parse(initial.startedAt) || Date.parse(advanced.startedAt) < Date.parse(advanced.advanceTriggerStartedAt) || Date.parse(advanced.completedAt) < Date.parse(advanced.startedAt)) reasons.push("confirmed_round_chronology_unproven");
  if (!time(initial?.completedAt) || !time(advanced?.advanceTriggerStartedAt) || Date.parse(advanced.advanceTriggerStartedAt) - Date.parse(initial.completedAt) < GAP_MS) reasons.push("required_elapsed_time_unproven");
  const rounds = [initial, advanced].map((round) => Array.isArray(round?.observations) ? round.observations : []);
  if (rounds.some((observations) => observations.length !== APPROVED_WALLETS.length || !same(observations.map((value) => value?.wallet).sort(), [...APPROVED_WALLETS].sort()))) reasons.push("approved_wallets_unproven");
  for (const wallet of APPROVED_WALLETS) {
    const before = rounds[0].find((value) => value?.wallet === wallet);
    const after = rounds[1].find((value) => value?.wallet === wallet);
    for (const source of ["native_sol", "wrapped_sol"]) {
      if (!decimal(before?.[source + "_lamports"]) || !decimal(after?.[source + "_lamports"])) reasons.push(wallet + ":" + source + "_quantity_unknown");
      if (!slot(before?.[source + "_slot"]) || !slot(after?.[source + "_slot"])) reasons.push(wallet + ":" + source + "_slot_unknown");
      else if (after[source + "_slot"] <= before[source + "_slot"]) reasons.push(wallet + ":" + source + "_slot_did_not_advance");
    }
  }
  return { scope: "native-and-wrapped-sol-clock-advance", clockAdvanceProven: reasons.length === 0, reasons };
}

async function noSymlinkDirectories(directory) {
  // Reject symlink components as well as a symlink leaf. Ancestors need not be private.
  let current = sep;
  for (const component of directory.split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_state");
  }
}
async function directorySafe(directory) {
  await noSymlinkDirectories(directory);
  const stat = await lstat(directory);
  if ((stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid?.()) fail("unsafe_state");
}
async function prepareDirectory(directory) {
  await noSymlinkDirectories(dirname(directory));
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") fail("unsafe_state"); }
  await directorySafe(directory);
}
function fileSafe(stat) {
  if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size > MAX_BYTES + 65536) fail("unsafe_state");
}
async function readPrivate(directory, name) {
  await directorySafe(directory);
  let handle;
  try {
    handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    fileSafe(await handle.stat());
    return JSON.parse(await handle.readFile("utf8"));
  } catch { fail("unsafe_state"); }
  finally { await handle?.close(); }
}
async function writePrivate(directory, name, value) {
  await directorySafe(directory);
  let handle;
  try {
    handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fileSafe(await handle.stat());
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } catch { fail("unsafe_state"); }
  finally { await handle?.close(); }
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
const names = new Set(["session.json", ...PHASES.flatMap((phase) => ["start", "complete", "failure", "attempt-1", "attempt-2", "response-1", "response-2", "result-1", "result-2"].map((kind) => `${phase}.${kind}.json`))]);
async function loadState(config, now) {
  await prepareDirectory(config.stateDirectory);
  const files = await readdir(config.stateDirectory);
  const state = {};
  for (const name of files) {
    if (!names.has(name)) fail("unsafe_state");
    state[name] = await readPrivate(config.stateDirectory, name);
  }
  const session = state["session.json"];
  if (session) {
    if (session.version !== 1 || session.baseURL !== config.baseURL || session.receiptSha256 !== config.extensionReceiptSha256 || !same(session.wallets, APPROVED_WALLETS)) fail("state_scope_mismatch");
  } else {
    if (files.length) fail("unsafe_state");
    if (config.phase !== PHASES[0]) fail("phase_order");
    await writePrivate(config.stateDirectory, "session.json", { version: 1, baseURL: config.baseURL, receiptSha256: config.extensionReceiptSha256, wallets: APPROVED_WALLETS, createdAt: timestamp(now) });
  }
  const index = PHASES.indexOf(config.phase);
  for (const [i, phase] of PHASES.entries()) {
    const start = state[`${phase}.start.json`];
    const complete = state[`${phase}.complete.json`];
    if (state[`${phase}.failure.json`]) fail("phase_halted");
    if (start && i === index) fail("phase_already_started");
    if (start && !complete) fail("phase_incomplete");
    if (!start && files.some((name) => name.startsWith(phase + "."))) fail("unsafe_state");
    if (complete) {
      if (i >= index) fail("phase_order");
      if (complete.phase !== phase || complete.status !== "complete" || complete.requests !== 2 || !time(complete.startedAt) || !time(complete.completedAt) || Date.parse(complete.completedAt) < Date.parse(complete.startedAt) || !same(complete.observations?.map((observation) => observation.wallet), APPROVED_WALLETS)) fail("unsafe_state");
      for (let j = 1; j <= 2; j++) {
        const response = state[`${phase}.response-${j}.json`];
        const attempt = state[`${phase}.attempt-${j}.json`];
        const result = state[`${phase}.result-${j}.json`];
        if (!attempt || !result || result.ok !== true || response?.status !== 200 || !same(extractNativeClockObservation(response.envelope, APPROVED_WALLETS[j - 1]), complete.observations[j - 1])) fail("unsafe_state");
      }
    }
    if (i < index && !complete) fail("phase_order");
  }
  if (config.phase === "advance-trigger" && clock(now) - Date.parse(state["initial-confirmation.complete.json"].completedAt) < GAP_MS) fail("clock_wait_required");
  return state;
}

/** One explicitly requested phase. No probes, sleeps, continuations or retries.
 * @param {any} input
 * @param {{network?:(input:string, init:RequestInit)=>Promise<Response>, now?:()=>number, readReceipt?:(file:string, sha:string, options:{now:number})=>any}} [dependencies]
 * @returns {Promise<any>}
 */
export async function runNativeClockPhase(input, dependencies = {}) {
  const config = configuration(input);
  const now = dependencies.now ?? Date.now;
  const network = dependencies.network ?? ((url, init) => fetch(url, init));
  const readReceipt = dependencies.readReceipt ?? defaultReceiptReader;
  let receipt;
  try { receipt = await readReceipt(config.extensionReceiptFile, config.extensionReceiptSha256, { now: clock(now) }); }
  catch { fail("invalid_extension_receipt"); }
  validateReceipt(receipt, config.extensionReceiptSha256, clock(now));
  const state = await loadState(config, now);
  const startedAt = timestamp(now);
  await writePrivate(config.stateDirectory, `${config.phase}.start.json`, { version: 1, phase: config.phase, startedAt });
  const observations = [];
  let requests = 0;
  for (const [index, wallet] of APPROVED_WALLETS.entries()) {
    const ordinal = index + 1;
    const path = `/api/wallet/${wallet}/overview`;
    // This reservation is durable before the network receives control.
    await writePrivate(config.stateDirectory, `${config.phase}.attempt-${ordinal}.json`, { phase: config.phase, wallet, path, requestStartedAt: timestamp(now) });
    const controller = new AbortController();
    let timer;
    let status;
    let observedAt;
    let errorCode;
    try {
      if (clock(now) >= EXPIRES_AT) fail("extension_expired");
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, TIMEOUT_MS);
      });
      const captured = await Promise.race([
        (async () => {
          requests++;
          const response = await network(config.baseURL.slice(0, -1) + path, { method: "GET", redirect: "manual", cache: "no-store", signal: controller.signal });
          status = response.status;
          if (status !== 200) {
            await response.body?.cancel();
            fail(status === 401 ? "authentication" : status === 403 ? "refused" : status === 429 ? "rate_limited" : "http_error");
          }
          return bodyJson(response);
        })(),
        timeout,
      ]);
      observedAt = timestamp(now);
      await writePrivate(config.stateDirectory, `${config.phase}.response-${ordinal}.json`, { phase: config.phase, wallet, status, observedAt, envelope: captured });
      const observation = extractNativeClockObservation(captured, wallet);
      observations.push(observation);
      await writePrivate(config.stateDirectory, `${config.phase}.result-${ordinal}.json`, { wallet, status, observedAt, ok: true });
    } catch (error) {
      errorCode = controller.signal.aborted ? "timeout" : ["extension_expired", "response_too_large", "invalid_response", "authentication", "refused", "rate_limited", "http_error", "unsafe_state"].includes(error?.message) ? error.message : "request_failed";
    } finally { clearTimeout(timer); }
    if (errorCode) {
      const failure = { phase: config.phase, status: "failed", startedAt, completedAt: timestamp(now), requests, error: errorCode, observations, ...(status === undefined ? {} : { httpStatus: status }) };
      await writePrivate(config.stateDirectory, `${config.phase}.failure.json`, failure);
      return failure;
    }
  }
  const report = { phase: config.phase, status: "complete", startedAt, completedAt: timestamp(now), requests: 2, observations };
  if (config.phase === "advance-confirmation") {
    report.advanceTriggerStartedAt = state["advance-trigger.start.json"].startedAt;
    report.comparison = compareNativeClockRounds(state["initial-confirmation.complete.json"], report);
  }
  await writePrivate(config.stateDirectory, `${config.phase}.complete.json`, report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) fail("invalid_configuration");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16384) fail("invalid_configuration");
    }
    const report = await runNativeClockPhase(JSON.parse(input));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.status !== "complete") process.exitCode = 1;
  } catch {
    process.stderr.write("Native clock phase refused or failed. Check the private phase evidence before any further invocation. No credentials are accepted.\n");
    process.exitCode = 1;
  }
}
