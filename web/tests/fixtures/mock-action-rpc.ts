// A Solana JSON-RPC double that answers from a SyntheticChain.
//
// Every request first goes through the /api/rpc policy (lib/rpc/policy.ts),
// so code under test can only use what the real pass-through allows; refused
// requests get the pass-through's HTTP 400 and JSON-RPC error.
import { Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { actionRpcFor, type ActionRpc } from "@/lib/actions/rpc";
import { checkRpcRequest } from "@/lib/rpc/policy";
import { SYNTHETIC, type ChainAccount, type SyntheticChain } from "./actions-chain";

export const MOCK_BLOCKHASH = bs58.encode(new Uint8Array(32).fill(5));
export const MOCK_UNITS_CONSUMED = 60_000;
export const MOCK_PRIORITY_FEES = [1_000, 2_000, 3_000, 4_000];

const SLOTS_PER_EPOCH = 432_000;
const rentExempt = (size: number) => (size + 128) * 6_960;

function accountJson(info: ChainAccount | undefined) {
  if (!info) return null;
  return {
    data: [info.data.toString("base64"), "base64"],
    executable: false,
    lamports: info.lamports,
    owner: info.owner,
    rentEpoch: 0,
    space: info.data.length,
  };
}

type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string } };

function matches(info: ChainAccount, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.dataSize !== undefined) return info.data.length === f.dataSize;
    if (f.memcmp) {
      const want = Buffer.from(bs58.decode(f.memcmp.bytes));
      const at = f.memcmp.offset;
      return info.data.subarray(at, at + want.length).equals(want);
    }
    return false;
  });
}

/**
 * What simulateTransaction reports for the watched addresses, in order: the
 * state after the transaction (null for an account that does not exist
 * afterwards). The double does not run programs, so by default the accounts
 * come back as they are now, and every balance delta is zero.
 */
export type PostStates = (watch: string[], chain: SyntheticChain) => (ChainAccount | null)[];

/** PostStates that report `changes` for their addresses and the rest as they are. */
export function postStatesFrom(changes: Record<string, ChainAccount | null>): PostStates {
  return (watch, chain) =>
    watch.map((address) =>
      Object.hasOwn(changes, address) ? changes[address] : (chain.accounts.get(address) ?? null),
    );
}

export type AnswerOptions = { postStates?: PostStates };

/**
 * Answers one JSON-RPC request body from `chain`, with the HTTP status the
 * pass-through would use. Also usable from a Playwright route.
 */
export function answerRpc(
  chain: SyntheticChain,
  body: unknown,
  options: AnswerOptions = {},
): { status: number; body: Record<string, unknown> } {
  const checked = checkRpcRequest(body);
  if (!checked.ok) {
    const id = (body as { id?: unknown } | null)?.id;
    return {
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: typeof id === "string" || typeof id === "number" ? id : null,
        error: { code: checked.code, message: checked.message },
      },
    };
  }
  const { method, params, id } = checked.request;
  const { slot, blockHeight, lastValidBlockHeight, epoch } = SYNTHETIC.clock;
  const ctx = (value: unknown) => ({ context: { slot }, value });
  const get = (address: unknown) => chain.accounts.get(String(address));
  let result: unknown;
  switch (method) {
    case "getAccountInfo":
      result = ctx(accountJson(get(params[0])));
      break;
    case "getMultipleAccounts":
      result = ctx((params[0] as string[]).map((a) => accountJson(get(a))));
      break;
    case "getProgramAccounts": {
      const filters = (params[1] as { filters: Filter[] }).filters;
      result = [...chain.accounts]
        .filter(([, info]) => info.owner === params[0] && matches(info, filters))
        .map(([pubkey, info]) => ({ pubkey, account: accountJson(info) }));
      break;
    }
    case "getLatestBlockhash":
      result = ctx({ blockhash: MOCK_BLOCKHASH, lastValidBlockHeight });
      break;
    case "getBlockHeight":
      result = blockHeight;
      break;
    case "getSlot":
      result = slot;
      break;
    case "getEpochInfo":
      result = {
        absoluteSlot: slot,
        blockHeight,
        epoch,
        slotIndex: slot % SLOTS_PER_EPOCH,
        slotsInEpoch: SLOTS_PER_EPOCH,
      };
      break;
    case "getMinimumBalanceForRentExemption":
      result = rentExempt(params[0] as number);
      break;
    case "getRecentPrioritizationFees":
      result = MOCK_PRIORITY_FEES.map((prioritizationFee, i) => ({
        slot: slot - MOCK_PRIORITY_FEES.length + 1 + i,
        prioritizationFee,
      }));
      break;
    case "simulateTransaction": {
      const watched = (params[1] as { accounts?: { addresses: string[] } }).accounts;
      const states = watched
        ? options.postStates
          ? options.postStates(watched.addresses, chain)
          : watched.addresses.map((a) => get(a) ?? null)
        : null;
      result = ctx({
        err: null,
        logs: [],
        accounts: states ? states.map((state) => accountJson(state ?? undefined)) : null,
        unitsConsumed: MOCK_UNITS_CONSUMED,
        returnData: null,
      });
      break;
    }
    case "sendTransaction": {
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0] as string, "base64"));
      result = bs58.encode(tx.signatures[0]);
      break;
    }
    case "getSignatureStatuses":
      result = ctx(
        (params[0] as string[]).map(() => ({
          slot,
          confirmations: null,
          err: null,
          confirmationStatus: "confirmed",
        })),
      );
      break;
  }
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

/** A web3.js Connection whose every request is answered by answerRpc. */
export function mockConnection(chain: SyntheticChain, options: AnswerOptions = {}): Connection {
  const fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    const answer = answerRpc(chain, JSON.parse(String(init?.body)), options);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return new Connection("http://127.0.0.1:8899/mock-action-rpc", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch,
  });
}

export type MockActionRpcOverrides = Partial<Omit<ActionRpc, "connection">> & AnswerOptions;

/**
 * The real ActionRpc (lib/actions/rpc.ts) over mockConnection, with any
 * method replaceable. `postStates` sets what simulations report for watched
 * accounts. `sent` records the bytes of every send attempt, overridden or not.
 */
export function mockActionRpc(
  chain: SyntheticChain,
  overrides: MockActionRpcOverrides = {},
): ActionRpc & { sent: Uint8Array[] } {
  const { postStates, ...methods } = overrides;
  const base = actionRpcFor(mockConnection(chain, { postStates }));
  const sent: Uint8Array[] = [];
  return {
    ...base,
    ...methods,
    async send(raw) {
      sent.push(Uint8Array.from(raw));
      return (overrides.send ?? base.send)(raw);
    },
    sent,
  };
}
