// @vitest-environment node
// web3.js and spl-token need Node's crypto and Buffer; jsdom's realm breaks
// that, so this suite runs in the node environment.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainFixture, SYNTHETIC, tokenAccountData, type ChainAccount, type SyntheticChain } from "@/tests/fixtures/actions-chain";
import { mockActionRpc, postStatesFrom, type MockActionRpcOverrides } from "@/tests/fixtures/mock-action-rpc";
import type { InstructionGroup } from "./pack";
import { recordPending } from "./pending";
import { MEMO_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "./programs";
import { RpcBusyError } from "./rpc";
import { runAction, type ActionStep, type RunOptions } from "./run";
import type { Expectation } from "./verify";
import type { ConnectedWallet } from "./wallet-session";

vi.mock("./pending", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pending")>()),
  recordPending: vi.fn(() => true),
}));

const pk = (address: string) => new PublicKey(address);
const OTHER_WALLET = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

type Ctx = {
  chain: SyntheticChain;
  owner: PublicKey;
  expectation: Expectation;
  programOf: (mint: string) => string;
  ata: (mint: string) => PublicKey;
};

function setup(): Ctx {
  const chain = chainFixture();
  const owner = chain.owner.publicKey;
  const programOf = (mint: string) => (mint === chain.mints.synt ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
  const { syna, synb, synt, sync, reward, wsol } = chain.mints;
  return {
    chain,
    owner,
    programOf,
    ata: (mint) => getAssociatedTokenAddressSync(pk(mint), owner, false, pk(programOf(mint))),
    expectation: {
      kind: "claim",
      owner: owner.toBase58(),
      mints: [syna, synb, synt, sync, reward, wsol].map((mint) => ({ mint, tokenProgram: programOf(mint) })),
      positions: [],
    },
  };
}

// One group per transaction: the owner's ATA of `mint` (so the simulation
// watches it) and a memo big enough that two groups never share a message.
function group(ctx: Ctx, n: number, mint = ctx.chain.mints.syna): InstructionGroup {
  return {
    positionIds: [`position-${n}`],
    label: `Claim ${n}`,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(ctx.owner, ctx.ata(mint), ctx.owner, pk(mint), pk(ctx.programOf(mint))),
      new TransactionInstruction({ programId: pk(MEMO_PROGRAM), keys: [], data: Buffer.from(`group ${n} `.padEnd(640, ".")) }),
    ],
  };
}
const groups = (ctx: Ctx, count: number) => Array.from({ length: count }, (_, n) => group(ctx, n + 1));

const groupOf = (tx: VersionedTransaction): number => {
  const memo = tx.message.compiledInstructions.find(
    (ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === MEMO_PROGRAM,
  );
  return Number(/^group (\d+)/.exec(Buffer.from(memo!.data).toString())![1]);
};

// The owner's ATA of `mint` after a simulated claim of `atoms` more.
function credited(ctx: Ctx, mint: string, atoms: number): Record<string, ChainAccount> {
  const address = ctx.ata(mint).toBase58();
  const now = ctx.chain.accounts.get(address)!;
  const amount = new BN(now.data.readBigUInt64LE(64).toString()).addn(atoms);
  const data = Buffer.from(now.data);
  tokenAccountData({ mint: pk(mint), owner: ctx.owner, amount }).copy(data, 0, 0, 165);
  return { [address]: { ...now, data } };
}

type FakeWallet = ConnectedWallet & { calls: Uint8Array[][] };
function fakeWallet(ctx: Ctx, sign?: (tx: VersionedTransaction) => VersionedTransaction): FakeWallet {
  const calls: Uint8Array[][] = [];
  return {
    address: ctx.owner.toBase58(),
    walletName: "Synthetic Wallet",
    walletIcon: null,
    supportsBatch: true,
    calls,
    async signTransactions(txs) {
      calls.push(txs.map((t) => Uint8Array.from(t)));
      return txs.map((raw) => {
        const tx = (sign ?? ((t) => t))(VersionedTransaction.deserialize(raw));
        tx.sign([ctx.chain.owner]);
        return tx.serialize();
      });
    },
    async disconnect() {},
  };
}

// A clock whose sleeps pass instantly and move time forward.
function fakeClock() {
  let t = 1_800_000_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

type Run = { steps: ActionStep[]; updates: ActionStep[][]; wallet: FakeWallet; rpc: ReturnType<typeof mockActionRpc> };
async function run(
  ctx: Ctx,
  opts: {
    groups: InstructionGroup[];
    rpc?: MockActionRpcOverrides;
    wallet?: FakeWallet;
    expectation?: Expectation;
  } & Partial<Pick<RunOptions, "intent" | "shouldStop" | "currentAddress" | "onUpdate">>,
): Promise<Run> {
  const rpc = mockActionRpc(ctx.chain, opts.rpc);
  const wallet = opts.wallet ?? fakeWallet(ctx);
  const updates: ActionStep[][] = [];
  const clock = fakeClock();
  const expectation = opts.expectation ?? ctx.expectation;
  const steps = await runAction({
    groups: opts.groups,
    expectation,
    intent: opts.intent ?? expectation.kind,
    wallet,
    currentAddress: opts.currentAddress ?? (() => wallet.address),
    rpc,
    onUpdate: (s) => {
      updates.push(s);
      opts.onUpdate?.(s);
    },
    shouldStop: opts.shouldStop ?? (() => false),
    sleep: clock.sleep,
    now: clock.now,
  });
  return { steps, updates, wallet, rpc };
}

const claimed = (ctx: Ctx, atoms = 1_000_000) => ({ postStates: postStatesFrom(credited(ctx, ctx.chain.mints.syna, atoms)) });
const statuses = (steps: ActionStep[]) => steps.map((s) => s.status);
const signatureOf = (raw: Uint8Array) => bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
const blockhashOf = (raw: Uint8Array) => VersionedTransaction.deserialize(raw).message.recentBlockhash;
const { lastValidBlockHeight: LAST_VALID, blockHeight: HEIGHT } = SYNTHETIC.clock;
// Block-height reads before a chunk's first send: one just before the wallet
// prompt opens, one after it returns.
const READS_BEFORE_SEND = 2;
const expiredRefusal = () =>
  new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed: Blockhash not found" });

beforeEach(() => {
  vi.mocked(recordPending).mockClear();
});

describe("runAction", () => {
  it("signs 3 messages in one call, confirms them and records them as pending", async () => {
    const ctx = setup();
    const { steps, wallet, rpc, updates } = await run(ctx, { groups: groups(ctx, 3), rpc: claimed(ctx) });
    expect(wallet.calls.map((c) => c.length)).toEqual([3]);
    expect(statuses(steps)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.positionIds)).toEqual([["position-1"], ["position-2"], ["position-3"]]);
    for (const step of steps) {
      expect(step.slot).toBe(SYNTHETIC.clock.slot);
      expect(step.expected).toEqual([{ mint: ctx.chain.mints.syna, atoms: "1000000" }]);
    }
    expect(rpc.sent.map(signatureOf)).toEqual(steps.map((s) => s.signature));
    expect(vi.mocked(recordPending).mock.calls.map(([a]) => a)).toEqual(
      steps.map((s) => ({
        wallet: ctx.owner.toBase58(),
        positionId: s.positionIds[0],
        kind: "claim",
        signature: s.signature,
        slot: SYNTHETIC.clock.slot,
        at: expect.any(Number),
      })),
    );
    // Progress is reported along the way, ending in the returned state.
    expect(updates.length).toBeGreaterThan(3);
    expect(updates.at(-1)).toEqual(steps);
    expect(updates.some((u) => u.some((s) => s.status === "awaiting-approval"))).toBe(true);
    expect(updates.some((u) => u.some((s) => s.status === "sending"))).toBe(true);
  });

  it("lowers the compute-unit limit to the simulated use plus headroom before signing", async () => {
    const ctx = setup();
    const { wallet } = await run(ctx, { groups: groups(ctx, 1), rpc: claimed(ctx) });
    const message = VersionedTransaction.deserialize(wallet.calls[0][0]).message;
    const [limit] = TransactionMessage.decompile(message).instructions;
    // ceil(60,000 × 1.2) + 10,000
    expect(limit.data.readUInt32LE(1)).toBe(82_000);
  });

  it("uses the p75 priority fee with the 10,000 µlamport floor", async () => {
    const ctx = setup();
    const price = async (fees: number[]) => {
      const { wallet } = await run(ctx, { groups: groups(ctx, 1), rpc: { ...claimed(ctx), priorityFees: async () => fees } });
      const [, ix] = TransactionMessage.decompile(VersionedTransaction.deserialize(wallet.calls[0][0]).message).instructions;
      return Number(ix.data.readBigUInt64LE(1));
    };
    expect(await price([1_000, 2_000, 3_000, 4_000])).toBe(10_000);
    expect(await price([10_000, 20_000, 30_000, 40_000])).toBe(30_000);
    expect(await price([900_000, 900_000])).toBe(200_000);
    expect(await price([])).toBe(10_000);
  });

  it("fails a step whose simulation fails and never asks the wallet to sign it", async () => {
    const ctx = setup();
    const rpc = mockActionRpc(ctx.chain, claimed(ctx));
    const simulate = rpc.simulate;
    const { steps, wallet } = await run(ctx, {
      groups: groups(ctx, 3),
      rpc: {
        ...claimed(ctx),
        simulate: async (tx, watch) =>
          groupOf(tx) === 2
            ? { err: { InstructionError: [1, { Custom: 6000 }] }, logs: [], unitsConsumed: 1_000, accounts: [] }
            : simulate(tx, watch),
      },
    });
    expect(statuses(steps)).toEqual(["confirmed", "failed", "confirmed"]);
    expect(steps[1].reason).toBe("Simulation failed · not sent");
    expect(wallet.calls).toHaveLength(1);
    expect(wallet.calls[0].map((raw) => groupOf(VersionedTransaction.deserialize(raw)))).toEqual([1, 3]);
  });

  it("fails a message that fails the pre-sign check and never shows it to the wallet", async () => {
    const ctx = setup();
    const bad = group(ctx, 2);
    bad.instructions.push(SystemProgram.transfer({ fromPubkey: ctx.owner, toPubkey: pk(OTHER_WALLET), lamports: 1 }));
    const { steps, wallet } = await run(ctx, { groups: [group(ctx, 1), bad], rpc: claimed(ctx) });
    expect(statuses(steps)).toEqual(["confirmed", "failed"]);
    expect(steps[1].reason).toMatch(/^Blocked by the safety check: .+ · not sent$/);
    expect(wallet.calls.map((c) => c.length)).toEqual([1]);
  });

  it("never sends a transaction the wallet changed while signing (Review Focus 1)", async () => {
    const ctx = setup();
    const tamper = fakeWallet(ctx, (tx) => {
      const message = TransactionMessage.decompile(tx.message);
      message.instructions.push(SystemProgram.transfer({ fromPubkey: ctx.owner, toPubkey: pk(OTHER_WALLET), lamports: 5_000 }));
      return new VersionedTransaction(message.compileToV0Message());
    });
    const { steps, rpc } = await run(ctx, { groups: groups(ctx, 2), rpc: claimed(ctx), wallet: tamper });
    expect(statuses(steps)).toEqual(["failed", "failed"]);
    expect(steps.map((s) => s.reason)).toEqual([
      "Your wallet changed the transaction · not sent",
      "Your wallet changed the transaction · not sent",
    ]);
    expect(rpc.sent).toHaveLength(0);
    expect(recordPending).not.toHaveBeenCalled();
  });

  it("never sends a signed message that differs from the one checked, even if it would pass", async () => {
    const ctx = setup();
    const reblockhash = fakeWallet(ctx, (tx) => {
      const message = TransactionMessage.decompile(tx.message);
      message.recentBlockhash = bs58.encode(new Uint8Array(32).fill(6));
      return new VersionedTransaction(message.compileToV0Message());
    });
    const { steps, rpc } = await run(ctx, { groups: groups(ctx, 1), rpc: claimed(ctx), wallet: reblockhash });
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Your wallet changed the transaction · not sent" });
    expect(rpc.sent).toHaveLength(0);
  });

  it("reports an expired blockhash as \"Didn't land · nothing changed\" (Review Focus 2)", async () => {
    const ctx = setup();
    let heights = 0;
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 2),
      rpc: {
        ...claimed(ctx),
        statuses: async (sigs) => sigs.map(() => null),
        // Still valid when the prompt returns; expired while confirming.
        blockHeight: async () => (heights++ < READS_BEFORE_SEND ? HEIGHT : LAST_VALID + 1),
      },
    });
    expect(statuses(steps)).toEqual(["failed", "failed"]);
    expect(steps.map((s) => s.reason)).toEqual(["Didn't land · nothing changed", "Didn't land · nothing changed"]);
    // Sent once each, never rebuilt or re-signed.
    expect(rpc.sent).toHaveLength(2);
    expect(recordPending).not.toHaveBeenCalled();
  });

  it("keeps polling until the blockhash expires, then gives up", async () => {
    const ctx = setup();
    let height = SYNTHETIC.clock.blockHeight;
    const { steps } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: { ...claimed(ctx), statuses: async (sigs) => sigs.map(() => null), blockHeight: async () => (height += 50) },
    });
    expect(height).toBeGreaterThan(SYNTHETIC.clock.lastValidBlockHeight);
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Didn't land · nothing changed" });
  });

  it("does not claim \"nothing changed\" when it stops polling before the blockhash expires", async () => {
    const ctx = setup();
    const { steps } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: { ...claimed(ctx), statuses: async (sigs) => sigs.map(() => null) },
    });
    expect(steps[0].status).toBe("failed");
    expect(steps[0].reason).not.toMatch(/nothing changed/);
  });

  it("marks a transaction that landed with an error as failed", async () => {
    const ctx = setup();
    const { steps } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        statuses: async (sigs) => sigs.map(() => ({ slot: 1_001, confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 1 }] } })),
      },
    });
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Failed on chain · nothing changed" });
    expect(recordPending).not.toHaveBeenCalled();
  });

  it("re-sends the identical signed bytes after a 429 on send (Review Focus 5)", async () => {
    const ctx = setup();
    let attempts = 0;
    const base = mockActionRpc(ctx.chain);
    const { steps, rpc, wallet } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        send: async (raw) => {
          if (attempts++ === 0) throw new RpcBusyError({ cause: new Error("HTTP 429") });
          return base.send(raw);
        },
      },
    });
    expect(wallet.calls).toHaveLength(1);
    expect(rpc.sent).toHaveLength(2);
    expect(Buffer.from(rpc.sent[1]).equals(Buffer.from(rpc.sent[0]))).toBe(true);
    expect(steps[0]).toMatchObject({ status: "confirmed", signature: signatureOf(rpc.sent[0]) });
  });

  it("fails a send the network rejects outright, without re-sending", async () => {
    const ctx = setup();
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        send: async () => {
          throw new SendTransactionError({
            action: "send",
            signature: "",
            transactionMessage: "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1771",
          });
        },
      },
    });
    expect(rpc.sent).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Rejected by the network · not sent" });
  });

  it("still polls after a send error that leaves it unclear whether the transaction went out", async () => {
    const ctx = setup();
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        send: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      },
    });
    expect(rpc.sent).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "confirmed", slot: SYNTHETIC.clock.slot });
    expect(recordPending).toHaveBeenCalledTimes(1);
  });

  it("treats \"already processed\" on a re-send as sent", async () => {
    const ctx = setup();
    let attempts = 0;
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        send: async () => {
          if (attempts++ === 0) throw new RpcBusyError();
          throw new SendTransactionError({
            action: "send",
            signature: "",
            transactionMessage: "Transaction simulation failed: This transaction has already been processed",
          });
        },
      },
    });
    expect(rpc.sent).toHaveLength(2);
    expect(steps[0].status).toBe("confirmed");
  });

  it("stops the remaining chunks when shouldStop turns true after the first", async () => {
    const ctx = setup();
    let sent = 0;
    const base = mockActionRpc(ctx.chain);
    const { steps, wallet } = await run(ctx, {
      groups: groups(ctx, 12),
      rpc: { ...claimed(ctx), send: async (raw) => (sent++, base.send(raw)) },
      shouldStop: () => sent >= 10,
    });
    expect(wallet.calls.map((c) => c.length)).toEqual([10]);
    expect(statuses(steps)).toEqual([...Array(10).fill("confirmed"), "stopped", "stopped"]);
  });

  it("stops the signed but unsent rest of a chunk when asked, still confirming what was sent", async () => {
    const ctx = setup();
    let sent = 0;
    const base = mockActionRpc(ctx.chain);
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 3),
      rpc: { ...claimed(ctx), send: async (raw) => (sent++, base.send(raw)) },
      shouldStop: () => sent >= 1,
    });
    expect(rpc.sent).toHaveLength(1);
    expect(statuses(steps)).toEqual(["confirmed", "stopped", "stopped"]);
  });

  it("stops the chunk with \"You declined in your wallet\" when the wallet rejects, and ends the run", async () => {
    const ctx = setup();
    const wallet = fakeWallet(ctx);
    wallet.signTransactions = async (txs) => {
      wallet.calls.push(txs);
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    };
    const { steps, rpc } = await run(ctx, { groups: groups(ctx, 12), rpc: claimed(ctx), wallet });
    expect(wallet.calls).toHaveLength(1);
    expect(statuses(steps)).toEqual(Array(12).fill("stopped"));
    expect(steps.slice(0, 10).every((s) => s.reason === "You declined in your wallet")).toBe(true);
    expect(rpc.sent).toHaveLength(0);
  });

  it("stops with \"Wallet changed · stopped\" when the account changes before signing (Review Focus 3)", async () => {
    const ctx = setup();
    let address = ctx.owner.toBase58();
    const wallet = fakeWallet(ctx);
    const sign = wallet.signTransactions;
    wallet.signTransactions = async (txs) => {
      const signed = await sign(txs);
      address = OTHER_WALLET; // the visitor switches account in the wallet
      return signed;
    };
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 12),
      rpc: claimed(ctx),
      wallet,
      currentAddress: () => address,
    });
    expect(wallet.calls).toHaveLength(1);
    expect(rpc.sent).toHaveLength(0);
    expect(statuses(steps)).toEqual(Array(12).fill("stopped"));
    expect(steps.every((s) => s.reason === "Wallet changed · stopped")).toBe(true);
  });

  it("does not open the wallet at all when the account already differs", async () => {
    const ctx = setup();
    const { steps, wallet, rpc } = await run(ctx, {
      groups: groups(ctx, 2),
      rpc: claimed(ctx),
      currentAddress: () => OTHER_WALLET,
    });
    expect(wallet.calls).toHaveLength(0);
    expect(rpc.sent).toHaveLength(0);
    expect(steps.map((s) => [s.status, s.reason])).toEqual([
      ["stopped", "Wallet changed · stopped"],
      ["stopped", "Wallet changed · stopped"],
    ]);
  });

  it("refuses to run when the expectation is not what the visitor clicked", async () => {
    const ctx = setup();
    const { steps, wallet, rpc } = await run(ctx, { groups: groups(ctx, 2), rpc: claimed(ctx), intent: "withdraw" });
    expect(wallet.calls).toHaveLength(0);
    expect(rpc.sent).toHaveLength(0);
    expect(statuses(steps)).toEqual(["failed", "failed"]);
    expect(steps[0].reason).toBe("Doesn't match the action you chose · not sent");
  });

  it("signs 25 messages in 3 wallet prompts of 10, 10 and 5", async () => {
    const ctx = setup();
    const { steps, wallet } = await run(ctx, { groups: groups(ctx, 25), rpc: claimed(ctx) });
    expect(wallet.calls.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(steps.every((s) => s.status === "confirmed")).toBe(true);
    expect(vi.mocked(recordPending)).toHaveBeenCalledTimes(25);
  });

  it("skips a claim whose simulated deltas are all zero with \"Nothing to claim\" and never signs it", async () => {
    const ctx = setup();
    const { synb } = ctx.chain.mints;
    const { steps, wallet } = await run(ctx, {
      groups: [group(ctx, 1), group(ctx, 2, synb)],
      // Only the SYNB ATA (group 2) gains; group 1's watched accounts don't change.
      rpc: { postStates: postStatesFrom(credited(ctx, synb, 5_000)) },
    });
    expect(steps.map((s) => [s.status, s.reason])).toEqual([
      ["skipped", "Nothing to claim"],
      ["confirmed", undefined],
    ]);
    expect(steps[1].expected).toEqual([{ mint: synb, atoms: "5000" }]);
    expect(wallet.calls.map((c) => c.map((raw) => groupOf(VersionedTransaction.deserialize(raw))))).toEqual([[2]]);
  });

  it("does not open the wallet when every claim is empty", async () => {
    const ctx = setup();
    const { steps, wallet } = await run(ctx, { groups: groups(ctx, 2) });
    expect(statuses(steps)).toEqual(["skipped", "skipped"]);
    expect(wallet.calls).toHaveLength(0);
  });

  it("reports SOL received through an unwrapped wSOL account, in lamports under the wSOL mint", async () => {
    const ctx = setup();
    const owner = ctx.owner.toBase58();
    const now = ctx.chain.accounts.get(owner)!;
    // The wSOL ATA is created and closed in the transaction (absent before
    // and after); the owner ends up 3,000,000 lamports richer.
    const { steps } = await run(ctx, {
      groups: [group(ctx, 1, WSOL_MINT)],
      rpc: { postStates: postStatesFrom({ [owner]: { ...now, lamports: now.lamports + 3_000_000 } }) },
    });
    expect(steps[0]).toMatchObject({ status: "confirmed", expected: [{ mint: WSOL_MINT, atoms: "3000000" }] });
  });

  it("fails every step with \"Network busy · try again\" when the blockhash can't be read", async () => {
    const ctx = setup();
    const { steps, wallet } = await run(ctx, {
      groups: groups(ctx, 2),
      rpc: {
        latestBlockhash: async () => {
          throw new RpcBusyError();
        },
      },
    });
    expect(wallet.calls).toHaveLength(0);
    expect(steps.map((s) => [s.status, s.reason])).toEqual([
      ["failed", "Network busy · try again"],
      ["failed", "Network busy · try again"],
    ]);
  });

  it("reports a preflight \"Blockhash not found\" refusal as \"Didn't land · nothing changed\" (R-001)", async () => {
    const ctx = setup();
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        send: async () => {
          throw expiredRefusal();
        },
      },
    });
    expect(rpc.sent).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Didn't land · nothing changed" });
  });

  it("reports any refusal once the blockhash has expired as \"Didn't land · nothing changed\" (R-001)", async () => {
    const ctx = setup();
    let heights = 0;
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        // Valid until the prompt returns, expired by the time the send is refused.
        blockHeight: async () => (heights++ < READS_BEFORE_SEND ? HEIGHT : LAST_VALID + 1),
        send: async () => {
          throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed" });
        },
      },
    });
    expect(rpc.sent).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Didn't land · nothing changed" });
  });

  it("prepares each prompt with its own fresh blockhash and priority fee (R-T7d)", async () => {
    const ctx = setup();
    let blockhashes = 0;
    const feeReads: string[][] = [];
    const { steps, wallet } = await run(ctx, {
      groups: groups(ctx, 25),
      rpc: {
        ...claimed(ctx),
        latestBlockhash: async () => ({
          blockhash: bs58.encode(new Uint8Array(32).fill(20 + ++blockhashes)),
          lastValidBlockHeight: LAST_VALID,
        }),
        priorityFees: async (writable) => (feeReads.push(writable), [50_000]),
      },
    });
    expect(wallet.calls.map((c) => c.length)).toEqual([10, 10, 5]);
    const perPrompt = wallet.calls.map((c) => [...new Set(c.map(blockhashOf))]);
    expect(perPrompt.map((hashes) => hashes.length)).toEqual([1, 1, 1]);
    expect(new Set(perPrompt.flat()).size).toBe(3);
    expect(blockhashes).toBe(3);
    expect(feeReads).toHaveLength(3);
    expect(steps.every((s) => s.status === "confirmed")).toBe(true);
  });

  it("fails a prompt whose blockhash expired while the wallet was open, then prepares the next one afresh (R-T7d)", async () => {
    const ctx = setup();
    let height = HEIGHT;
    const wallet = fakeWallet(ctx);
    const sign = wallet.signTransactions;
    wallet.signTransactions = async (txs) => {
      const signed = await sign(txs);
      if (wallet.calls.length === 1) height += 1_000; // the visitor left the first prompt open
      return signed;
    };
    const { steps, rpc } = await run(ctx, {
      groups: groups(ctx, 12),
      wallet,
      rpc: {
        ...claimed(ctx),
        blockHeight: async () => height,
        latestBlockhash: async () => ({
          blockhash: bs58.encode(new Uint8Array(32).fill(height % 200)),
          lastValidBlockHeight: height + 150,
        }),
      },
    });
    expect(wallet.calls.map((c) => c.length)).toEqual([10, 2]);
    expect(rpc.sent).toHaveLength(2);
    expect(steps.slice(0, 10).every((s) => s.status === "failed" && s.reason === "Didn't land · nothing changed")).toBe(true);
    expect(statuses(steps.slice(10))).toEqual(["confirmed", "confirmed"]);
  });

  it("re-prepares a prompt whose blockhash died during preparation, never showing the stale messages", async () => {
    const ctx = setup();
    let height = HEIGHT;
    let reads = 0;
    const hashOf = (n: number) => bs58.encode(new Uint8Array(32).fill(40 + n));
    const base = mockActionRpc(ctx.chain, claimed(ctx));
    const { steps, wallet } = await run(ctx, {
      groups: groups(ctx, 2),
      rpc: {
        ...claimed(ctx),
        blockHeight: async () => height,
        latestBlockhash: async () => ({ blockhash: hashOf(++reads), lastValidBlockHeight: height + 150 }),
        // A slow RPC: the first preparation outlives its blockhash.
        simulate: async (tx, watch) => {
          if (reads === 1) height += 100;
          return base.simulate(tx, watch);
        },
      },
    });
    expect(reads).toBe(2);
    expect(wallet.calls.map((c) => c.length)).toEqual([2]);
    expect(wallet.calls[0].map(blockhashOf)).toEqual([hashOf(2), hashOf(2)]);
    expect(statuses(steps)).toEqual(["confirmed", "confirmed"]);
  });

  it("does not prompt at all when the blockhash dies during preparation twice", async () => {
    const ctx = setup();
    let height = HEIGHT;
    const base = mockActionRpc(ctx.chain, claimed(ctx));
    const { steps, wallet, rpc } = await run(ctx, {
      groups: groups(ctx, 2),
      rpc: {
        ...claimed(ctx),
        blockHeight: async () => height,
        latestBlockhash: async () => ({ blockhash: bs58.encode(new Uint8Array(32).fill(height % 200)), lastValidBlockHeight: height + 150 }),
        simulate: async (tx, watch) => {
          height += 100;
          return base.simulate(tx, watch);
        },
      },
    });
    expect(wallet.calls).toHaveLength(0);
    expect(rpc.sent).toHaveLength(0);
    expect(steps.map((s) => [s.status, s.reason])).toEqual([
      ["failed", "Didn't land · nothing changed"],
      ["failed", "Didn't land · nothing changed"],
    ]);
  });

  it("treats a blockhash within 10 blocks of its end as dead before prompting", async () => {
    const ctx = setup();
    let reads = 0;
    const { wallet } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        // The first blockhash has 10 blocks left; the second has 150.
        latestBlockhash: async () => ({
          blockhash: bs58.encode(new Uint8Array(32).fill(50 + ++reads)),
          lastValidBlockHeight: HEIGHT + (reads === 1 ? 10 : 150),
        }),
      },
    });
    expect(reads).toBe(2);
    expect(wallet.calls[0].map(blockhashOf)).toEqual([bs58.encode(new Uint8Array(32).fill(52))]);
  });

  it("waits one more round after expiry before saying it didn't land (R-T7e)", async () => {
    const ctx = setup();
    let heights = 0;
    let rounds = 0;
    const { steps } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        blockHeight: async () => (heights++ < READS_BEFORE_SEND ? HEIGHT : LAST_VALID + 1),
        // A lagging node misses the status once; the next round finds it.
        statuses: async (sigs) =>
          rounds++ === 0 ? sigs.map(() => null) : sigs.map(() => ({ slot: 1_001, confirmationStatus: "confirmed", err: null })),
      },
    });
    expect(steps[0]).toMatchObject({ status: "confirmed", slot: 1_001 });
  });

  it("needs two status-less rounds after expiry to report \"Didn't land\" (R-T7e)", async () => {
    const ctx = setup();
    let heights = 0;
    let rounds = 0;
    const { steps } = await run(ctx, {
      groups: groups(ctx, 1),
      rpc: {
        ...claimed(ctx),
        blockHeight: async () => (heights++ < READS_BEFORE_SEND ? HEIGHT : LAST_VALID + 1),
        statuses: async (sigs) => (rounds++, sigs.map(() => null)),
      },
    });
    expect(rounds).toBe(2);
    expect(steps[0]).toMatchObject({ status: "failed", reason: "Didn't land · nothing changed" });
  });

  it("records a confirmed step as pending before reporting it (R-T7e)", async () => {
    const ctx = setup();
    const seen: number[][] = [];
    await run(ctx, {
      groups: groups(ctx, 2),
      rpc: claimed(ctx),
      onUpdate: (s) => seen.push([s.filter((step) => step.status === "confirmed").length, vi.mocked(recordPending).mock.calls.length]),
    });
    expect(seen.at(-1)).toEqual([2, 2]);
    for (const [confirmedSteps, records] of seen) expect(records).toBeGreaterThanOrEqual(confirmedSteps);
  });

  it("records pending results even when the progress callback throws (R-T7e)", async () => {
    const ctx = setup();
    const { steps } = await run(ctx, {
      groups: groups(ctx, 2),
      rpc: claimed(ctx),
      onUpdate: () => {
        throw new Error("UI went away");
      },
    });
    expect(statuses(steps)).toEqual(["confirmed", "confirmed"]);
    expect(vi.mocked(recordPending)).toHaveBeenCalledTimes(2);
  });

  it("returns no steps for no groups", async () => {
    const ctx = setup();
    const { steps, wallet } = await run(ctx, { groups: [] });
    expect(steps).toEqual([]);
    expect(wallet.calls).toHaveLength(0);
  });
});
