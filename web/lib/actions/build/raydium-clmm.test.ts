// @vitest-environment node
// web3.js derives program addresses with Node's crypto; jsdom's realm breaks
// that, so this suite runs in the node environment.
import { createHash } from "node:crypto";
import {
  getPdaPoolRewardVaultId,
  getPdaProtocolPositionAddress,
  LiquidityMathUtil,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
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
import type { ClmmTarget, DammV2Target } from "../types";
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
const C = SYNTHETIC.clmm;
const W = C.wide;
const CLMM = PROGRAM_IDS.clmm;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM = PROGRAM_IDS.system;
const MISMATCH = "Position data doesn't match the pool · skipped";
const DECREASE = Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]);
const CLOSE = Buffer.from([123, 134, 81, 0, 49, 68, 98, 98]);
const Q64 = new BN(1).shln(64);
const rent = (size: number) => (size + 128) * 6_960;

type Which = "main" | "wide";

function fixtureOf(chain: SyntheticChain, which: Which) {
  return which === "main" ? chain.clmm : chain.clmm.wide;
}

function target(chain: SyntheticChain, which: Which = "main"): ClmmTarget {
  const f = fixtureOf(chain, which);
  // DMND's snapshot: deliberately stale numbers, so tests prove the builders
  // read live state instead.
  return {
    protocol: "raydium-clmm",
    id: `clmm-${which}`,
    pool: f.pool,
    position: f.position,
    positionMint: f.positionMint,
    positionNftAccount: f.positionNftAccount,
    nftTokenProgram: which === "main" ? PROGRAM_IDS.token2022 : PROGRAM_IDS.token,
    program: CLMM,
    liquidity: "1",
    tickLower: -60,
    tickUpper: 60,
    feeOwedAAtoms: "1",
    feeOwedBAtoms: "1",
    rewards: [],
    tokenA: { mint: which === "main" ? chain.mints.synt : chain.mints.syna, decimals: 6, symbol: "SYNX" },
    tokenB: { mint: chain.mints.wsol, decimals: 9, symbol: "SOL" },
    snapshotSlot: 1,
  };
}

const poolOf = (chain: SyntheticChain, address: string) =>
  PoolInfoLayout.decode(chain.accounts.get(address)!.data);

function patchLayout<T extends { decode(b: Buffer): unknown; encode(s: unknown, b: Buffer): number }>(
  chain: SyntheticChain,
  address: string,
  layout: T,
  mutate: (state: Record<string, any>) => void, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const info = chain.accounts.get(address)!;
  const data = Buffer.from(info.data);
  const state = layout.decode(data) as Record<string, unknown>;
  mutate(state);
  layout.encode(state, data);
  info.data.subarray(0, 8).copy(data, 0); // the layouts skip the discriminator
  chain.accounts.set(address, { ...info, data });
}

/** Gives the main pool the wide pool's three reward mints (REWARD, SYNR1, SYNR2), with funded vaults. */
function addMainPoolRewards(chain: SyntheticChain) {
  const pool = pk(chain.clmm.pool);
  const slots = poolOf(chain, chain.clmm.wide.pool).rewardInfos;
  const vaults = chain.clmm.wide.rewardMints.map((mint, i) => {
    const vault = getPdaPoolRewardVaultId(pk(CLMM), pool, pk(mint)).publicKey;
    const from = chain.accounts.get(chain.clmm.wide.rewardVaults[i])!;
    const data = Buffer.from(from.data);
    pool.toBuffer().copy(data, 32); // the token account's owner
    chain.accounts.set(vault.toBase58(), { ...from, data });
    return vault;
  });
  patchLayout(chain, chain.clmm.pool, PoolInfoLayout, (s) => {
    s.rewardInfos = slots.map((slot, i) => ({ ...slot, vault: vaults[i] }));
  });
}

/** Gives the owner an empty, initialized ATA of each of `mints` (under the mint's live token program). */
function giveAtas(chain: SyntheticChain, mints: string[]) {
  for (const mint of mints) {
    const program = chain.accounts.get(mint)!.owner;
    chain.accounts.set(ownerAta(chain, mint, program), {
      data: tokenAccountData({ mint: pk(mint), owner: chain.owner.publicKey, amount: new BN(0) }),
      owner: program,
      lamports: rent(165),
    });
  }
}

const isClmm = (ix: TransactionInstruction, disc: Buffer) =>
  ix.programId.toBase58() === CLMM && ix.data.subarray(0, 8).equals(disc);
const clmmNames = (ixs: TransactionInstruction[]) =>
  ixs
    .filter((ix) => ix.programId.toBase58() === CLMM)
    .map((ix) => (isClmm(ix, DECREASE) ? "decrease_liquidity_v2" : isClmm(ix, CLOSE) ? "close_position" : "?"));
const isUnwrap = (ix: TransactionInstruction) =>
  ix.programId.toBase58() === PROGRAM_IDS.token && ix.data.length === 1 && ix.data[0] === 9;
const keysOf = (ix: TransactionInstruction) => ix.keys.map((k) => k.pubkey.toBase58());
const u128 = (data: Buffer, offset: number) => new BN(data.subarray(offset, offset + 16), "le");
const u64 = (data: Buffer, offset: number) => new BN(data.subarray(offset, offset + 8), "le");
const ownerAta = (chain: SyntheticChain, mint: string, program: string) =>
  getAssociatedTokenAddressSync(pk(mint), chain.owner.publicKey, false, pk(program)).toBase58();

/** Packs `groups` as the runner would and runs the pre-sign check on each message. */
function packAndVerify(chain: SyntheticChain, groups: InstructionGroup[], expectation: Expectation) {
  const messages = packGroups(groups, chain.owner.publicKey, MOCK_BLOCKHASH, 10_000);
  return messages.map((m) => verifyMessage(m.message, expectation));
}

/** Amounts out of `liquidity` at the pool's live price, floored (the program's rounding on decrease). */
function principal(chain: SyntheticChain, which: Which, liquidity: BN) {
  const f = fixtureOf(chain, which);
  const s = which === "main" ? C : W;
  return LiquidityMathUtil.getAmountsForLiquidity(
    poolOf(chain, f.pool).sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(s.tickLower),
    TickUtil.getSqrtPriceAtTick(s.tickUpper),
    liquidity,
    false,
  );
}

/** SYNT's 1% transfer fee (rounded up, capped), taken off `amount`. */
const netOfSyntFee = (amount: BN) =>
  amount.sub(BN.min(amount.muln(SYNTHETIC.transferFeeBps).addn(9_999).divn(10_000), new BN(SYNTHETIC.transferFeeMax)));
const slip = (amount: BN, bps: number) => amount.muln(10_000 - bps).divn(10_000);

describe("buildClaimGroups (Raydium CLMM)", () => {
  it("collects with decrease_liquidity_v2(0, 0, 0) in one group the pre-sign check accepts", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain);
    const pool = poolOf(chain, t.pool);
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [t]);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].positionIds).toEqual([t.id]);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2"]);
    // The missing wSOL ATA's create first (SYNT's ATA exists), then the
    // collect, then the wSOL unwrap.
    expect(ixs[0].programId.toBase58()).toBe(ATA_PROGRAM);
    expect(keysOf(ixs[0])[3]).toBe(chain.mints.wsol);
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    expect(ixs).toHaveLength(3);

    const decrease = ixs.find((ix) => isClmm(ix, DECREASE))!;
    expect(decrease.data).toHaveLength(40);
    expect(u128(decrease.data, 8).isZero()).toBe(true);
    expect(u64(decrease.data, 24).isZero() && u64(decrease.data, 32).isZero()).toBe(true);
    const keys = keysOf(decrease);
    const programOf = (mint: string) => (mint === chain.mints.synt ? PROGRAM_IDS.token2022 : PROGRAM_IDS.token);
    expect(keys).toEqual([
      owner,
      t.positionNftAccount,
      t.position,
      t.pool,
      getPdaProtocolPositionAddress(pk(CLMM), pk(t.pool), C.tickLower, C.tickUpper).publicKey.toBase58(),
      pool.vaultA.toBase58(),
      pool.vaultB.toBase58(),
      chain.clmm.tickArrays[0],
      chain.clmm.tickArrays[1],
      ownerAta(chain, pool.mintA.toBase58(), programOf(pool.mintA.toBase58())),
      ownerAta(chain, pool.mintB.toBase58(), programOf(pool.mintB.toBase58())),
      PROGRAM_IDS.token,
      PROGRAM_IDS.token2022,
      MEMO,
      pool.mintA.toBase58(),
      pool.mintB.toBase58(),
    ]);
    expect(decrease.keys[0].isSigner).toBe(true);

    expect(expectation.kind).toBe("claim");
    expect(expectation.owner).toBe(owner);
    expect(expectation.positions).toEqual([
      { position: t.position, nftAccount: t.positionNftAccount, protocol: "raydium-clmm" },
    ]);
    expect([...expectation.mints].sort((a, b) => a.mint.localeCompare(b.mint))).toEqual(
      [chain.mints.synt, chain.mints.wsol].sort().map((mint) => ({ mint, tokenProgram: programOf(mint) })),
    );
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("uses the NFT account DMND names, not the owner's ATA of the NFT", async () => {
    const chain = chainFixture();
    const t = target(chain);
    const ata2022 = ownerAta(chain, t.positionMint, PROGRAM_IDS.token2022);
    expect(t.positionNftAccount).not.toBe(ata2022);
    const { groups } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [t]);
    const decrease = groups[0].instructions.find((ix) => isClmm(ix, DECREASE))!;
    expect(keysOf(decrease)[1]).toBe(t.positionNftAccount);
    expect(groups[0].instructions.flatMap(keysOf)).not.toContain(ata2022);
  });

  it("creates a Token-2022 mint's ATA under Token-2022 and pays it through the V2 accounts", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain);
    const syntAta = ownerAta(chain, chain.mints.synt, PROGRAM_IDS.token2022);
    chain.accounts.delete(syntAta);
    const { groups } = await buildClaimGroups(mockActionRpc(chain), owner, [t]);
    const ixs = groups[0].instructions;
    const create = ixs.find((ix) => ix.programId.toBase58() === ATA_PROGRAM && keysOf(ix)[3] === chain.mints.synt)!;
    expect(keysOf(create)).toEqual([owner, syntAta, owner, chain.mints.synt, SYSTEM, PROGRAM_IDS.token2022]);
    expect([...create.data]).toEqual([1]); // idempotent
    const keys = keysOf(ixs.find((ix) => isClmm(ix, DECREASE))!);
    const syntIndex = keys.indexOf(chain.mints.synt);
    expect(syntIndex === 14 || syntIndex === 15).toBe(true);
    expect(keys[syntIndex - 5]).toBe(syntAta); // recipient 9/10 pairs with mint 14/15
    expect(keys.slice(11, 14)).toEqual([PROGRAM_IDS.token, PROGRAM_IDS.token2022, MEMO]);
  });

  it("builds a claim for a position even when nothing is owed (the simulation decides)", async () => {
    const chain = chainFixture();
    const t = target(chain);
    patchLayout(chain, t.position, PersonalPositionLayout, (s) => {
      s.tokenFeesOwedA = new BN(0);
      s.tokenFeesOwedB = new BN(0);
    });
    const { groups, skipped } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [t]);
    expect(skipped).toEqual([]);
    expect(groups.map((g) => g.positionIds)).toEqual([[t.id]]);
  });

  it('skips a deleted position, or one whose NFT left the wallet, as "Position no longer exists"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const gone = target(chain, "main");
    const moved = target(chain, "wide");
    chain.accounts.delete(gone.position);
    const nft = chain.accounts.get(moved.positionNftAccount)!;
    chain.accounts.set(moved.positionNftAccount, {
      ...nft,
      data: tokenAccountData({
        mint: pk(moved.positionMint),
        owner: Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey,
        amount: new BN(1),
      }),
    });
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [gone, moved]);
    expect(skipped).toEqual([
      { positionId: gone.id, reason: "Position no longer exists" },
      { positionId: moved.id, reason: "Position no longer exists" },
    ]);
    expect(groups).toEqual([]);
    expect(expectation.positions).toEqual([]);
    expect(expectation.mints).toEqual([]);
  });

  it("packs its largest group (bitmap extension, three reward triples, four ATAs, wSOL unwrap) into one transaction", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "wide");
    const wide = chain.clmm.wide;
    const { groups, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [t]);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2"]);
    const keys = keysOf(ixs.find((ix) => isClmm(ix, DECREASE))!);
    expect(keys[1]).toBe(t.positionNftAccount);
    expect(keys.slice(7, 9)).toEqual(wide.tickArrays);
    expect(keys[16]).toBe(wide.bitmapExtension);
    const rewardProgram = (mint: string) => (mint === wide.rewardMints[2] ? PROGRAM_IDS.token2022 : PROGRAM_IDS.token);
    expect(keys.slice(17)).toEqual(
      wide.rewardMints.flatMap((mint, i) => [wide.rewardVaults[i], ownerAta(chain, mint, rewardProgram(mint)), mint]),
    );
    const creates = ixs.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM);
    // SYNA's ATA exists already.
    expect(creates.map((ix) => keysOf(ix)[3]).sort()).toEqual(
      [chain.mints.wsol, ...wide.rewardMints].sort(),
    );
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    expect([...expectation.mints].sort((a, b) => a.mint.localeCompare(b.mint))).toEqual(
      [chain.mints.syna, chain.mints.wsol, ...wide.rewardMints]
        .sort()
        .map((mint) => ({ mint, tokenProgram: rewardProgram(mint) })),
    );
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("omits the bitmap extension when the tick arrays are inside the default bitmap", async () => {
    const chain = chainFixture();
    const { groups } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [target(chain)]);
    const keys = keysOf(groups[0].instructions.find((ix) => isClmm(ix, DECREASE))!);
    expect(keys).toHaveLength(16);
    expect(keys).not.toContain(chain.clmm.bitmapExtension);
  });

  it("skips rows whose data does not match the pool and still builds the good ones", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const good = target(chain, "main");
    const wrongProgram = { ...target(chain, "wide"), id: "wrong-program", program: PROGRAM_IDS.cpAmm };
    // The position lives in the main pool, not the one DMND names.
    const wrongPool = { ...target(chain, "main"), id: "wrong-pool", pool: chain.clmm.wide.pool };
    // The position address is not the PDA of the NFT mint DMND names.
    const wrongMint = { ...target(chain, "main"), id: "wrong-mint", positionMint: chain.clmm.wide.positionMint };
    // An NFT account whose bytes are not a token account.
    const badNft = target(chain, "wide");
    const nft = chain.accounts.get(badNft.positionNftAccount)!;
    chain.accounts.set(badNft.positionNftAccount, { ...nft, data: Buffer.alloc(3) });
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [
      wrongProgram,
      good,
      wrongPool,
      wrongMint,
      badNft,
    ]);
    expect(groups.map((g) => g.positionIds)).toEqual([[good.id]]);
    expect(skipped).toEqual(
      [wrongProgram, wrongPool, wrongMint, badNft].map((t) => ({ positionId: t.id, reason: MISMATCH })),
    );
    expect(expectation.positions.map((p) => p.position)).toEqual([good.position]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("skips a position whose pool, tick array or mint is unreadable", async () => {
    const owner = (chain: SyntheticChain) => chain.owner.publicKey.toBase58();
    const cases: ((chain: SyntheticChain) => void)[] = [
      (chain) => chain.accounts.delete(chain.clmm.tickArrays[1]),
      (chain) => chain.accounts.delete(chain.clmm.pool),
      (chain) => chain.accounts.delete(chain.mints.synt),
      // A mint owned by neither token program.
      (chain) => chain.accounts.set(chain.mints.synt, { ...chain.accounts.get(chain.mints.synt)!, owner: SYSTEM }),
      // A tick array of another pool at the derived address.
      (chain) => chain.accounts.set(chain.clmm.tickArrays[0], chain.accounts.get(chain.clmm.wide.tickArrays[0])!),
      // Pool bytes under a different account discriminator.
      (chain) => {
        const info = chain.accounts.get(chain.clmm.pool)!;
        const data = Buffer.from(info.data);
        data.fill(0, 0, 8);
        chain.accounts.set(chain.clmm.pool, { ...info, data });
      },
    ];
    for (const breakIt of cases) {
      const chain = chainFixture();
      breakIt(chain);
      const { groups, skipped } = await buildClaimGroups(mockActionRpc(chain), owner(chain), [
        target(chain, "main"),
        target(chain, "wide"),
      ]);
      expect(skipped).toEqual([{ positionId: "clmm-main", reason: MISMATCH }]);
      expect(groups.map((g) => g.positionIds)).toEqual([["clmm-wide"]]);
    }
  });

  it("skips rows with a malformed address and still builds the good ones", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const good = target(chain, "main");
    const badPool = { ...target(chain, "wide"), id: "a", pool: "not-base58-0OIl" };
    const badPosition = { ...target(chain, "wide"), id: "b", position: "0".repeat(44) };
    const badNft = { ...target(chain, "wide"), id: "c", positionNftAccount: "" };
    const badMint = { ...target(chain, "wide"), id: "d", positionMint: "abc" };
    const { groups, skipped } = await buildClaimGroups(mockActionRpc(chain), owner, [
      badPool,
      good,
      badPosition,
      badNft,
      badMint,
    ]);
    expect(groups.map((g) => g.positionIds)).toEqual([[good.id]]);
    expect(skipped).toEqual(
      [badPool, badPosition, badNft, badMint].map((t) => ({ positionId: t.id, reason: MISMATCH })),
    );
    await expect(buildWithdrawGroups(mockActionRpc(chain), owner, badPool, 5_000, 100)).rejects.toThrow(
      "Position data doesn't match the pool",
    );
  });

  it("builds one group for a position listed twice", async () => {
    const chain = chainFixture();
    const t = target(chain);
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [
      t,
      { ...t },
    ]);
    expect(groups.map((g) => g.positionIds)).toEqual([[t.id]]);
    expect(skipped).toEqual([]);
    expect(expectation.positions).toHaveLength(1);
  });

  it("claims DAMM v2 and CLMM positions together under one expectation", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const d = chain.dammV2;
    const damm: DammV2Target = {
      protocol: "meteora-damm-v2",
      id: "damm",
      pool: d.pool,
      position: d.position,
      positionMint: d.positionMint,
      positionNftAccount: d.positionNftAccount,
      nftTokenProgram: PROGRAM_IDS.token2022,
      program: PROGRAM_IDS.cpAmm,
      liquidity: { unlocked: "1", vested: "0", permanentLocked: "0", total: "1" },
      feeAAtoms: "1",
      feeBAtoms: "1",
      rewards: [],
      tokenA: { mint: chain.mints.syna, decimals: 9, symbol: "SYNA" },
      tokenB: { mint: chain.mints.wsol, decimals: 9, symbol: "SOL" },
      snapshotSlot: 1,
    };
    const clmm = target(chain, "main");
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [clmm, damm]);
    expect(skipped).toEqual([]);
    expect(groups.map((g) => g.positionIds)).toEqual([[clmm.id], [damm.id]]);
    expect(expectation.kind).toBe("claim");
    expect(expectation.positions.map((p) => p.protocol).sort()).toEqual(["meteora-damm-v2", "raydium-clmm"]);
    const mints = expectation.mints.map((m) => m.mint);
    expect(new Set(mints).size).toBe(mints.length);
    expect(packAndVerify(chain, groups, expectation).every((r) => r.ok)).toBe(true);
  });
});

describe("quoteWithdraw / buildWithdrawGroups (Raydium CLMM)", () => {
  it("withdraws 25% as floor(L × 0.25) with minimums from the live price, net of the transfer fee", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain);
    const pool = poolOf(chain, t.pool);
    const liquidity = C.liquidity.muln(2_500).divn(10_000);
    expect(liquidity.toString()).toBe(C.liquidity.divn(4).toString());

    const out = principal(chain, "main", liquidity);
    // Sanity, independent of the SDK: price 1 over ±3,600 ticks gives about
    // L × (1 − 1.0001^−1800) of each token.
    const approx = Number(liquidity.toString()) * (1 - Math.pow(1.0001, -1_800));
    expect(Math.abs(Number(out.amountA.toString()) / approx - 1)).toBeLessThan(1e-3);
    const isSyntA = pool.mintA.toBase58() === chain.mints.synt;
    const netA = isSyntA ? netOfSyntFee(out.amountA) : out.amountA;
    const netB = isSyntA ? out.amountB : netOfSyntFee(out.amountB);

    const quote = await quoteWithdraw(rpc, owner, t, 2_500, 100);
    expect(quote.withdrawableBps).toBe(10_000);
    expect(quote.vestingBps).toBe(0);
    expect(quote.closes).toBe(false);
    expect(quote.depositRefundLamports).toBeNull();
    expect(quote.minimums.map((m) => [m.mint, m.atoms])).toEqual([
      [pool.mintA.toBase58(), slip(netA, 100).toString()],
      [pool.mintB.toBase58(), slip(netB, 100).toString()],
    ]);
    // Fees owed come along (no fee growth since the position's checkpoint).
    expect(quote.fees.map((f) => [f.mint, f.atoms])).toEqual([
      [pool.mintA.toBase58(), (isSyntA ? netOfSyntFee(C.feesOwedA) : C.feesOwedA).toString()],
      [pool.mintB.toBase58(), (isSyntA ? C.feesOwedB : netOfSyntFee(C.feesOwedB)).toString()],
    ]);
    const gross = [out.amountA.add(C.feesOwedA), out.amountB.add(C.feesOwedB)];
    expect(quote.receive.map((r) => r.atoms)).toEqual([
      (isSyntA ? netOfSyntFee(gross[0]) : gross[0]).toString(),
      (isSyntA ? gross[1] : netOfSyntFee(gross[1])).toString(),
    ]);
    // Both ATAs exist or are wSOL (closed again): nothing to keep.
    expect(quote.rentLamports).toBe("0");

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 2_500, 100);
    expect(groups).toHaveLength(1);
    expect(groups[0].positionIds).toEqual([t.id]);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2"]);
    const decrease = ixs.find((ix) => isClmm(ix, DECREASE))!;
    expect(u128(decrease.data, 8).toString()).toBe(liquidity.toString());
    expect([u64(decrease.data, 24).toString(), u64(decrease.data, 32).toString()]).toEqual(
      quote.minimums.map((m) => m.atoms),
    );
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    expect(expectation.kind).toBe("withdraw");
    expect(expectation.positions).toEqual([
      { position: t.position, nftAccount: t.positionNftAccount, protocol: "raydium-clmm" },
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("closes the position at 100%, burning the Token-2022 NFT and showing the deposit refund", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain);
    const lamports = (a: string) => chain.accounts.get(a)!.lamports;

    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.closes).toBe(true);
    expect(quote.depositRefundLamports).toBe(
      String(lamports(t.position) + lamports(t.positionNftAccount) + lamports(t.positionMint)),
    );

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2", "close_position"]);
    const decrease = ixs.find((ix) => isClmm(ix, DECREASE))!;
    expect(u128(decrease.data, 8).toString()).toBe(C.liquidity.toString());
    const close = ixs.find((ix) => isClmm(ix, CLOSE))!;
    expect(close.data).toHaveLength(8);
    expect(keysOf(close)).toEqual([
      owner,
      t.positionMint,
      t.positionNftAccount,
      t.position,
      SYSTEM,
      PROGRAM_IDS.token2022,
      t.pool,
    ]);
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("withdraws all of the worst case without closing it, so the group still fits one transaction", async () => {
    // Bitmap extension, three reward triples, four new ATAs (wSOL and the
    // three rewards; SYNA's exists) and the unwrap: with close_position the
    // group would not fit (ruling R-T9a), so it withdraws and collects only.
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "wide");
    const wide = chain.clmm.wide;

    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.closes).toBe(false);
    expect(quote.depositRefundLamports).toBeNull();
    expect(quote.withdrawableBps).toBe(10_000);
    // Rewards owed are paid with every decrease.
    expect(quote.fees.slice(2).map((f) => [f.mint, f.atoms])).toEqual(
      wide.rewardMints.map((mint, i) => [mint, W.rewardsOwed[i].toString()]),
    );
    // New ATAs kept: REWARD and SYNR1 (Token, 165 bytes), SYNR2 (Token-2022 with ImmutableOwner, 170).
    expect(quote.rentLamports).toBe(String(2 * rent(165) + rent(170)));

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2"]);
    const decrease = ixs.find((ix) => isClmm(ix, DECREASE))!;
    expect(u128(decrease.data, 8).toString()).toBe(W.liquidity.toString());
    expect(keysOf(decrease)[16]).toBe(wide.bitmapExtension);
    expect(keysOf(decrease)).toHaveLength(16 + 1 + 9);
    expect(ixs.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM).map((ix) => keysOf(ix)[3]).sort()).toEqual(
      [chain.mints.wsol, ...wide.rewardMints].sort(),
    );
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    const messages = packGroups(groups, chain.owner.publicKey, MOCK_BLOCKHASH, 10_000);
    expect(messages).toHaveLength(1);
    expect(new VersionedTransaction(messages[0].message).serialize().length).toBeLessThanOrEqual(1_232);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("closes the same position at 100% once its ATAs exist, refunding a Token NFT without its mint", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "wide");
    const lamports = (a: string) => chain.accounts.get(a)!.lamports;
    giveAtas(chain, chain.clmm.wide.rewardMints);

    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.closes).toBe(true);
    // A Token NFT's mint cannot be closed: only the position and NFT account come back.
    expect(quote.depositRefundLamports).toBe(String(lamports(t.position) + lamports(t.positionNftAccount)));
    expect(quote.rentLamports).toBe("0");

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2", "close_position"]);
    expect(keysOf(ixs.find((ix) => isClmm(ix, CLOSE))!)[5]).toBe(PROGRAM_IDS.token);
    // Only the wSOL ATA is missing.
    expect(ixs.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM).map((ix) => keysOf(ix)[3])).toEqual([
      chain.mints.wsol,
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("closes a 100% withdraw with three reward triples and no bitmap extension", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    addMainPoolRewards(chain);
    const rpc = mockActionRpc(chain);
    const quote = await quoteWithdraw(rpc, owner, target(chain), 10_000, 100);
    expect(quote.closes).toBe(true);
    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, target(chain), 10_000, 100);
    const ixs = groups[0].instructions;
    expect(clmmNames(ixs)).toEqual(["decrease_liquidity_v2", "close_position"]);
    expect(keysOf(ixs.find((ix) => isClmm(ix, DECREASE))!)).toHaveLength(16 + 9);
    // SYNT's ATA exists; wSOL and the three rewards are created.
    expect(ixs.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM)).toHaveLength(4);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("creates only the ATAs that are missing, in claims and withdrawals", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const wide = chain.clmm.wide;
    // REWARD's ATA exists; SYNR1's address only holds lamports (not a token
    // account), so it still needs its create.
    giveAtas(chain, [wide.rewardMints[0]]);
    const synr1Ata = ownerAta(chain, wide.rewardMints[1], PROGRAM_IDS.token);
    chain.accounts.set(synr1Ata, { data: Buffer.alloc(0), owner: SYSTEM, lamports: 1_000 });
    const created = (ixs: TransactionInstruction[]) =>
      ixs.filter((ix) => ix.programId.toBase58() === ATA_PROGRAM).map((ix) => keysOf(ix)[3]).sort();
    const missing = [chain.mints.wsol, wide.rewardMints[1], wide.rewardMints[2]].sort();

    const claim = await buildClaimGroups(rpc, owner, [target(chain, "wide")]);
    expect(created(claim.groups[0].instructions)).toEqual(missing);
    expect(packAndVerify(chain, claim.groups, claim.expectation)).toEqual([{ ok: true }]);
    const withdraw = await buildWithdrawGroups(rpc, owner, target(chain, "wide"), 5_000, 100);
    expect(created(withdraw.groups[0].instructions)).toEqual(missing);
    // The quote's rent counts exactly those creates (wSOL's is closed again).
    const quote = await quoteWithdraw(rpc, owner, target(chain, "wide"), 5_000, 100);
    expect(quote.rentLamports).toBe(String(rent(165) + rent(170)));

    // With every ATA in place (the wSOL one too), nothing is created; the
    // existing wSOL ATA is still unwrapped.
    giveAtas(chain, [chain.mints.wsol, ...wide.rewardMints]);
    const none = await buildClaimGroups(rpc, owner, [target(chain, "wide")]);
    expect(created(none.groups[0].instructions)).toEqual([]);
    expect(isUnwrap(none.groups[0].instructions.at(-1)!)).toBe(true);
    expect(packAndVerify(chain, none.groups, none.expectation)).toEqual([{ ok: true }]);
  });

  it("quotes fees accrued since the position's checkpoint from the pool and tick fee growth", async () => {
    const chain = chainFixture();
    const t = target(chain);
    // Five tokens of fee growth per unit of liquidity, all inside the range
    // (the ticks' outside growth is 0 and the price is between them).
    patchLayout(chain, t.pool, PoolInfoLayout, (s) => {
      s.feeGrowthGlobalX64A = Q64.muln(5);
    });
    const pool = poolOf(chain, t.pool);
    const quote = await quoteWithdraw(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 2_500, 100);
    const feeA = C.feesOwedA.add(C.liquidity.muln(5));
    expect(quote.fees[0]).toMatchObject({
      mint: pool.mintA.toBase58(),
      atoms: (pool.mintA.toBase58() === chain.mints.synt ? netOfSyntFee(feeA) : feeA).toString(),
    });
  });

  it('refuses dust whose minimums both floor to 0 as "Amount too small to withdraw"', async () => {
    const chain = chainFixture();
    const t = target(chain);
    patchLayout(chain, t.position, PersonalPositionLayout, (s) => {
      s.liquidity = new BN(1_000);
    });
    const quote = await quoteWithdraw(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 100, 100);
    expect(quote.minimums.every((m) => m.atoms === "0")).toBe(true);
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 100, 100),
    ).rejects.toBeInstanceOf(AmountTooSmallError);
  });

  it('refuses a position with no liquidity as "Nothing to withdraw yet"', async () => {
    const chain = chainFixture();
    const t = target(chain);
    patchLayout(chain, t.position, PersonalPositionLayout, (s) => {
      s.liquidity = new BN(0);
    });
    const quote = await quoteWithdraw(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 10_000, 100);
    expect(quote.withdrawableBps).toBe(0);
    expect(quote.closes).toBe(false);
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 10_000, 100),
    ).rejects.toBeInstanceOf(NothingToWithdrawError);
  });

  it('refuses a deleted position with "Position no longer exists"', async () => {
    const chain = chainFixture();
    const t = target(chain);
    chain.accounts.delete(t.position);
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 5_000, 100),
    ).rejects.toBeInstanceOf(PositionGoneError);
    await expect(
      quoteWithdraw(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 5_000, 100),
    ).rejects.toBeInstanceOf(PositionGoneError);
  });

  it("rejects out-of-range percentages and slippage", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain);
    await expect(buildWithdrawGroups(rpc, owner, t, 0, 100)).rejects.toThrow(RangeError);
    await expect(buildWithdrawGroups(rpc, owner, t, 10_001, 100)).rejects.toThrow(RangeError);
    await expect(buildWithdrawGroups(rpc, owner, t, 5_000, 501)).rejects.toThrow(RangeError);
    await expect(quoteWithdraw(rpc, owner, t, 2.5, 100)).rejects.toThrow(RangeError);
  });
});

describe("Raydium CLMM account discriminators", () => {
  it("match Anchor's sha256('account:<Name>') prefixes the fixture writes", () => {
    const chain = chainFixture();
    const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
    expect(chain.accounts.get(chain.clmm.pool)!.data.subarray(0, 8)).toEqual(disc("PoolState"));
    expect(chain.accounts.get(chain.clmm.position)!.data.subarray(0, 8)).toEqual(disc("PersonalPositionState"));
    expect(chain.accounts.get(chain.clmm.tickArrays[0])!.data.subarray(0, 8)).toEqual(disc("TickArrayState"));
  });
});
