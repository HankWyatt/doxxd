// @vitest-environment node
// web3.js derives program addresses with Node's crypto; jsdom's realm breaks
// that, so this suite runs in the node environment.
import { CpmmPoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  chainFixture,
  PROGRAM_IDS,
  SYNTHETIC,
  tokenAccountData,
  type SyntheticChain,
} from "@/tests/fixtures/actions-chain";
import { MOCK_BLOCKHASH, mockActionRpc } from "@/tests/fixtures/mock-action-rpc";
import type { FungibleTarget } from "../types";
import {
  AmountTooSmallError,
  buildClaimGroups,
  buildWithdrawGroups,
  NothingToWithdrawError,
  packGroups,
  PositionGoneError,
  quoteWithdraw,
  verifyMessage,
  type Expectation,
  type InstructionGroup,
} from "./index";

const pk = (address: string) => new PublicKey(address);
const P = SYNTHETIC.cpmm;
const T = P.transferFee;
const CPMM = PROGRAM_IDS.cpmm;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const WITHDRAW = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]);
const MISMATCH = "Position data doesn't match the pool";
const rent = (size: number) => (size + 128) * 6_960;

type Which = "main" | "transferFee";

function target(chain: SyntheticChain, which: Which = "main"): FungibleTarget & { pool: string } {
  const f = which === "main" ? chain.cpmm : chain.cpmm.transferFee;
  // DMND's snapshot: deliberately stale numbers, so tests prove the builders
  // read live state instead.
  return {
    protocol: "raydium-cpmm",
    id: `cpmm-${which}`,
    pool: f.pool,
    lpMint: f.lpMint,
    lpAccount: f.lpAccount,
    lpAtoms: "1",
    lpDecimals: 9,
    withdrawalAvailable: true,
    legs: [
      { mint: chain.mints.wsol, decimals: 9, symbol: "SOL" },
      { mint: chain.mints.synb, decimals: 6, symbol: "SYNB" },
    ],
    snapshotSlot: 1,
  };
}

const poolOf = (chain: SyntheticChain, address: string) => CpmmPoolInfoLayout.decode(chain.accounts.get(address)!.data);

function patchPool(chain: SyntheticChain, address: string, mutate: (state: Record<string, any>) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const info = chain.accounts.get(address)!;
  const data = Buffer.from(info.data);
  const state = CpmmPoolInfoLayout.decode(data);
  mutate(state as unknown as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
  CpmmPoolInfoLayout.encode(state, data);
  info.data.subarray(0, 8).copy(data, 0); // the layout skips the discriminator
  chain.accounts.set(address, { ...info, data });
}

/** Replaces the owner's LP balance in `account`. */
function setLp(chain: SyntheticChain, account: string, mint: string, amount: BN, holder = chain.owner.publicKey) {
  const info = chain.accounts.get(account)!;
  chain.accounts.set(account, { ...info, data: tokenAccountData({ mint: pk(mint), owner: holder, amount }) });
}

const isWithdraw = (ix: TransactionInstruction) =>
  ix.programId.toBase58() === CPMM && ix.data.subarray(0, 8).equals(WITHDRAW);
const isUnwrap = (ix: TransactionInstruction) =>
  ix.programId.toBase58() === PROGRAM_IDS.token && ix.data.length === 1 && ix.data[0] === 9;
const keysOf = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());
const u64 = (data: Buffer, offset: number) => new BN(data.subarray(offset, offset + 8), "le");
const ownerAta = (chain: SyntheticChain, mint: string, program: string) =>
  getAssociatedTokenAddressSync(pk(mint), chain.owner.publicKey, false, pk(program)).toBase58();
const slip = (amount: BN, bps: number) => amount.muln(10_000 - bps).divn(10_000);
/** SYNT's 1% transfer fee (rounded up, capped), taken off `amount`. */
const netOfSyntFee = (amount: BN) =>
  amount.sub(BN.min(amount.muln(SYNTHETIC.transferFeeBps).addn(9_999).divn(10_000), new BN(SYNTHETIC.transferFeeMax)));

function packAndVerify(chain: SyntheticChain, groups: InstructionGroup[], expectation: Expectation) {
  const messages = packGroups(groups, chain.owner.publicKey, MOCK_BLOCKHASH, 10_000);
  return messages.map((m) => verifyMessage(m.message, expectation));
}

describe("quoteWithdraw / buildWithdrawGroups (Raydium CPMM)", () => {
  it("burns 50% of the live LP balance with minimums floor(reserve × lp / supply × (1 − slippage))", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain);
    const pool = poolOf(chain, t.pool);
    const lp = P.ownerLp.divn(2);
    const reserveOf = (mint: PublicKey) => (mint.toBase58() === chain.mints.wsol ? P.reserveWsol : P.reserveSynb);
    const out = [pool.mintA, pool.mintB].map((mint) => reserveOf(mint).mul(lp).div(P.lpSupply));
    // Sanity, independent of the builder: 5% of the pool.
    expect(out[0].toString()).toBe(reserveOf(pool.mintA).divn(20).toString());

    const quote = await quoteWithdraw(rpc, owner, t, 5_000, 100);
    expect(quote.minimums.map((m) => [m.mint, m.atoms])).toEqual([
      [pool.mintA.toBase58(), slip(out[0], 100).toString()],
      [pool.mintB.toBase58(), slip(out[1], 100).toString()],
    ]);
    expect(quote.receive.map((r) => [r.mint, r.atoms])).toEqual([
      [pool.mintA.toBase58(), out[0].toString()],
      [pool.mintB.toBase58(), out[1].toString()],
    ]);
    expect(quote.fees).toEqual([]);
    expect(quote.closes).toBe(false);
    expect(quote.depositRefundLamports).toBeNull();
    expect(quote.withdrawableBps).toBe(10_000);
    expect(quote.vestingBps).toBe(0);
    expect(quote.lockedBps).toBe(0);
    // SYNB's ATA exists and the wSOL ATA is closed again: no rent kept.
    expect(quote.rentLamports).toBe("0");

    const { groups, expectation, closes } = await buildWithdrawGroups(rpc, owner, t, 5_000, 100);
    expect(closes).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0].positionIds).toEqual([t.id]);
    const ixs = groups[0].instructions;
    const withdraw = ixs.find(isWithdraw)!;
    expect(withdraw.data).toHaveLength(32);
    expect(u64(withdraw.data, 8).toString()).toBe(lp.toString());
    expect([u64(withdraw.data, 16).toString(), u64(withdraw.data, 24).toString()]).toEqual(
      quote.minimums.map((m) => m.atoms),
    );
    expect(keysOf(withdraw)).toEqual([
      owner,
      chain.cpmm.authority,
      t.pool,
      t.lpAccount,
      ownerAta(chain, pool.mintA.toBase58(), PROGRAM_IDS.token),
      ownerAta(chain, pool.mintB.toBase58(), PROGRAM_IDS.token),
      pool.vaultA.toBase58(),
      pool.vaultB.toBase58(),
      PROGRAM_IDS.token,
      PROGRAM_IDS.token2022,
      pool.mintA.toBase58(),
      pool.mintB.toBase58(),
      t.lpMint,
      MEMO,
    ]);
    expect(expectation).toEqual({
      kind: "withdraw",
      owner,
      mints: [
        { mint: pool.mintA.toBase58(), tokenProgram: PROGRAM_IDS.token },
        { mint: pool.mintB.toBase58(), tokenProgram: PROGRAM_IDS.token },
      ],
      positions: [{ position: t.pool, nftAccount: t.lpAccount, protocol: "raydium-cpmm" }],
    });
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("creates the wSOL ATA first and unwraps it after the withdraw", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const { groups } = await buildWithdrawGroups(mockActionRpc(chain), owner, target(chain), 10_000, 100);
    const ixs = groups[0].instructions;
    expect(ixs).toHaveLength(3);
    expect(ixs[0].programId.toBase58()).toBe(ATA_PROGRAM);
    expect(ixs[0].data).toEqual(Buffer.from([1])); // CreateIdempotent
    expect(keysOf(ixs[0])[3]).toBe(chain.mints.wsol);
    expect(isWithdraw(ixs[1])).toBe(true);
    expect(isUnwrap(ixs[2])).toBe(true);
    expect(keysOf(ixs[2])).toEqual([ownerAta(chain, chain.mints.wsol, PROGRAM_IDS.token), owner, owner]);
    // 100% burns the whole live balance (not DMND's stale lpAtoms).
    expect(u64(ixs[1].data, 8).toString()).toBe(P.ownerLp.toString());
  });

  it("takes reserves net of protocol, fund and creator fees and minimums net of the Token-2022 transfer fee", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "transferFee");
    const pool = poolOf(chain, t.pool);
    const lp = T.ownerLp.muln(2_500).divn(10_000);
    const isSynt = (mint: PublicKey) => mint.toBase58() === chain.mints.synt;
    const gross = [pool.mintA, pool.mintB].map((mint) => (isSynt(mint) ? T.reserveSynt : T.reserveSyna).mul(lp).div(T.lpSupply));
    const net = [pool.mintA, pool.mintB].map((mint, i) => (isSynt(mint) ? netOfSyntFee(gross[i]) : gross[i]));
    expect(net.some((n, i) => !n.eq(gross[i]))).toBe(true);

    const quote = await quoteWithdraw(rpc, owner, t, 2_500, 200);
    expect(quote.receive.map((r) => r.atoms)).toEqual(net.map(String));
    expect(quote.minimums.map((m) => m.atoms)).toEqual(net.map((n) => slip(n, 200).toString()));

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 2_500, 200);
    const ixs = groups[0].instructions;
    // Both ATAs exist (SYNT's under Token-2022) and neither leg is wSOL.
    expect(ixs).toHaveLength(1);
    const keys = keysOf(ixs[0]);
    const programOf = (mint: PublicKey) => (isSynt(mint) ? PROGRAM_IDS.token2022 : PROGRAM_IDS.token);
    expect(keys[4]).toBe(ownerAta(chain, pool.mintA.toBase58(), programOf(pool.mintA)));
    expect(keys[5]).toBe(ownerAta(chain, pool.mintB.toBase58(), programOf(pool.mintB)));
    expect(expectation.mints).toEqual([
      { mint: pool.mintA.toBase58(), tokenProgram: programOf(pool.mintA) },
      { mint: pool.mintB.toBase58(), tokenProgram: programOf(pool.mintB) },
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("creates only a missing ATA, and counts its rent", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    chain.accounts.delete(ownerAta(chain, chain.mints.synb, PROGRAM_IDS.token));
    const quote = await quoteWithdraw(mockActionRpc(chain), owner, target(chain), 5_000, 100);
    expect(quote.rentLamports).toBe(String(rent(165)));
    const { groups, expectation } = await buildWithdrawGroups(mockActionRpc(chain), owner, target(chain), 5_000, 100);
    const creates = groups[0].instructions.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM);
    expect(creates.map((ix) => keysOf(ix)[3]).sort()).toEqual([chain.mints.synb, chain.mints.wsol].sort());
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it('refuses dust that pays out nothing on a leg as "Amount too small to withdraw"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    setLp(chain, chain.cpmm.lpAccount, chain.cpmm.lpMint, new BN(100));
    await expect(buildWithdrawGroups(mockActionRpc(chain), owner, target(chain), 10_000, 100)).rejects.toBeInstanceOf(
      AmountTooSmallError,
    );
  });

  it("refuses when DMND says withdrawal is unavailable", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = { ...target(chain), withdrawalAvailable: false };
    await expect(buildWithdrawGroups(mockActionRpc(chain), owner, t, 5_000, 100)).rejects.toBeInstanceOf(
      NothingToWithdrawError,
    );
    await expect(quoteWithdraw(mockActionRpc(chain), owner, t, 5_000, 100)).rejects.toBeInstanceOf(
      NothingToWithdrawError,
    );
  });

  it("refuses a pool whose withdrawals are paused", async () => {
    const chain = chainFixture();
    patchPool(chain, chain.cpmm.pool, (s) => {
      s.status = 2; // bit 1: withdraw disabled
    });
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), target(chain), 5_000, 100),
    ).rejects.toThrow("Withdrawals are paused for this pool");
  });

  it('refuses an emptied or deleted LP account with "Position no longer exists"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    setLp(chain, chain.cpmm.lpAccount, chain.cpmm.lpMint, new BN(0));
    await expect(buildWithdrawGroups(mockActionRpc(chain), owner, target(chain), 5_000, 100)).rejects.toBeInstanceOf(
      PositionGoneError,
    );
    chain.accounts.delete(chain.cpmm.lpAccount);
    await expect(quoteWithdraw(mockActionRpc(chain), owner, target(chain), 5_000, 100)).rejects.toBeInstanceOf(
      PositionGoneError,
    );
  });

  it("refuses data that does not match the pool", async () => {
    const owner = chainFixture().owner.publicKey.toBase58();
    const cases: [string, (chain: SyntheticChain, t: FungibleTarget) => FungibleTarget][] = [
      ["a pool owned by another program", (chain, t) => {
        const info = chain.accounts.get(t.pool!)!;
        chain.accounts.set(t.pool!, { ...info, owner: PROGRAM_IDS.clmm });
        return t;
      }],
      ["a pool of another LP mint", (chain, t) => ({ ...t, lpMint: chain.cpmm.transferFee.lpMint })],
      ["an AMM v4 pool named as CPMM", (chain, t) => ({ ...t, pool: chain.ammV4.pool })],
      ["an LP account of another mint", (chain, t) => ({ ...t, lpAccount: chain.cpmm.transferFee.lpAccount })],
      ["an LP account owned by someone else", (chain, t) => {
        setLp(chain, t.lpAccount, t.lpMint, P.ownerLp, pk(chain.cpmm.authority));
        return t;
      }],
      ["a malformed address", (_chain, t) => ({ ...t, lpAccount: "not-a-key" })],
      ["a missing pool", (_chain, t) => ({ ...t, pool: null })],
      ["a vault holding another mint", (chain, t) => {
        const pool = poolOf(chain, t.pool!);
        chain.accounts.set(pool.vaultA.toBase58(), chain.accounts.get(pool.vaultB.toBase58())!);
        return t;
      }],
    ];
    for (const [name, mutate] of cases) {
      const chain = chainFixture();
      const t = mutate(chain, target(chain));
      await expect(buildWithdrawGroups(mockActionRpc(chain), owner, t, 5_000, 100), name).rejects.toThrow(MISMATCH);
    }
  });

  it("rejects out-of-range percentages and slippage", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain);
    await expect(buildWithdrawGroups(rpc, owner, t, 0, 100)).rejects.toThrow(RangeError);
    await expect(buildWithdrawGroups(rpc, owner, t, 10_001, 100)).rejects.toThrow(RangeError);
    await expect(buildWithdrawGroups(rpc, owner, t, 5_000, 501)).rejects.toThrow(RangeError);
  });
});

describe("buildClaimGroups (Raydium CPMM)", () => {
  it("throws: CPMM fees are inside the LP tokens", async () => {
    const chain = chainFixture();
    await expect(
      buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [target(chain)]),
    ).rejects.toThrow("claim not supported");
  });
});
