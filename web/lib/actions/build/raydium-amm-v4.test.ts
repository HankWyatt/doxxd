// @vitest-environment node
// web3.js derives program addresses with Node's crypto; jsdom's realm breaks
// that, so this suite runs in the node environment.
import { liquidityStateV4Layout, MARKET_STATE_LAYOUT_V3 } from "@raydium-io/raydium-sdk-v2";
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
const A = SYNTHETIC.ammV4;
const AMM = PROGRAM_IDS.ammV4;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MISMATCH = "Position data doesn't match the pool";
const rent = (size: number) => (size + 128) * 6_960;

function target(chain: SyntheticChain): FungibleTarget & { pool: string } {
  // DMND's snapshot: deliberately stale numbers.
  return {
    protocol: "raydium-amm-v4",
    id: "amm-v4",
    pool: chain.ammV4.pool,
    lpMint: chain.ammV4.lpMint,
    lpAccount: chain.ammV4.lpAccount,
    lpAtoms: "1",
    lpDecimals: 6,
    withdrawalAvailable: null,
    legs: [
      { mint: chain.mints.sync, decimals: 6, symbol: "SYNC" },
      { mint: chain.mints.wsol, decimals: 9, symbol: "SOL" },
    ],
    snapshotSlot: 1,
  };
}

const ammOf = (chain: SyntheticChain) => liquidityStateV4Layout.decode(chain.accounts.get(chain.ammV4.pool)!.data);
const marketOf = (chain: SyntheticChain) => MARKET_STATE_LAYOUT_V3.decode(chain.accounts.get(chain.ammV4.market)!.data);

function patchAmm(chain: SyntheticChain, mutate: (state: Record<string, any>) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const info = chain.accounts.get(chain.ammV4.pool)!;
  const data = Buffer.from(info.data);
  const state = liquidityStateV4Layout.decode(data);
  mutate(state as unknown as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
  liquidityStateV4Layout.encode(state, data);
  chain.accounts.set(chain.ammV4.pool, { ...info, data });
}

const isWithdraw = (ix: TransactionInstruction) => ix.programId.toBase58() === AMM && ix.data[0] === 4;
const isUnwrap = (ix: TransactionInstruction) =>
  ix.programId.toBase58() === PROGRAM_IDS.token && ix.data.length === 1 && ix.data[0] === 9;
const keysOf = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());
const u64 = (data: Buffer, offset: number) => new BN(data.subarray(offset, offset + 8), "le");
const ownerAta = (chain: SyntheticChain, mint: string) =>
  getAssociatedTokenAddressSync(pk(mint), chain.owner.publicKey, false).toBase58();
const slip = (amount: BN, bps: number) => amount.muln(10_000 - bps).divn(10_000);

function packAndVerify(chain: SyntheticChain, groups: InstructionGroup[], expectation: Expectation) {
  const messages = packGroups(groups, chain.owner.publicKey, MOCK_BLOCKHASH, 10_000);
  return messages.map((m) => verifyMessage(m.message, expectation));
}

describe("quoteWithdraw / buildWithdrawGroups (Raydium AMM v4)", () => {
  it("withdraws 50% with the SDK's 22 accounts, the OpenBook market's included, and passes the pre-sign check", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain);
    const amm = ammOf(chain);
    const market = marketOf(chain);
    const lp = A.ownerLp.divn(2);
    // Vault amounts minus the PnL owed to the protocol (the fixture's vaults
    // hold reserve + PnL), pro rata to lp / lpReserve.
    const base = A.reserveSync.mul(lp).div(A.lpSupply);
    const quote_ = A.reserveWsol.mul(lp).div(A.lpSupply);

    const quote = await quoteWithdraw(rpc, owner, t, 5_000, 100);
    expect(quote.receive.map((r) => [r.mint, r.atoms])).toEqual([
      [chain.mints.sync, base.toString()],
      [chain.mints.wsol, quote_.toString()],
    ]);
    expect(quote.minimums.map((m) => [m.mint, m.atoms])).toEqual([
      [chain.mints.sync, slip(base, 100).toString()],
      [chain.mints.wsol, slip(quote_, 100).toString()],
    ]);
    expect(quote.fees).toEqual([]);
    expect(quote.closes).toBe(false);
    expect(quote.depositRefundLamports).toBeNull();
    expect(quote.withdrawableBps).toBe(10_000);
    expect(quote.vestingBps).toBe(0);
    expect(quote.lockedBps).toBe(0);
    // SYNC's ATA is created and kept; wSOL's is closed again.
    expect(quote.rentLamports).toBe(String(rent(165)));

    const { groups, expectation, closes } = await buildWithdrawGroups(rpc, owner, t, 5_000, 100);
    expect(closes).toBe(false);
    expect(groups).toHaveLength(1);
    const ixs = groups[0].instructions;
    expect(ixs.map((ix) => (isWithdraw(ix) ? "withdraw" : isUnwrap(ix) ? "unwrap" : ix.programId.toBase58()))).toEqual(
      [ATA_PROGRAM, ATA_PROGRAM, "withdraw", "unwrap"],
    );
    expect(ixs.slice(0, 2).map((ix) => keysOf(ix)[3])).toEqual([chain.mints.sync, chain.mints.wsol]);
    const withdraw = ixs[2];
    expect(withdraw.data).toHaveLength(25);
    expect([u64(withdraw.data, 1), u64(withdraw.data, 9), u64(withdraw.data, 17)].map(String)).toEqual([
      lp.toString(),
      ...quote.minimums.map((m) => m.atoms),
    ]);
    expect(keysOf(withdraw)).toEqual([
      PROGRAM_IDS.token,
      t.pool,
      chain.ammV4.authority,
      amm.openOrders.toBase58(),
      amm.targetOrders.toBase58(),
      t.lpMint,
      amm.baseVault.toBase58(),
      amm.quoteVault.toBase58(),
      t.pool,
      t.pool,
      PROGRAM_IDS.openBook,
      chain.ammV4.market,
      market.baseVault.toBase58(),
      market.quoteVault.toBase58(),
      chain.ammV4.marketAuthority,
      t.lpAccount,
      ownerAta(chain, chain.mints.sync),
      ownerAta(chain, chain.mints.wsol),
      owner,
      market.eventQueue.toBase58(),
      market.bids.toBase58(),
      market.asks.toBase58(),
    ]);
    expect(withdraw.keys[18].isSigner).toBe(true);
    expect(expectation).toEqual({
      kind: "withdraw",
      owner,
      mints: [
        { mint: chain.mints.sync, tokenProgram: PROGRAM_IDS.token },
        { mint: chain.mints.wsol, tokenProgram: PROGRAM_IDS.token },
      ],
      positions: [{ position: t.pool, nftAccount: t.lpAccount, protocol: "raydium-amm-v4" }],
    });
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("withdraws from a pool without an OpenBook market with the 11-account form, which passes the pre-sign check", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const f = chain.ammV4.marketless;
    const M = A.marketless;
    const t = { ...target(chain), id: "amm-v4-marketless", pool: f.pool, lpMint: f.lpMint, lpAccount: f.lpAccount };
    const amm = liquidityStateV4Layout.decode(chain.accounts.get(f.pool)!.data);
    expect(amm.marketProgramId.equals(PublicKey.default)).toBe(true);
    expect(chain.accounts.has(f.marketSeed)).toBe(false);
    const lp = M.ownerLp.muln(7_500).divn(10_000);
    const base = M.reserveSyna.mul(lp).div(M.lpSupply);
    const quote_ = M.reserveWsol.mul(lp).div(M.lpSupply);

    const quote = await quoteWithdraw(rpc, owner, t, 7_500, 100);
    expect(quote.minimums.map((m) => [m.mint, m.atoms])).toEqual([
      [chain.mints.syna, slip(base, 100).toString()],
      [chain.mints.wsol, slip(quote_, 100).toString()],
    ]);
    // SYNA's ATA exists and wSOL's is closed again.
    expect(quote.rentLamports).toBe("0");

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 7_500, 100);
    const ixs = groups[0].instructions;
    expect(ixs.map((ix) => (isWithdraw(ix) ? "withdraw" : isUnwrap(ix) ? "unwrap" : ix.programId.toBase58()))).toEqual(
      [ATA_PROGRAM, "withdraw", "unwrap"],
    );
    const withdraw = ixs[1];
    expect(withdraw.data).toHaveLength(25);
    expect([u64(withdraw.data, 1), u64(withdraw.data, 9), u64(withdraw.data, 17)].map(String)).toEqual([
      lp.toString(),
      ...quote.minimums.map((m) => m.atoms),
    ]);
    // raydium-amm processor.rs:1561-1590: token program, amm, authority,
    // target orders, LP mint, coin vault, pc vault, user LP, user coin, user
    // pc, owner.
    expect(keysOf(withdraw)).toEqual([
      PROGRAM_IDS.token,
      f.pool,
      f.authority,
      amm.targetOrders.toBase58(),
      f.lpMint,
      amm.baseVault.toBase58(),
      amm.quoteVault.toBase58(),
      f.lpAccount,
      ownerAta(chain, chain.mints.syna),
      ownerAta(chain, chain.mints.wsol),
      owner,
    ]);
    expect(withdraw.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, false],
      [false, true],
      [false, false],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [true, false],
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("unwraps the wSOL leg after the withdraw, to the wallet", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const { groups } = await buildWithdrawGroups(mockActionRpc(chain), owner, target(chain), 10_000, 50);
    const last = groups[0].instructions.at(-1)!;
    expect(isUnwrap(last)).toBe(true);
    expect(keysOf(last)).toEqual([ownerAta(chain, chain.mints.wsol), owner, owner]);
  });

  it('refuses dust that burns nothing or pays out nothing on a leg as "Amount too small to withdraw"', async () => {
    const owner = chainFixture().owner.publicKey.toBase58();
    // 50% of 1 LP floors to 0 burned.
    const one = chainFixture();
    const info = one.accounts.get(one.ammV4.lpAccount)!;
    one.accounts.set(one.ammV4.lpAccount, {
      ...info,
      data: tokenAccountData({ mint: pk(one.ammV4.lpMint), owner: one.owner.publicKey, amount: new BN(1) }),
    });
    await expect(buildWithdrawGroups(mockActionRpc(one), owner, target(one), 5_000, 100)).rejects.toBeInstanceOf(
      AmountTooSmallError,
    );
    // The PnL owed leaves 1 base atom in the pool, so 1% of the LP gets 0 of it.
    const drained = chainFixture();
    patchAmm(drained, (s) => {
      s.baseNeedTakePnl = A.reserveSync.add(s.baseNeedTakePnl).subn(1);
    });
    await expect(buildWithdrawGroups(mockActionRpc(drained), owner, target(drained), 100, 100)).rejects.toBeInstanceOf(
      AmountTooSmallError,
    );
  });

  it("refuses a pool whose status does not allow withdrawals", async () => {
    const chain = chainFixture();
    patchAmm(chain, (s) => {
      s.status = new BN(2); // Disabled
    });
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), target(chain), 5_000, 100),
    ).rejects.toThrow("Withdrawals are paused for this pool");
  });

  it("refuses when DMND says withdrawal is unavailable", async () => {
    const chain = chainFixture();
    const t = { ...target(chain), withdrawalAvailable: false };
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 5_000, 100),
    ).rejects.toBeInstanceOf(NothingToWithdrawError);
  });

  it('refuses a deleted LP account with "Position no longer exists"', async () => {
    const chain = chainFixture();
    chain.accounts.delete(chain.ammV4.lpAccount);
    await expect(
      quoteWithdraw(mockActionRpc(chain), chain.owner.publicKey.toBase58(), target(chain), 5_000, 100),
    ).rejects.toBeInstanceOf(PositionGoneError);
  });

  it("refuses data that does not match the pool or its market", async () => {
    const owner = chainFixture().owner.publicKey.toBase58();
    const cases: [string, (chain: SyntheticChain, t: FungibleTarget) => FungibleTarget][] = [
      ["a pool owned by another program", (chain, t) => {
        const info = chain.accounts.get(t.pool!)!;
        chain.accounts.set(t.pool!, { ...info, owner: PROGRAM_IDS.cpmm });
        return t;
      }],
      ["a CPMM pool named as AMM v4", (chain, t) => ({ ...t, pool: chain.cpmm.pool })],
      ["a pool of another LP mint", (chain, t) => ({ ...t, lpMint: chain.cpmm.lpMint })],
      ["an LP account of another mint", (chain, t) => ({ ...t, lpAccount: chain.cpmm.lpAccount })],
      ["a missing market", (chain, t) => {
        chain.accounts.delete(chain.ammV4.market);
        return t;
      }],
      ["a market owned by another program", (chain, t) => {
        const info = chain.accounts.get(chain.ammV4.market)!;
        chain.accounts.set(chain.ammV4.market, { ...info, owner: PROGRAM_IDS.clmm });
        return t;
      }],
      ["a market that names another address", (chain, t) => {
        const info = chain.accounts.get(chain.ammV4.market)!;
        const data = Buffer.from(info.data);
        pk(chain.ammV4.pool).toBuffer().copy(data, 13); // ownAddress
        chain.accounts.set(chain.ammV4.market, { ...info, data });
        return t;
      }],
      ["a vault holding another mint", (chain, t) => {
        const amm = ammOf(chain);
        chain.accounts.set(amm.baseVault.toBase58(), chain.accounts.get(amm.quoteVault.toBase58())!);
        return t;
      }],
      ["a malformed address", (_chain, t) => ({ ...t, pool: "not-a-key" })],
    ];
    for (const [name, mutate] of cases) {
      const chain = chainFixture();
      const t = mutate(chain, target(chain));
      await expect(buildWithdrawGroups(mockActionRpc(chain), owner, t, 5_000, 100), name).rejects.toThrow(MISMATCH);
    }
  });
});

describe("buildClaimGroups (Raydium AMM v4)", () => {
  it("throws: AMM v4 fees are inside the LP tokens", async () => {
    const chain = chainFixture();
    await expect(
      buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [target(chain)]),
    ).rejects.toThrow("claim not supported");
  });
});
