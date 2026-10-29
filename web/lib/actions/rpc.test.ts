// @vitest-environment node
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRpcRequest } from "@/lib/rpc/policy";

// Run web3.js's browser build, which is what visitors' browsers load (see
// lib/rpc/policy.test.ts).
vi.mock("@solana/web3.js", () => {
  const browserBuild = "@solana/web3.js/lib/index.browser.esm.js";
  return import(/* @vite-ignore */ browserBuild);
});
import { RpcBusyError, cachedReads, createActionRpc, isRpcBusy } from "./rpc";

// Synthetic keys only: fixed seeds of repeated bytes.
const payer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const blockhash = bs58.encode(new Uint8Array(32).fill(9));
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ENDPOINT = "http://rpc.test/api/rpc";

function signedTransaction(): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("doxxd") }),
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);
  return transaction;
}

type Body = { jsonrpc: "2.0"; id: string | number; method: string; params: unknown[] };
type Reply = { status?: number; result?: unknown } | Error;

// A fake upstream: records every JSON-RPC body and the fake-clock time it
// arrived, and answers from `replies` in order (the last one repeats).
function upstream(...replies: Reply[]) {
  const seen: { body: Body; at: number }[] = [];
  const fetchMock = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    seen.push({ body, at: Date.now() });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return new Response(
      status === 200
        ? JSON.stringify({ jsonrpc: "2.0", id: body.id, result: reply.result })
        : JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: "busy" } }),
      { status, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

const ctx = (value: unknown) => ({ context: { slot: 1_000 }, value });
const blockhashResult = ctx({ blockhash, lastValidBlockHeight: 1_150 });

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createActionRpc", () => {
  it("retries a 429 three times with 500 ms, 1 s and 2 s backoff, then throws RpcBusyError", async () => {
    const { seen } = upstream({ status: 429 });
    const rpc = createActionRpc(ENDPOINT);
    const result = rpc.latestBlockhash().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(RpcBusyError);
    expect((error as Error).message).toBe("Network busy · try again");
    expect(seen.map((s) => s.at)).toEqual([0, 500, 1_500, 3_500]);
  });

  it("retries network errors and recovers when the RPC answers", async () => {
    const { seen } = upstream(
      new TypeError("Failed to fetch"),
      { status: 502 },
      { result: blockhashResult },
    );
    const rpc = createActionRpc(ENDPOINT);
    const result = rpc.latestBlockhash();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ blockhash, lastValidBlockHeight: 1_150 });
    expect(seen).toHaveLength(3);
  });

  it("retries the SDKs' reads through its connection too", async () => {
    const { seen } = upstream({ status: 429 }, { result: ctx(null) });
    const rpc = createActionRpc(ENDPOINT);
    const result = rpc.connection.getAccountInfo(key(1));
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeNull();
    expect(seen.map((s) => s.body.method)).toEqual(["getAccountInfo", "getAccountInfo"]);
  });

  it("never retries a send itself: one attempt, then RpcBusyError", async () => {
    const { seen } = upstream({ status: 429 });
    const rpc = createActionRpc(ENDPOINT);
    const result = rpc.send(signedTransaction().serialize()).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(RpcBusyError);
    expect(seen).toHaveLength(1);
  });

  it("lets callers spot RpcBusyError after web3.js re-wraps it (getAccountInfo)", async () => {
    upstream({ status: 429 });
    const rpc = createActionRpc(ENDPOINT);
    const result = rpc.connection.getAccountInfo(key(1)).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeInstanceOf(RpcBusyError);
    expect((error as Error).message).toMatch(/^failed to get info about account/);
    expect(isRpcBusy(error)).toBe(true);
  });

  it("lets callers spot RpcBusyError after web3.js re-wraps it (getLatestBlockhash)", async () => {
    upstream(new TypeError("Failed to fetch"));
    const rpc = createActionRpc(ENDPOINT);
    const result = rpc.connection.getLatestBlockhash().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).not.toBeInstanceOf(RpcBusyError);
    expect((error as Error).message).toMatch(/^failed to get recent blockhash/);
    expect(isRpcBusy(error)).toBe(true);
  });

  it("isRpcBusy follows causes and stringified forms, and rejects other errors", () => {
    const busy = new RpcBusyError();
    expect(isRpcBusy(busy)).toBe(true);
    expect(isRpcBusy(new Error("outer", { cause: new Error("mid", { cause: busy }) }))).toBe(true);
    // The Raydium SDK's logWithError re-throws JSON.stringify of its arguments.
    expect(isRpcBusy(new Error(["fetch failed", JSON.stringify(busy)].join(", ")))).toBe(true);
    expect(isRpcBusy(String(busy))).toBe(true);
    expect(isRpcBusy(new Error("failed to get info about account: 400 Bad Request"))).toBe(false);
    expect(isRpcBusy(new TypeError("Failed to fetch"))).toBe(false);
    expect(isRpcBusy(null)).toBe(false);
  });

  it("puts only policy-allowed requests on the wire, and maps the replies", async () => {
    const tx = signedTransaction();
    const signature = bs58.encode(tx.signatures[0]);
    // Open, never existed, and closed by the transaction.
    const watched = [key(1).toBase58(), key(2).toBase58(), key(3).toBase58()];
    const data = Buffer.from("synthetic account");
    const { seen } = upstream(
      {
        result: ctx({
          err: null,
          logs: ["Program log: ok"],
          unitsConsumed: 61_234,
          accounts: [
            {
              executable: false,
              owner: MEMO.toBase58(),
              lamports: 1_000,
              data: [data.toString("base64"), "base64"],
              rentEpoch: 0,
            },
            null,
            {
              executable: false,
              owner: "11111111111111111111111111111111",
              lamports: 0,
              data: ["", "base64"],
              rentEpoch: 0,
            },
          ],
          returnData: null,
        }),
      },
      { result: signature },
      {
        result: ctx([
          { slot: 1_000, confirmations: null, err: null, confirmationStatus: "confirmed" },
          null,
        ]),
      },
      { result: blockhashResult },
      { result: 1_000 },
      {
        result: [
          { slot: 999, prioritizationFee: 5_000 },
          { slot: 1_000, prioritizationFee: 0 },
        ],
      },
    );
    const rpc = createActionRpc(ENDPOINT);

    await expect(rpc.simulate(tx, watched)).resolves.toEqual({
      err: null,
      logs: ["Program log: ok"],
      unitsConsumed: 61_234,
      accounts: [{ data, lamports: 1_000, owner: MEMO.toBase58() }, null, null],
    });
    await expect(rpc.send(tx.serialize())).resolves.toBe(signature);
    await expect(rpc.statuses([signature, signature])).resolves.toEqual([
      { slot: 1_000, confirmationStatus: "confirmed", err: null },
      null,
    ]);
    await expect(rpc.latestBlockhash()).resolves.toEqual({
      blockhash,
      lastValidBlockHeight: 1_150,
    });
    await expect(rpc.blockHeight()).resolves.toBe(1_000);
    await expect(rpc.priorityFees([key(3).toBase58()])).resolves.toEqual([5_000, 0]);

    expect(seen.map((s) => s.body.method)).toEqual([
      "simulateTransaction",
      "sendTransaction",
      "getSignatureStatuses",
      "getLatestBlockhash",
      "getBlockHeight",
      "getRecentPrioritizationFees",
    ]);
    for (const { body } of seen) expect(checkRpcRequest(body)).toMatchObject({ ok: true });
    expect(seen[0].body.params[1]).toEqual({
      encoding: "base64",
      sigVerify: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: watched },
    });
  });

  it("refuses to watch more than 16 accounts in a simulation", async () => {
    const { seen } = upstream({ result: null });
    const rpc = createActionRpc(ENDPOINT);
    const watch = Array.from({ length: 17 }, (_, i) => key(i + 1).toBase58());
    await expect(rpc.simulate(signedTransaction(), watch)).rejects.toThrow(/16/);
    expect(seen).toHaveLength(0);
  });
});

// Answers by method, so one test can mix account reads with other calls.
function byMethod(fail: Set<string> = new Set()) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Body;
      seen.push(body.method);
      if (fail.has(body.method)) return new Response("nope", { status: 400 });
      const result =
        body.method === "getProgramAccounts"
          ? []
          : body.method === "getMultipleAccounts"
            ? ctx(body.params[0] instanceof Array ? body.params[0].map(() => null) : [])
            : body.method === "getEpochInfo"
              ? { epoch: 7, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 1_000, blockHeight: 1_000 }
              : body.method === "getLatestBlockhash"
                ? blockhashResult
                : ctx(null);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }),
  );
  return seen;
}

describe("cachedReads", () => {
  it("memoizes account reads for the TTL, per method and arguments", async () => {
    const seen = byMethod();
    const rpc = cachedReads(createActionRpc(ENDPOINT), 30_000);
    const reads = () =>
      Promise.all([
        rpc.connection.getAccountInfo(key(1)),
        rpc.connection.getAccountInfo(key(2)),
        rpc.connection.getMultipleAccountsInfo([key(1), key(2)]),
        rpc.connection.getProgramAccounts(key(3), { filters: [{ dataSize: 8 }] }),
      ]);
    await reads();
    expect(seen).toEqual(["getAccountInfo", "getAccountInfo", "getMultipleAccounts", "getProgramAccounts"]);
    await vi.advanceTimersByTimeAsync(29_999);
    await reads();
    expect(seen).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await reads();
    expect(seen).toHaveLength(8);
  });

  it("passes everything else through, every time", async () => {
    const seen = byMethod();
    const base = createActionRpc(ENDPOINT);
    const rpc = cachedReads(base, 30_000);
    await rpc.connection.getEpochInfo("confirmed");
    await rpc.connection.getEpochInfo("confirmed");
    await rpc.latestBlockhash();
    await rpc.latestBlockhash();
    expect(seen).toEqual(["getEpochInfo", "getEpochInfo", "getLatestBlockhash", "getLatestBlockhash"]);
    expect(rpc.simulate).toBe(base.simulate);
    expect(rpc.send).toBe(base.send);
    expect(rpc.connection.rpcEndpoint).toBe(base.connection.rpcEndpoint);
  });

  it("never caches a failed read", async () => {
    const seen = byMethod(new Set(["getAccountInfo"]));
    const rpc = cachedReads(createActionRpc(ENDPOINT), 30_000);
    await expect(rpc.connection.getAccountInfo(key(1))).rejects.toThrow();
    await expect(rpc.connection.getAccountInfo(key(1))).rejects.toThrow();
    expect(seen).toEqual(["getAccountInfo", "getAccountInfo"]);
  });

  it("leaves the wrapped rpc uncached", async () => {
    const seen = byMethod();
    const base = createActionRpc(ENDPOINT);
    const rpc = cachedReads(base, 30_000);
    await rpc.connection.getMultipleAccountsInfo([key(4)]);
    await rpc.connection.getMultipleAccountsInfo([key(4)]);
    await base.connection.getMultipleAccountsInfo([key(4)]);
    await base.connection.getMultipleAccountsInfo([key(4)]);
    expect(seen).toEqual(["getMultipleAccounts", "getMultipleAccounts", "getMultipleAccounts"]);
  });
});
