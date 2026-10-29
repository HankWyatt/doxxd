// The browser's Solana RPC client for wallet actions. It talks to Doxxd's
// narrow /api/rpc pass-through (lib/rpc/policy.ts) through web3.js's
// Connection, over HTTP only: nothing here opens a websocket.
//
// Imports web3.js, so it is reached only through the lazy entry
// lib/actions/build/index.ts (ruling R-P4).
import { Connection, PublicKey, type VersionedTransaction } from "@solana/web3.js";

export type ActionRpc = {
  connection: Connection;
  simulate(
    tx: VersionedTransaction,
    watch?: string[],
  ): Promise<{
    err: unknown | null;
    logs: string[];
    unitsConsumed: number | null;
    // Post-simulation state of each watched address, in order; null when the
    // account does not exist afterwards (never created, or closed).
    accounts: SimulatedAccount[];
  }>;
  send(raw: Uint8Array): Promise<string>;
  statuses(
    sigs: string[],
  ): Promise<({ slot: number; confirmationStatus: string | null; err: unknown | null } | null)[]>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  priorityFees(writable: string[]): Promise<number[]>;
};

export type SimulatedAccount = { data: Buffer; lamports: number; owner: string } | null;

const RPC_BUSY_NAME = "RpcBusyError";
// Distinctive on purpose: callers that re-wrap errors keep only text, so
// isRpcBusy looks for this message (or the name) in what they re-throw.
const RPC_BUSY_MESSAGE = "Network busy · try again";

/** The RPC stayed rate-limited or unreachable after every retry. */
export class RpcBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(RPC_BUSY_MESSAGE, options);
    this.name = RPC_BUSY_NAME;
  }
}

/**
 * True when `error` is, wraps or was re-thrown from an RpcBusyError. web3.js
 * re-wraps some failures as `new Error("failed to …: " + e)` without a cause
 * (getAccountInfo, getLatestBlockhash), and the Raydium SDK's logWithError
 * re-throws `JSON.stringify`ed arguments, so this checks the instance, then
 * the `cause` chain, then the name or message inside the text.
 */
export function isRpcBusy(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (current instanceof RpcBusyError) return true;
    if (typeof current === "object" && (current as { name?: unknown }).name === RPC_BUSY_NAME)
      return true;
    const text =
      typeof current === "string"
        ? current
        : current instanceof Error
          ? current.message
          : "";
    if (text.includes(RPC_BUSY_MESSAGE) || text.includes(`"name":"${RPC_BUSY_NAME}"`))
      return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

const RETRY_DELAYS_MS = [500, 1_000, 2_000];
const REQUEST_TIMEOUT_MS = 20_000;
// 429 from the pass-through's limiter or the upstream; 502/504 are the
// pass-through's "upstream unavailable" and "upstream timed out" (network
// errors one hop away); 503 is a gateway's equivalent.
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
// lib/rpc/policy.ts limits.
const MAX_SIMULATE_WATCH = 16;
const MAX_STATUS_SIGNATURES = 64;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function rpcMethod(init?: RequestInit): string | null {
  try {
    const body = JSON.parse(String(init?.body)) as { method?: unknown };
    return typeof body.method === "string" ? body.method : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// web3.js's own 429 retry is off (disableRetryOnRateLimit). This one covers
// every read made through the Connection, including the SDKs' reads, with
// fixed backoff, and throws RpcBusyError once retries run out. A send is
// never retried here: it fails fast with RpcBusyError and the runner decides
// whether to re-send the same signed bytes.
const retryingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const retries = rpcMethod(init) === "sendTransaction" ? 0 : RETRY_DELAYS_MS.length;
  for (let attempt = 0; ; attempt++) {
    let cause: unknown;
    try {
      const response = await fetchWithTimeout(input, init);
      if (!TRANSIENT_STATUSES.has(response.status)) return response;
      await response.body?.cancel().catch(() => undefined);
      cause = new Error(`HTTP ${response.status}`);
    } catch (error) {
      cause = error;
    }
    if (attempt >= retries) throw new RpcBusyError({ cause });
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}) as typeof fetch;

/** ActionRpc over any Connection (createActionRpc's, or a test double's). */
export function actionRpcFor(connection: Connection): ActionRpc {
  return {
    connection,
    async simulate(tx, watch = []) {
      if (watch.length > MAX_SIMULATE_WATCH)
        throw new Error(`A simulation can watch at most ${MAX_SIMULATE_WATCH} accounts.`);
      // sigVerify must be explicit: web3.js does not add it for v0
      // transactions, and the pass-through requires it.
      const { value } = await connection.simulateTransaction(tx, {
        sigVerify: false,
        commitment: "confirmed",
        ...(watch.length ? { accounts: { encoding: "base64", addresses: watch } } : {}),
      });
      return {
        err: value.err ?? null,
        logs: value.logs ?? [],
        unitsConsumed: value.unitsConsumed ?? null,
        accounts: watch.map((_, i): SimulatedAccount => {
          const account = value.accounts?.[i];
          // A closed account comes back as null or with zero lamports.
          if (!account || account.lamports === 0) return null;
          return {
            data: Buffer.from(account.data[0], "base64"),
            lamports: account.lamports,
            owner: account.owner,
          };
        }),
      };
    },
    async send(raw) {
      return connection.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
    },
    async statuses(sigs) {
      const out: Awaited<ReturnType<ActionRpc["statuses"]>> = [];
      for (let i = 0; i < sigs.length; i += MAX_STATUS_SIGNATURES) {
        const { value } = await connection.getSignatureStatuses(
          sigs.slice(i, i + MAX_STATUS_SIGNATURES),
        );
        for (const status of value)
          out.push(
            status && {
              slot: status.slot,
              confirmationStatus: status.confirmationStatus ?? null,
              err: status.err ?? null,
            },
          );
      }
      return out;
    },
    async latestBlockhash() {
      // The ...AndContext form, because getLatestBlockhash re-wraps errors
      // as plain Errors and would hide RpcBusyError.
      const { value } = await connection.getLatestBlockhashAndContext("confirmed");
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async blockHeight() {
      return connection.getBlockHeight("confirmed");
    },
    async priorityFees(writable) {
      const fees = await connection.getRecentPrioritizationFees({
        lockedWritableAccounts: writable.map((address) => new PublicKey(address)),
      });
      return fees.map((fee) => fee.prioritizationFee);
    },
  };
}

/**
 * ActionRpc for an absolute http(s) endpoint, normally the page's own
 * `${location.origin}/api/rpc`.
 */
export function createActionRpc(endpoint: string): ActionRpc {
  return actionRpcFor(
    new Connection(endpoint, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: retryingFetch,
    }),
  );
}

// Connection methods whose results are account state (ruling R-P5).
const ACCOUNT_READS = new Set([
  "getAccountInfo",
  "getAccountInfoAndContext",
  "getParsedAccountInfo",
  "getMultipleAccountsInfo",
  "getMultipleAccountsInfoAndContext",
  "getMultipleParsedAccounts",
  "getProgramAccounts",
  "getParsedProgramAccounts",
]);

/**
 * `rpc` with its account reads (getAccountInfo, getMultipleAccounts and
 * getProgramAccounts, through any of the Connection's methods for them)
 * memoized per method and arguments for `ttlMs`, so a withdraw dialog can
 * re-quote presets from the state it already loaded. A failed read is never
 * kept. Everything else, including simulate and send, passes through, and
 * `rpc` itself stays uncached.
 */
export function cachedReads(rpc: ActionRpc, ttlMs: number): ActionRpc {
  const cache = new Map<string, { at: number; result: Promise<unknown> }>();
  const connection = new Proxy(rpc.connection, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property !== "string" || !ACCOUNT_READS.has(property)) return method.bind(target);
      return (...args: unknown[]) => {
        // PublicKey serializes to base58, so equal addresses share a key.
        const key = property + JSON.stringify(args);
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && now - hit.at < ttlMs) return hit.result;
        const result = Promise.resolve(method.apply(target, args));
        cache.set(key, { at: now, result });
        result.catch(() => {
          if (cache.get(key)?.result === result) cache.delete(key);
        });
        return result;
      };
    },
  });
  return { ...rpc, connection };
}
