// Narrow allowlist for the /api/rpc pass-through. Pure: no I/O.
//
// Each method accepts exactly the JSON-RPC shapes that @solana/web3.js
// 1.99.0's Connection puts on the wire for it (src/connection.ts), within the
// limits below. Config objects reject unknown keys. This is not a general RPC
// proxy: anything not listed here is refused before it reaches the upstream.
import bs58 from "bs58";

export const CP_AMM_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
// cp-amm 1.5.1 IDL `Vesting`: 8-byte discriminator, then `position: pubkey`,
// `inner_vesting: InnerVesting` (80 bytes) and `padding2: [u128; 4]`.
// Pinned against the IDL by policy.test.ts.
export const VESTING_SIZE = 184;
export const VESTING_POSITION_OFFSET = 8;

export const RPC_METHODS = [
  "getAccountInfo",
  "getMultipleAccounts",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSlot",
  "getEpochInfo",
  "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getProgramAccounts",
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: RpcMethod;
  params: unknown[];
};

export type RpcCheck =
  | { ok: true; method: RpcMethod; request: JsonRpcRequest }
  | { ok: false; code: -32600 | -32601 | -32602; message: string };

const MAX_ID_LENGTH = 128;
const MAX_ACCOUNTS = 100;
const MAX_FEE_ACCOUNTS = 128;
const MAX_SIGNATURES = 64;
const MAX_SIMULATE_ADDRESSES = 16;
const MAX_TX_BASE64 = 1_700;
const MAX_RENT_SIZE = 10_240;
const MAX_SEND_RETRIES = 5;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// True when `value` is an object whose keys are all in `allowed` and which
// has every key in `required`.
function hasKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): value is Obj {
  if (!isObject(value)) return false;
  for (const k of Object.keys(value)) if (!allowed.includes(k)) return false;
  for (const k of required) if (!Object.hasOwn(value, k)) return false;
  return true;
}

function decodesTo(value: unknown, bytes: number, maxChars: number): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars)
    return false;
  try {
    return bs58.decode(value).length === bytes;
  } catch {
    return false;
  }
}

const isPubkey = (v: unknown) => decodesTo(v, 32, 44);
const isSignature = (v: unknown) => decodesTo(v, 64, 88);

function isList(
  value: unknown,
  max: number,
  item: (v: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.length <= max && value.every(item);
}

const isCommitment = (v: unknown) => v === "confirmed" || v === "finalized";
// An optional key is fine when absent; when present it must pass `check`.
const optional = (o: Obj, k: string, check: (v: unknown) => boolean) =>
  !Object.hasOwn(o, k) || check(o[k]);

function isTxBase64(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TX_BASE64 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

// `{commitment?}`, from _buildArgs([], commitment, undefined, config).
function isCommitmentConfig(value: unknown): boolean {
  return (
    hasKeys(value, ["commitment"]) && optional(value, "commitment", isCommitment)
  );
}

// `{encoding:"base64", commitment?}`, from _buildArgs(args, commitment, "base64", config).
function isBase64AccountConfig(value: unknown): boolean {
  return (
    hasKeys(value, ["encoding", "commitment"], ["encoding"]) &&
    value.encoding === "base64" &&
    optional(value, "commitment", isCommitment)
  );
}

// Params that are `[]` or `[config]`.
const noArgs = (p: unknown[]) =>
  p.length === 0 || (p.length === 1 && isCommitmentConfig(p[0]));

const validators: Record<RpcMethod, (params: unknown[]) => boolean> = {
  // connection.ts getAccountInfoAndContext: [pubkey, {encoding, commitment?}]
  getAccountInfo: (p) =>
    p.length === 2 && isPubkey(p[0]) && isBase64AccountConfig(p[1]),
  // connection.ts getMultipleAccountsInfoAndContext: [[pubkeys], {encoding, commitment?}]
  getMultipleAccounts: (p) =>
    p.length === 2 &&
    isList(p[0], MAX_ACCOUNTS, isPubkey) &&
    isBase64AccountConfig(p[1]),
  getLatestBlockhash: noArgs,
  getBlockHeight: noArgs,
  getSlot: noArgs,
  getEpochInfo: noArgs,
  // connection.ts getMinimumBalanceForRentExemption: [size] or [size, {commitment}]
  getMinimumBalanceForRentExemption: (p) =>
    (p.length === 1 || (p.length === 2 && isCommitmentConfig(p[1]))) &&
    Number.isInteger(p[0]) &&
    (p[0] as number) >= 0 &&
    (p[0] as number) <= MAX_RENT_SIZE,
  // connection.ts getRecentPrioritizationFees: [[pubkeys]], or [] with none
  getRecentPrioritizationFees: (p) =>
    p.length === 0 ||
    (p.length === 1 &&
      Array.isArray(p[0]) &&
      p[0].length > 0 &&
      isList(p[0], MAX_FEE_ACCOUNTS, isPubkey)),
  // connection.ts simulateTransaction (VersionedTransaction path):
  // [base64, {...config, encoding:"base64", commitment?}]
  simulateTransaction: (p) => {
    if (p.length !== 2 || !isTxBase64(p[0])) return false;
    const c = p[1];
    return (
      hasKeys(
        c,
        ["encoding", "sigVerify", "replaceRecentBlockhash", "commitment", "accounts"],
        ["encoding", "sigVerify"],
      ) &&
      c.encoding === "base64" &&
      c.sigVerify === false &&
      optional(c, "replaceRecentBlockhash", (v) => typeof v === "boolean") &&
      optional(c, "commitment", isCommitment) &&
      optional(
        c,
        "accounts",
        (a) =>
          hasKeys(a, ["encoding", "addresses"], ["encoding", "addresses"]) &&
          a.encoding === "base64" &&
          isList(a.addresses, MAX_SIMULATE_ADDRESSES, isPubkey),
      )
    );
  },
  // connection.ts sendEncodedTransaction: [base64, {encoding:"base64",
  // maxRetries?, skipPreflight? (only sent when true), preflightCommitment?}]
  sendTransaction: (p) => {
    if (p.length !== 2 || !isTxBase64(p[0])) return false;
    const c = p[1];
    return (
      hasKeys(
        c,
        ["encoding", "skipPreflight", "preflightCommitment", "maxRetries"],
        ["encoding"],
      ) &&
      c.encoding === "base64" &&
      optional(c, "skipPreflight", (v) => v === false) &&
      optional(c, "preflightCommitment", isCommitment) &&
      optional(
        c,
        "maxRetries",
        (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SEND_RETRIES,
      )
    );
  },
  // connection.ts getSignatureStatuses: [signatures] or [signatures, config]
  getSignatureStatuses: (p) =>
    (p.length === 1 ||
      (p.length === 2 &&
        hasKeys(p[1], ["searchTransactionHistory"]) &&
        optional(p[1] as Obj, "searchTransactionHistory", (v) => typeof v === "boolean"))) &&
    isList(p[0], MAX_SIGNATURES, isSignature),
  // connection.ts getProgramAccounts: [program, {encoding, commitment?, filters}],
  // where applyDefaultMemcmpEncodingToFilters adds memcmp encoding "base58".
  // Only cp-amm vesting accounts of one position.
  getProgramAccounts: (p) => {
    if (p.length !== 2 || p[0] !== CP_AMM_PROGRAM_ID) return false;
    const c = p[1];
    if (
      !hasKeys(c, ["encoding", "commitment", "filters"], ["encoding", "filters"]) ||
      c.encoding !== "base64" ||
      !optional(c, "commitment", isCommitment)
    )
      return false;
    const filters = c.filters;
    if (!Array.isArray(filters) || filters.length !== 2) return false;
    const [size, match] = filters;
    if (!hasKeys(size, ["dataSize"], ["dataSize"]) || size.dataSize !== VESTING_SIZE)
      return false;
    if (!hasKeys(match, ["memcmp"], ["memcmp"])) return false;
    const m = match.memcmp;
    return (
      hasKeys(m, ["offset", "bytes", "encoding"], ["offset", "bytes"]) &&
      m.offset === VESTING_POSITION_OFFSET &&
      isPubkey(m.bytes) &&
      optional(m, "encoding", (v) => v === "base58")
    );
  },
};

const ENVELOPE_KEYS = ["jsonrpc", "id", "method", "params"] as const;

function isId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length <= MAX_ID_LENGTH) ||
    Number.isSafeInteger(value)
  );
}

function isRpcMethod(value: string): value is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(value);
}

export function checkRpcRequest(body: unknown): RpcCheck {
  if (Array.isArray(body))
    return { ok: false, code: -32600, message: "Batch requests are not supported" };
  if (
    !hasKeys(body, ENVELOPE_KEYS, ENVELOPE_KEYS) ||
    body.jsonrpc !== "2.0" ||
    !isId(body.id) ||
    typeof body.method !== "string" ||
    !Array.isArray(body.params)
  )
    return { ok: false, code: -32600, message: "Invalid request" };
  const method = body.method;
  if (!isRpcMethod(method))
    return { ok: false, code: -32601, message: "Method not allowed" };
  if (!validators[method](body.params))
    return { ok: false, code: -32602, message: "Invalid params" };
  return {
    ok: true,
    method,
    request: { jsonrpc: "2.0", id: body.id, method, params: body.params },
  };
}
