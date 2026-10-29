// @vitest-environment node
import { readFileSync } from "node:fs";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

// Run web3.js's browser build, which is what visitors' browsers load. It
// builds the same requests, and skips node-fetch, whose punycode import
// prints a deprecation warning under Node 22.
vi.mock("@solana/web3.js", () => {
  const browserBuild = "@solana/web3.js/lib/index.browser.esm.js";
  return import(/* @vite-ignore */ browserBuild);
});
import {
  CP_AMM_PROGRAM_ID,
  RPC_METHODS,
  VESTING_POSITION_OFFSET,
  VESTING_SIZE,
  checkRpcRequest,
  type RpcMethod,
} from "./policy";

// Synthetic keys only: fixed seeds of repeated bytes.
const payer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const keys = (n: number) =>
  Array.from({ length: n }, (_, i) => key((i % 200) + 10));
const blockhash = bs58.encode(new Uint8Array(32).fill(9));
const signature = bs58.encode(new Uint8Array(64).fill(8));
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const CP_AMM = new PublicKey(CP_AMM_PROGRAM_ID);

function signed(
  instructions: TransactionInstruction[],
  form: "v0" | "legacy" = "v0",
  lookups: AddressLookupTableAccount[] = [],
): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions });
  const transaction = new VersionedTransaction(
    form === "v0" ? message.compileToV0Message(lookups) : message.compileToLegacyMessage(),
  );
  transaction.sign([payer]);
  return transaction;
}

// Allowed top-level programs only (lib/actions/programs.ts).
function signedTransaction(): VersionedTransaction {
  return signed([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })]);
}

// Captures the exact JSON-RPC body web3.js 1.99.0's Connection puts on the
// wire, so the policy is tested against the client Task 5 actually uses.
async function wire(
  run: (connection: Connection) => Promise<unknown>,
  commitment?: Commitment,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const connection = new Connection("http://rpc.test/", {
    commitment,
    disableRetryOnRateLimit: true,
    fetch: (async (_input: unknown, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body));
      return new Response("stub", { status: 500 });
    }) as unknown as typeof fetch,
  });
  await run(connection).then(
    () => undefined,
    () => undefined,
  );
  if (!body) throw new Error("web3.js sent nothing");
  return body;
}

const vestingFilters = (position: PublicKey) => [
  { dataSize: VESTING_SIZE },
  { memcmp: { offset: VESTING_POSITION_OFFSET, bytes: position.toBase58() } },
];

const calls: Array<[RpcMethod, (c: Connection) => Promise<unknown>]> = [
  ["getAccountInfo", (c) => c.getAccountInfo(key(1))],
  ["getAccountInfo", (c) => c.getAccountInfo(key(1), "finalized")],
  ["getMultipleAccounts", (c) => c.getMultipleAccountsInfo(keys(100))],
  ["getMultipleAccounts", (c) => c.getMultipleAccountsInfo([])],
  ["getLatestBlockhash", (c) => c.getLatestBlockhash()],
  ["getLatestBlockhash", (c) => c.getLatestBlockhash({ commitment: "finalized" })],
  ["getLatestBlockhash", (c) => c.getLatestBlockhash({})],
  ["getBlockHeight", (c) => c.getBlockHeight()],
  ["getBlockHeight", (c) => c.getBlockHeight("finalized")],
  ["getSlot", (c) => c.getSlot()],
  ["getEpochInfo", (c) => c.getEpochInfo()],
  ["getMinimumBalanceForRentExemption", (c) => c.getMinimumBalanceForRentExemption(0)],
  ["getMinimumBalanceForRentExemption", (c) => c.getMinimumBalanceForRentExemption(10_240)],
  [
    "getRecentPrioritizationFees",
    (c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: keys(128) }),
  ],
  ["getRecentPrioritizationFees", (c) => c.getRecentPrioritizationFees()],
  [
    "simulateTransaction",
    (c) => c.simulateTransaction(signedTransaction(), { sigVerify: false }),
  ],
  [
    "simulateTransaction",
    (c) =>
      c.simulateTransaction(signedTransaction(), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: keys(16).map(String) },
      }),
  ],
  ["sendTransaction", (c) => c.sendRawTransaction(signedTransaction().serialize())],
  [
    "sendTransaction",
    (c) =>
      c.sendRawTransaction(signedTransaction().serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 5,
      }),
  ],
  ["sendTransaction", (c) => c.sendTransaction(signedTransaction(), { maxRetries: 0 })],
  ["getSignatureStatuses", (c) => c.getSignatureStatuses([signature])],
  [
    "getSignatureStatuses",
    (c) =>
      c.getSignatureStatuses(Array(64).fill(signature), {
        searchTransactionHistory: true,
      }),
  ],
  [
    "getProgramAccounts",
    (c) =>
      c.getProgramAccounts(new PublicKey(CP_AMM_PROGRAM_ID), {
        encoding: "base64",
        filters: vestingFilters(key(3)),
      }),
  ],
  [
    "getProgramAccounts",
    (c) =>
      c.getProgramAccounts(new PublicKey(CP_AMM_PROGRAM_ID), {
        filters: vestingFilters(key(3)),
      }),
  ],
];

describe("checkRpcRequest accepts what web3.js 1.99.0 sends", () => {
  it("allows exactly the planned methods", () => {
    expect([...RPC_METHODS].sort()).toEqual(
      [
        "getAccountInfo",
        "getBlockHeight",
        "getEpochInfo",
        "getLatestBlockhash",
        "getMinimumBalanceForRentExemption",
        "getMultipleAccounts",
        "getProgramAccounts",
        "getRecentPrioritizationFees",
        "getSignatureStatuses",
        "getSlot",
        "sendTransaction",
        "simulateTransaction",
      ].sort(),
    );
    expectTypeOf<RpcMethod>().toEqualTypeOf<
      | "getAccountInfo"
      | "getMultipleAccounts"
      | "getLatestBlockhash"
      | "getBlockHeight"
      | "getSlot"
      | "getEpochInfo"
      | "getMinimumBalanceForRentExemption"
      | "getRecentPrioritizationFees"
      | "simulateTransaction"
      | "sendTransaction"
      | "getSignatureStatuses"
      | "getProgramAccounts"
    >();
  });

  for (const commitment of [undefined, "confirmed", "finalized"] as const) {
    it.each(calls.map(([method, run], i) => [`${method} #${i}`, method, run] as const))(
      `%s (connection commitment ${commitment ?? "unset"})`,
      async (_label, method, run) => {
        const body = await wire(run, commitment);
        expect(body).toMatchObject({ jsonrpc: "2.0", method });
        const result = checkRpcRequest(body);
        expect(result).toEqual({ ok: true, method, request: body });
      },
    );
  }

  it("covers every allowed method with a web3.js call", () => {
    expect(new Set(calls.map(([m]) => m))).toEqual(new Set(RPC_METHODS));
  });

  it("sees the wire shapes the policy was written against", async () => {
    expect(
      (
        await wire((c) =>
          c.getRecentPrioritizationFees({ lockedWritableAccounts: [key(1)] }),
        )
      ).params,
    ).toEqual([[key(1).toBase58()]]);
    expect((await wire((c) => c.getRecentPrioritizationFees())).params).toEqual([]);
    expect((await wire((c) => c.getSlot())).params).toEqual([]);
    expect((await wire((c) => c.getSlot(), "confirmed")).params).toEqual([
      { commitment: "confirmed" },
    ]);
    expect(
      (await wire((c) => c.getMinimumBalanceForRentExemption(165), "confirmed"))
        .params,
    ).toEqual([165, { commitment: "confirmed" }]);
    const send = await wire((c) =>
      c.sendRawTransaction(signedTransaction().serialize(), {
        skipPreflight: false,
      }),
    );
    // web3.js drops skipPreflight:false from the wire.
    expect((send.params as unknown[])[1]).toEqual({ encoding: "base64" });
    const gpa = await wire(
      (c) =>
        c.getProgramAccounts(new PublicKey(CP_AMM_PROGRAM_ID), {
          encoding: "base64",
          filters: vestingFilters(key(3)),
        }),
      "confirmed",
    );
    expect(gpa.params).toEqual([
      CP_AMM_PROGRAM_ID,
      {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: VESTING_SIZE },
          {
            memcmp: {
              offset: VESTING_POSITION_OFFSET,
              bytes: key(3).toBase58(),
              encoding: "base58",
            },
          },
        ],
      },
    ]);
  });
});

const tx64 = Buffer.from(signedTransaction().serialize()).toString("base64");
const rpc = (method: string, params: unknown) => ({
  jsonrpc: "2.0",
  id: "5f0c2a2e-0000-4000-8000-000000000001",
  method,
  params,
});
const gpaConfig = (over: Record<string, unknown> = {}) => ({
  encoding: "base64",
  filters: [
    { dataSize: VESTING_SIZE },
    {
      memcmp: {
        offset: VESTING_POSITION_OFFSET,
        bytes: key(3).toBase58(),
        encoding: "base58",
      },
    },
  ],
  ...over,
});

describe("checkRpcRequest rejects", () => {
  const code = (body: unknown) => {
    const result = checkRpcRequest(body);
    return result.ok ? "accepted" : result.code;
  };

  it("a batch array", () => {
    expect(code([rpc("getSlot", [])])).toBe(-32600);
  });

  it("a malformed envelope", () => {
    expect(code(null)).toBe(-32600);
    expect(code("getSlot")).toBe(-32600);
    expect(code({ ...rpc("getSlot", []), jsonrpc: "1.0" })).toBe(-32600);
    expect(code({ jsonrpc: "2.0", method: "getSlot", params: [] })).toBe(-32600);
    expect(code({ ...rpc("getSlot", []), id: null })).toBe(-32600);
    expect(code({ ...rpc("getSlot", []), id: "x".repeat(129) })).toBe(-32600);
    expect(code({ jsonrpc: "2.0", id: 1, method: "getSlot" })).toBe(-32600);
    expect(code(rpc("getSlot", {}))).toBe(-32600);
    expect(code({ ...rpc("getSlot", []), extra: 1 })).toBe(-32600);
    expect(code({ ...rpc("getSlot", []), id: 7 })).toBe("accepted");
  });

  it("an unknown method", () => {
    expect(code(rpc("requestAirdrop", [key(1).toBase58(), 1_000_000_000]))).toBe(
      -32601,
    );
    expect(code(rpc("constructor", []))).toBe(-32601);
    expect(code(rpc("__proto__", []))).toBe(-32601);
    expect(code(rpc("toString", []))).toBe(-32601);
    expect(code(rpc("getParsedAccountInfo", []))).toBe(-32601);
  });

  it("getProgramAccounts on another program", () => {
    expect(code(rpc("getProgramAccounts", [key(4).toBase58(), gpaConfig()]))).toBe(
      -32602,
    );
    expect(
      code(rpc("getProgramAccounts", [CP_AMM_PROGRAM_ID, gpaConfig()])),
    ).toBe("accepted");
  });

  it("getProgramAccounts with an extra, missing or changed filter", () => {
    const [size, memcmp] = gpaConfig().filters;
    const extra = { memcmp: { offset: 0, bytes: key(5).toBase58() } };
    for (const filters of [
      [size, memcmp, extra],
      [memcmp],
      [size],
      [memcmp, size],
      [{ dataSize: VESTING_SIZE + 1 }, memcmp],
      [size, { memcmp: { ...memcmp.memcmp, offset: VESTING_POSITION_OFFSET + 32 } }],
      [size, { memcmp: { ...memcmp.memcmp, encoding: "base64" } }],
      [size, { memcmp: { ...memcmp.memcmp, bytes: "abc" } }],
      [size, { memcmp: { ...memcmp.memcmp, extra: 1 } }],
      [{ dataSize: VESTING_SIZE, extra: 1 }, memcmp],
    ])
      expect(
        code(rpc("getProgramAccounts", [CP_AMM_PROGRAM_ID, gpaConfig({ filters })])),
      ).toBe(-32602);
    expect(
      code(
        rpc("getProgramAccounts", [CP_AMM_PROGRAM_ID, gpaConfig({ withContext: true })]),
      ),
    ).toBe(-32602);
    expect(
      code(
        rpc("getProgramAccounts", [
          CP_AMM_PROGRAM_ID,
          gpaConfig({ encoding: "jsonParsed" }),
        ]),
      ),
    ).toBe(-32602);
    expect(code(rpc("getProgramAccounts", [CP_AMM_PROGRAM_ID]))).toBe(-32602);
  });

  it("sendTransaction with skipPreflight:true", () => {
    expect(
      code(rpc("sendTransaction", [tx64, { encoding: "base64", skipPreflight: true }])),
    ).toBe(-32602);
    expect(
      code(rpc("sendTransaction", [tx64, { encoding: "base64", skipPreflight: false }])),
    ).toBe("accepted");
  });

  it("sendTransaction with too many retries or another commitment", () => {
    for (const config of [
      { encoding: "base64", maxRetries: 6 },
      { encoding: "base64", maxRetries: -1 },
      { encoding: "base64", maxRetries: 1.5 },
      { encoding: "base64", preflightCommitment: "processed" },
      { encoding: "base58" },
      {},
    ])
      expect(code(rpc("sendTransaction", [tx64, config]))).toBe(-32602);
    expect(code(rpc("sendTransaction", [tx64]))).toBe(-32602);
  });

  it("simulateTransaction with sigVerify:true or without sigVerify", () => {
    const base = { encoding: "base64", sigVerify: false };
    expect(code(rpc("simulateTransaction", [tx64, base]))).toBe("accepted");
    expect(
      code(rpc("simulateTransaction", [tx64, { ...base, sigVerify: true }])),
    ).toBe(-32602);
    expect(code(rpc("simulateTransaction", [tx64, { encoding: "base64" }]))).toBe(
      -32602,
    );
    expect(
      code(
        rpc("simulateTransaction", [
          tx64,
          { ...base, accounts: { encoding: "jsonParsed", addresses: [] } },
        ]),
      ),
    ).toBe(-32602);
    expect(
      code(
        rpc("simulateTransaction", [
          tx64,
          { ...base, accounts: { encoding: "base64", addresses: keys(17).map(String) } },
        ]),
      ),
    ).toBe(-32602);
    expect(
      code(rpc("simulateTransaction", [tx64, { ...base, innerInstructions: true }])),
    ).toBe(-32602);
  });

  it("an over-long or malformed base64 transaction", () => {
    const long = "A".repeat(1704);
    expect(
      code(rpc("sendTransaction", [long, { encoding: "base64" }])),
    ).toBe(-32602);
    expect(
      code(rpc("simulateTransaction", [long, { encoding: "base64", sigVerify: false }])),
    ).toBe(-32602);
    for (const bad of ["", "not base64!", "QUJD=A==", 12])
      expect(code(rpc("sendTransaction", [bad, { encoding: "base64" }]))).toBe(
        -32602,
      );
    // At the length cap, but not a transaction (ruling S-R002: the bytes
    // must parse).
    expect(
      code(rpc("sendTransaction", ["A".repeat(1700), { encoding: "base64" }])),
    ).toBe(-32602);
  });

  it("101 pubkeys, and other over-long lists", () => {
    const config = { encoding: "base64" };
    expect(
      code(rpc("getMultipleAccounts", [keys(101).map(String), config])),
    ).toBe(-32602);
    expect(
      code(rpc("getMultipleAccounts", [keys(100).map(String), config])),
    ).toBe("accepted");
    expect(
      code(rpc("getRecentPrioritizationFees", [keys(129).map(String)])),
    ).toBe(-32602);
    expect(
      code(rpc("getSignatureStatuses", [Array(65).fill(signature)])),
    ).toBe(-32602);
  });

  it("an extra config key", () => {
    expect(
      code(
        rpc("getAccountInfo", [
          key(1).toBase58(),
          { encoding: "base64", dataSlice: { offset: 0, length: 8 } },
        ]),
      ),
    ).toBe(-32602);
    expect(
      code(
        rpc("getAccountInfo", [key(1).toBase58(), { encoding: "base64", minContextSlot: 1 }]),
      ),
    ).toBe(-32602);
    expect(
      code(rpc("getLatestBlockhash", [{ commitment: "confirmed", minContextSlot: 1 }])),
    ).toBe(-32602);
    expect(
      code(rpc("sendTransaction", [tx64, { encoding: "base64", minContextSlot: 1 }])),
    ).toBe(-32602);
    expect(
      code(rpc("getSignatureStatuses", [[signature], { other: true }])),
    ).toBe(-32602);
  });

  it("wrong encodings, commitments, values and arities", () => {
    const pk = key(1).toBase58();
    for (const [method, params] of [
      ["getAccountInfo", [pk, { encoding: "jsonParsed" }]],
      ["getAccountInfo", [pk, { encoding: "base64", commitment: "processed" }]],
      ["getAccountInfo", [pk]],
      ["getAccountInfo", ["not-a-key", { encoding: "base64" }]],
      ["getAccountInfo", [bs58.encode(new Uint8Array(31).fill(1)), { encoding: "base64" }]],
      ["getAccountInfo", [pk, { encoding: "base64" }, {}]],
      ["getSlot", [{ commitment: "processed" }]],
      ["getSlot", [{}, {}]],
      ["getEpochInfo", ["confirmed"]],
      ["getMinimumBalanceForRentExemption", [10_241]],
      ["getMinimumBalanceForRentExemption", [-1]],
      ["getMinimumBalanceForRentExemption", [1.5]],
      ["getMinimumBalanceForRentExemption", ["165"]],
      ["getMinimumBalanceForRentExemption", []],
      ["getRecentPrioritizationFees", [[pk], {}]],
      ["getSignatureStatuses", [["abc"]]],
      ["getSignatureStatuses", [[signature], { searchTransactionHistory: "yes" }]],
    ] as const)
      expect(code(rpc(method, params)), `${method} ${JSON.stringify(params)}`).toBe(
        -32602,
      );
  });
});

describe("vesting discovery constants", () => {
  // The IDL Vesting account: an 8-byte discriminator, then its fields.
  type IdlType =
    | string
    | { array: [IdlType, number] }
    | { defined: { name: string } }
    | { option: IdlType };
  type IdlTypeDef = {
    name: string;
    type: { kind: string; fields: Array<{ name: string; type: IdlType }> };
  };
  const primitive: Record<string, number> = {
    u8: 1,
    i8: 1,
    u16: 2,
    i16: 2,
    u32: 4,
    i32: 4,
    u64: 8,
    i64: 8,
    u128: 16,
    i128: 16,
    pubkey: 32,
  };

  it("match the cp-amm 1.5.1 IDL Vesting account", async () => {
    const pkg = JSON.parse(
      readFileSync(
        new URL(
          "../../node_modules/@meteora-ag/cp-amm-sdk/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(pkg.version).toBe("1.5.1");
    // Loading the SDK in Node prints two known third-party warnings: bigint
    // bindings not built (installs use --ignore-scripts) and node-fetch's
    // punycode deprecation. Silence them for this one import only.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noDeprecation = process.noDeprecation;
    process.noDeprecation = true;
    const sdk = await import("@meteora-ag/cp-amm-sdk").finally(() => {
      process.noDeprecation = noDeprecation;
      warn.mockRestore();
    });
    const idl = sdk.CpAmmIdl as unknown as {
      address: string;
      accounts: Array<{ name: string; discriminator: number[] }>;
      types: IdlTypeDef[];
    };
    expect(idl.address).toBe(CP_AMM_PROGRAM_ID);
    const account = idl.accounts.find((a) => a.name === "Vesting");
    expect(account?.discriminator).toHaveLength(8);
    const types = new Map(idl.types.map((t) => [t.name, t]));
    const size = (type: IdlType): number => {
      if (typeof type === "string") {
        const bytes = primitive[type];
        if (bytes === undefined) throw new Error(`unsized ${type}`);
        return bytes;
      }
      if ("array" in type) return size(type.array[0]) * type.array[1];
      if ("defined" in type) {
        const def = types.get(type.defined.name);
        if (!def || def.type.kind !== "struct") throw new Error("bad type");
        return def.type.fields.reduce((sum, f) => sum + size(f.type), 0);
      }
      throw new Error("variable-size field in a fixed account");
    };
    const vesting = types.get("Vesting")!;
    const fields = vesting.type.fields;
    const positionIndex = fields.findIndex((f) => f.name === "position");
    expect(fields[positionIndex].type).toBe("pubkey");
    const positionOffset =
      8 + fields.slice(0, positionIndex).reduce((s, f) => s + size(f.type), 0);
    const total = 8 + fields.reduce((s, f) => s + size(f.type), 0);
    expect(VESTING_POSITION_OFFSET).toBe(positionOffset);
    expect(VESTING_SIZE).toBe(total);
    // Anchor's own coder agrees on the account size.
    expect(sdk.cpAmmCoder.accounts.size("Vesting")).toBe(VESTING_SIZE);
  });
});

// --- Top-level programs of sent and simulated transactions (S-R002) ----------

describe("checkRpcRequest and the transaction's programs", () => {
  const b64 = (tx: VersionedTransaction | Uint8Array) =>
    Buffer.from(tx instanceof VersionedTransaction ? tx.serialize() : tx).toString("base64");
  const verdict = (tx: VersionedTransaction | Uint8Array) =>
    [
      checkRpcRequest(rpc("sendTransaction", [b64(tx), { encoding: "base64" }])),
      checkRpcRequest(rpc("simulateTransaction", [b64(tx), { encoding: "base64", sigVerify: false }])),
    ].map((r) => (r.ok ? "accepted" : r.message));
  const budget = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
  const cpAmm = new TransactionInstruction({ programId: CP_AMM, keys: [], data: Buffer.from([1, 2, 3]) });
  const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: key(30), lamports: 1 });
  const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("hi") });
  const NOT_ALLOWED = ["Transaction not allowed", "Transaction not allowed"];

  it("accepts legacy and v0 transactions that call only allowed programs", () => {
    for (const form of ["legacy", "v0"] as const)
      expect(verdict(signed([budget, cpAmm], form)), form).toEqual(["accepted", "accepted"]);
  });

  it("refuses a System transfer or a Memo at the top level, in either form", () => {
    for (const form of ["legacy", "v0"] as const) {
      expect(verdict(signed([budget, transfer], form)), form).toEqual(NOT_ALLOWED);
      expect(verdict(signed([memo], form)), form).toEqual(NOT_ALLOWED);
    }
  });

  it("refuses a v0 transaction with an address-table lookup", () => {
    const table = new AddressLookupTableAccount({
      key: key(31),
      state: { deactivationSlot: BigInt(2) ** BigInt(64) - BigInt(1), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [key(32)] },
    });
    const viaTable = new TransactionInstruction({
      programId: CP_AMM,
      keys: [{ pubkey: key(32), isSigner: false, isWritable: true }],
      data: Buffer.from([1]),
    });
    const tx = signed([viaTable], "v0", [table]);
    expect(tx.message.addressTableLookups).toHaveLength(1);
    expect(verdict(tx)).toEqual(NOT_ALLOWED);
  });

  it("refuses crafted bytes: another version, trailing or missing bytes, a program index out of range", () => {
    const good = signed([budget, cpAmm]).serialize();
    const messageAt = 1 + 64;
    const v1 = Uint8Array.from(good);
    v1[messageAt] = 0x81;
    expect(verdict(v1)).toEqual(NOT_ALLOWED);
    expect(verdict(Uint8Array.from([...good, 0]))).toEqual(NOT_ALLOWED);
    expect(verdict(good.subarray(0, good.length - 1))).toEqual(NOT_ALLOWED);
    // The last instruction's program-id index, pointed past the keys.
    const message = signed([budget, cpAmm]).message;
    const keyCount = message.staticAccountKeys.length;
    const lastIx = message.compiledInstructions.at(-1)!;
    // v0 tail: [program index][1 account count][data len][data][lookup count]
    const programAt = good.length - 1 - lastIx.data.length - 1 - 1 - 1;
    expect(good[programAt]).toBe(lastIx.programIdIndex);
    const outOfRange = Uint8Array.from(good);
    outOfRange[programAt] = keyCount;
    expect(verdict(outOfRange)).toEqual(NOT_ALLOWED);
  });

  it("refuses hand-built legacy bytes that hide a System instruction after allowed ones", () => {
    // 1 signature, legacy header, keys [payer, ComputeBudget, System],
    // blockhash, then two instructions: ComputeBudget, then System.
    const keysBytes = [payer.publicKey, ComputeBudgetProgram.programId, SystemProgram.programId].flatMap((k) => [...k.toBytes()]);
    const bytes = Uint8Array.from([
      1, ...new Uint8Array(64),
      1, 0, 2,
      3, ...keysBytes,
      ...bs58.decode(blockhash),
      2,
      1, 0, 1, 2,
      2, 0, 4, 2, 0, 0, 0,
    ]);
    expect(verdict(bytes)).toEqual(NOT_ALLOWED);
    // The same message with only the ComputeBudget instruction.
    const allowedOnly = Uint8Array.from([...bytes.subarray(0, bytes.length - 12), 1, 1, 0, 1, 2]);
    expect(verdict(allowedOnly)).toEqual(["accepted", "accepted"]);
  });
});
