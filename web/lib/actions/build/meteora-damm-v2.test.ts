// @vitest-environment node
// web3.js derives program addresses with Node's crypto; jsdom's realm breaks
// that, so this suite runs in the node environment.
import {
  cpAmmCoder,
  CpAmmIdl,
  derivePoolAuthority,
  deriveRewardVaultAddress,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
} from "@meteora-ag/cp-amm-sdk";
import {
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import {
  chainFixture,
  CLOCK_SYSVAR,
  PROGRAM_IDS,
  SYNTHETIC,
  tokenAccountData,
  type DammV2Fixture,
  type SyntheticChain,
} from "@/tests/fixtures/actions-chain";
import { MOCK_BLOCKHASH, mockActionRpc } from "@/tests/fixtures/mock-action-rpc";
import type { DammV2Target, FungibleTarget } from "../types";
import {
  AmountTooSmallError,
  buildClaimGroups,
  buildCloseGroups,
  buildWithdrawGroups,
  NothingToWithdrawError,
  packGroups,
  PositionGoneError,
  PositionNotEmptyError,
  quoteWithdraw,
  RewardsPausedError,
  unwrapsWrappedSol,
  verifyMessage,
  type Expectation,
  type InstructionGroup,
} from "./index";

const pk = (address: string) => new PublicKey(address);
const D = SYNTHETIC.dammV2;
const pow2 = (n: number) => new BN(1).shln(n);
const CP_AMM = PROGRAM_IDS.cpAmm;

type Variant = keyof SyntheticChain["dammV2"]["variants"];

function target(chain: SyntheticChain, variant: Variant): DammV2Target {
  const v: DammV2Fixture = chain.dammV2.variants[variant];
  const transferFee = variant === "transferFee";
  // DMND's snapshot: deliberately stale numbers, so tests prove the builders
  // read live state instead.
  return {
    protocol: "meteora-damm-v2",
    id: `damm-${variant}`,
    pool: v.pool,
    position: v.position,
    positionMint: v.positionMint,
    positionNftAccount: v.positionNftAccount,
    nftTokenProgram: PROGRAM_IDS.token2022,
    program: CP_AMM,
    liquidity: { unlocked: "1", vested: "0", permanentLocked: "0", total: "1" },
    feeAAtoms: "1",
    feeBAtoms: "1",
    rewards: [],
    tokenA: transferFee
      ? { mint: chain.mints.synt, decimals: 6, symbol: "SYNT" }
      : { mint: chain.mints.syna, decimals: 9, symbol: "SYNA" },
    tokenB: transferFee
      ? { mint: chain.mints.synb, decimals: 6, symbol: "SYNB" }
      : { mint: chain.mints.wsol, decimals: 9, symbol: "SOL" },
    snapshotSlot: 1,
  };
}

// Re-encodes a cp-amm account after `mutate` edits its decoded (snake_case)
// state, the way the fixture encodes them (its layout, at the account's size).
function patchCpAmm(
  chain: SyntheticChain,
  address: string,
  name: "Pool" | "Position" | "Vesting",
  mutate: (state: Record<string, any>) => void, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const info = chain.accounts.get(address)!;
  const coder = cpAmmCoder.accounts;
  const state = coder.decode(name, info.data);
  mutate(state);
  const body = Buffer.alloc(info.data.length - 8);
  (
    coder as unknown as {
      accountLayouts: Map<string, { layout: { encode(src: unknown, b: Buffer): number } }>;
    }
  ).accountLayouts
    .get(name)!
    .layout.encode(state, body);
  chain.accounts.set(address, { ...info, data: Buffer.concat([info.data.subarray(0, 8), body]) });
}

function setClock(chain: SyntheticChain, unixTimestamp: number) {
  const info = chain.accounts.get(CLOCK_SYSVAR)!;
  const data = Buffer.from(info.data);
  data.writeBigInt64LE(BigInt(unixTimestamp), 32);
  chain.accounts.set(CLOCK_SYSVAR, { ...info, data });
}

// Initialises reward slot 1 of the wSOL pool with a second synthetic mint and
// gives every wSOL-pool position something to claim there.
function addSecondReward(chain: SyntheticChain): string {
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(16)).publicKey;
  const pool = pk(chain.dammV2.pool);
  const vault = deriveRewardVaultAddress(pool, 1);
  const rewardMint = chain.accounts.get(chain.mints.reward)!;
  chain.accounts.set(mint.toBase58(), { ...rewardMint, data: Buffer.from(rewardMint.data) });
  chain.accounts.set(vault.toBase58(), {
    data: tokenAccountData({ mint, owner: derivePoolAuthority(), amount: new BN("1000000000") }),
    owner: PROGRAM_IDS.token,
    lamports: 2_039_280,
  });
  patchCpAmm(chain, chain.dammV2.pool, "Pool", (state) => {
    state.reward_infos[1] = { ...state.reward_infos[0], mint, vault };
  });
  patchCpAmm(chain, chain.dammV2.position, "Position", (state) => {
    state.reward_infos[1] = { ...state.reward_infos[1], reward_pendings: new BN(40_000_000) };
  });
  return mint.toBase58();
}

// Freezes the wSOL pool's reward-slot-0 vault (the reward cannot pay out).
function freezeRewardVault(chain: SyntheticChain) {
  const vault = deriveRewardVaultAddress(pk(chain.dammV2.pool), 0).toBase58();
  const info = chain.accounts.get(vault)!;
  const data = Buffer.from(info.data);
  AccountLayout.encode({ ...AccountLayout.decode(data), state: AccountState.Frozen }, data);
  chain.accounts.set(vault, { ...info, data });
}

const MISMATCH = "Position data doesn't match the pool · skipped";

const discriminator = (name: string) =>
  Buffer.from(CpAmmIdl.instructions.find((ix) => ix.name === name)!.discriminator);
const isCpAmm = (ix: TransactionInstruction, name: string) =>
  ix.programId.toBase58() === CP_AMM && ix.data.subarray(0, 8).equals(discriminator(name));
const cpAmmNames = (ixs: TransactionInstruction[]) =>
  ixs
    .filter((ix) => ix.programId.toBase58() === CP_AMM)
    .map((ix) => CpAmmIdl.instructions.find((d) => ix.data.subarray(0, 8).equals(Buffer.from(d.discriminator)))!.name);
const isUnwrap = (ix: TransactionInstruction) =>
  ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data.length === 1 && ix.data[0] === 9;
const u128 = (data: Buffer, offset: number) => new BN(data.subarray(offset, offset + 16), "le");
const u64 = (data: Buffer, offset: number) => new BN(data.subarray(offset, offset + 8), "le");

/** Packs `groups` as the runner would and runs the pre-sign check on each message. */
function packAndVerify(chain: SyntheticChain, groups: InstructionGroup[], expectation: Expectation) {
  const messages = packGroups(groups, chain.owner.publicKey, MOCK_BLOCKHASH, 10_000);
  return messages.map((m) => verifyMessage(m.message, expectation));
}

describe("buildClaimGroups (Meteora DAMM v2)", () => {
  it("claims fees and rewards from a position in one group the pre-sign check accepts", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "unlocked");
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [t]);

    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].positionIds).toEqual([t.id]);
    const ixs = groups[0].instructions;
    expect(cpAmmNames(ixs)).toEqual(["claim_position_fee", "claim_reward"]);
    // ATA creates first (A, B and the reward mint), then the claims.
    const ataProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const creates = ixs.filter((ix) => ix.programId.toBase58() === ataProgram);
    expect(creates.map((ix) => ix.keys[3].pubkey.toBase58()).sort()).toEqual(
      [chain.mints.syna, chain.mints.wsol, chain.mints.reward].sort(),
    );
    expect(ixs.slice(0, 3).every((ix) => ix.programId.toBase58() === ataProgram)).toBe(true);
    // Receiver is the owner: the claim pays the owner's own ATAs.
    const claim = ixs.find((ix) => isCpAmm(ix, "claim_position_fee"))!;
    expect(claim.keys[3].pubkey.equals(getAssociatedTokenAddressSync(pk(chain.mints.syna), chain.owner.publicKey))).toBe(true);

    expect(expectation.kind).toBe("claim");
    expect(expectation.owner).toBe(owner);
    expect(expectation.positions).toEqual([
      { position: t.position, nftAccount: t.positionNftAccount, protocol: "meteora-damm-v2" },
    ]);
    expect([...expectation.mints].sort((a, b) => a.mint.localeCompare(b.mint))).toEqual(
      [chain.mints.syna, chain.mints.wsol, chain.mints.reward]
        .sort()
        .map((mint) => ({ mint, tokenProgram: PROGRAM_IDS.token })),
    );
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("ends a wSOL pool's group with the unwrap to the owner, and adds none otherwise", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey;
    const rpc = mockActionRpc(chain);
    const wsol = await buildClaimGroups(rpc, owner.toBase58(), [target(chain, "unlocked")]);
    const last = wsol.groups[0].instructions.at(-1)!;
    expect(isUnwrap(last)).toBe(true);
    expect(last.keys[0].pubkey.equals(getAssociatedTokenAddressSync(pk(chain.mints.wsol), owner))).toBe(true);
    expect(last.keys[1].pubkey.equals(owner)).toBe(true);
    expect(wsol.groups[0].instructions.filter(isUnwrap)).toHaveLength(1);

    const plain = await buildClaimGroups(rpc, owner.toBase58(), [target(chain, "transferFee")]);
    expect(plain.groups[0].instructions.some(isUnwrap)).toBe(false);
    expect(plain.expectation.mints).toEqual(
      expect.arrayContaining([{ mint: chain.mints.synt, tokenProgram: PROGRAM_IDS.token2022 }]),
    );
    expect(packAndVerify(chain, plain.groups, plain.expectation)).toEqual([{ ok: true }]);
  });

  it('skips a position with nothing claimable live as "Nothing to claim"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const noFees = target(chain, "noFees");
    const unlocked = target(chain, "unlocked");
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [
      noFees,
      unlocked,
    ]);
    expect(skipped).toEqual([{ positionId: noFees.id, reason: "Nothing to claim" }]);
    expect(groups.map((g) => g.positionIds)).toEqual([[unlocked.id]]);
    expect(expectation.positions.map((p) => p.position)).toEqual([unlocked.position]);
  });

  it('skips a deleted position, or one whose NFT left the wallet, as "Position no longer exists"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const gone = target(chain, "unlocked");
    const moved = target(chain, "vested");
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
  });

  it("packs its largest group (two rewards and a wSOL unwrap) into one transaction", async () => {
    const chain = chainFixture();
    const second = addSecondReward(chain);
    const owner = chain.owner.publicKey.toBase58();
    const { groups, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [target(chain, "unlocked")]);
    expect(cpAmmNames(groups[0].instructions)).toEqual(["claim_position_fee", "claim_reward", "claim_reward"]);
    expect(expectation.mints.map((m) => m.mint)).toContain(second);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("skips rows whose data does not match the pool and still builds the good ones", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const good = target(chain, "unlocked");
    const wrongProgram = { ...target(chain, "vested"), id: "wrong-program", program: PROGRAM_IDS.clmm };
    // The position lives in the wSOL pool, not the one DMND names.
    const wrongPool = { ...target(chain, "locked"), pool: chain.dammV2.variants.transferFee.pool };
    // An NFT account whose bytes are not a token account.
    const badNft = target(chain, "noFees");
    const nft = chain.accounts.get(badNft.positionNftAccount)!;
    chain.accounts.set(badNft.positionNftAccount, { ...nft, data: Buffer.alloc(3) });
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), owner, [
      wrongProgram,
      good,
      wrongPool,
      badNft,
    ]);
    expect(groups.map((g) => g.positionIds)).toEqual([[good.id]]);
    expect(skipped).toEqual([
      { positionId: wrongProgram.id, reason: MISMATCH },
      { positionId: wrongPool.id, reason: MISMATCH },
      { positionId: badNft.id, reason: MISMATCH },
    ]);
    expect(expectation.positions.map((p) => p.position)).toEqual([good.position]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("skips every row of a pool that is unreadable or whose mint is under another token program", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const wsolRow = target(chain, "unlocked");
    const otherRow = target(chain, "transferFee");
    // SYNA (the wSOL pool's token A) is a Token mint; claim it is Token-2022.
    const syna = chain.accounts.get(chain.mints.syna)!;
    chain.accounts.set(chain.mints.syna, { ...syna, owner: PROGRAM_IDS.token2022 });
    const first = await buildClaimGroups(mockActionRpc(chain), owner, [wsolRow, otherRow]);
    expect(first.skipped).toEqual([{ positionId: wsolRow.id, reason: MISMATCH }]);
    expect(first.groups.map((g) => g.positionIds)).toEqual([[otherRow.id]]);

    chain.accounts.set(chain.mints.syna, syna);
    chain.accounts.delete(otherRow.pool);
    const second = await buildClaimGroups(mockActionRpc(chain), owner, [wsolRow, otherRow]);
    expect(second.skipped).toEqual([{ positionId: otherRow.id, reason: MISMATCH }]);
    expect(second.groups.map((g) => g.positionIds)).toEqual([[wsolRow.id]]);
    expect(packAndVerify(chain, second.groups, second.expectation)).toEqual([{ ok: true }]);
  });

  it("skips rows with a malformed address and still builds the good ones", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const good = target(chain, "unlocked");
    const badPool = { ...target(chain, "vested"), pool: "not-base58-0OIl" };
    const badPosition = { ...target(chain, "locked"), position: "0".repeat(44) };
    const badNft = { ...target(chain, "transferFee"), positionNftAccount: "" };
    const badMint = { ...target(chain, "innerPartial"), positionMint: "abc" };
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
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), owner, badPool, 5_000, 100),
    ).rejects.toThrow("Position data doesn't match the pool");
  });

  it("fails the whole claim only when the clock cannot be read", async () => {
    const chain = chainFixture();
    chain.accounts.delete(CLOCK_SYSVAR);
    await expect(
      buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [target(chain, "unlocked")]),
    ).rejects.toThrow(/clock/);
  });

  it("claims fees but not a reward whose vault is frozen", async () => {
    const chain = chainFixture();
    freezeRewardVault(chain);
    const { groups, expectation } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [
      target(chain, "unlocked"),
    ]);
    expect(cpAmmNames(groups[0].instructions)).toEqual(["claim_position_fee"]);
    expect(expectation.mints.map((m) => m.mint)).not.toContain(chain.mints.reward);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("builds one group for a position listed twice", async () => {
    const chain = chainFixture();
    const t = target(chain, "unlocked");
    const { groups, skipped, expectation } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [
      t,
      { ...t },
    ]);
    expect(groups.map((g) => g.positionIds)).toEqual([[t.id]]);
    expect(skipped).toEqual([]);
    expect(expectation.positions).toHaveLength(1);
  });

  it("refuses to claim CPMM positions, whose fees are inside the LP tokens", async () => {
    const chain = chainFixture();
    const cpmm = { protocol: "raydium-cpmm", id: "c" } as FungibleTarget;
    await expect(buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [cpmm])).rejects.toThrow(
      "claim not supported",
    );
  });
});

describe("quoteWithdraw / buildWithdrawGroups (Meteora DAMM v2)", () => {
  it("withdraws 50% of a half-vesting position's withdrawable part, refreshing vesting first", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "vested");
    // Live: 2^103 unlocked, 2^103 vesting of which 2^102 is releasable now.
    const withdrawable = D.halfLiquidity.add(D.releasableVesting);

    const quote = await quoteWithdraw(rpc, owner, t, 5_000, 100);
    expect(quote.withdrawableBps).toBe(7_500);
    expect(quote.vestingBps).toBe(2_500);
    expect(quote.lockedBps).toBe(0);
    expect(quote.closes).toBe(false);
    expect(quote.depositRefundLamports).toBeNull();

    const { groups, expectation, closes } = await buildWithdrawGroups(rpc, owner, t, 5_000, 100);
    expect(closes).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0].positionIds).toEqual([t.id]);
    const ixs = groups[0].instructions;
    expect(isCpAmm(ixs[0], "refresh_vesting")).toBe(true);
    expect(ixs[0].keys.slice(4).map((k) => k.pubkey.toBase58())).toEqual([chain.dammV2.variants.vested.vesting]);
    expect(cpAmmNames(ixs)).toEqual(["refresh_vesting", "claim_position_fee", "remove_liquidity"]);
    const remove = ixs.find((ix) => isCpAmm(ix, "remove_liquidity"))!;
    expect(u128(remove.data, 8).toString()).toBe(withdrawable.divn(2).toString());
    // Minimums match the quote and are non-zero.
    expect(quote.minimums.map((m) => m.atoms)).toEqual([u64(remove.data, 24).toString(), u64(remove.data, 32).toString()]);
    expect(u64(remove.data, 24).gtn(0) || u64(remove.data, 32).gtn(0)).toBe(true);
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);

    expect(expectation.kind).toBe("withdraw");
    // The pre-sign check holds the removal to exactly these values.
    expect(expectation.positions).toEqual([
      {
        position: t.position,
        nftAccount: t.positionNftAccount,
        protocol: "meteora-damm-v2",
        withdraw: {
          pool: t.pool,
          amount: withdrawable.divn(2).toString(),
          minimums: quote.minimums.map((m) => m.atoms),
          closes: false,
        },
      },
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("closes an unlocked position at 100%, showing the deposit refund", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "unlocked");
    const lamports = (a: string) => chain.accounts.get(a)!.lamports;

    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.closes).toBe(true);
    expect(quote.withdrawableBps).toBe(10_000);
    expect(quote.vestingBps).toBe(0);
    expect(quote.depositRefundLamports).toBe(
      String(lamports(t.position) + lamports(t.positionMint) + lamports(t.positionNftAccount)),
    );
    // Fees and the reward are claimed too; the reward ATA is new (Token, 165 bytes).
    expect(quote.fees.map((f) => [f.mint, f.atoms])).toEqual([
      [chain.mints.syna, D.feeAPending.toString()],
      [chain.mints.wsol, D.feeBAccrued.toString()],
      [chain.mints.reward, D.rewardPending.toString()],
    ]);
    expect(quote.rentLamports).toBe(String((165 + 128) * 6_960));
    const receiveA = quote.receive.find((r) => r.mint === chain.mints.syna)!;
    expect(receiveA.symbol).toBe("SYNA");
    expect(receiveA.decimals).toBe(9);

    const { groups, expectation, closes } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    expect(closes).toBe(true);
    const ixs = groups[0].instructions;
    expect(cpAmmNames(ixs)).toEqual(["claim_position_fee", "remove_all_liquidity", "claim_reward", "close_position"]);
    const removeAll = ixs.find((ix) => isCpAmm(ix, "remove_all_liquidity"))!;
    expect(quote.minimums.map((m) => m.atoms)).toEqual([u64(removeAll.data, 8).toString(), u64(removeAll.data, 16).toString()]);
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    expect(expectation.mints.map((m) => m.mint)).toContain(chain.mints.reward);
    expect(expectation.positions[0].withdraw).toEqual({
      pool: t.pool,
      amount: D.positionLiquidity.toString(),
      removeAll: true,
      minimums: quote.minimums.map((m) => m.atoms),
      closes: true,
    });
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("removes only the withdrawable part at 100% of a permanently locked position, without closing", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "locked");

    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.closes).toBe(false);
    expect(quote.withdrawableBps).toBe(5_000);
    expect(quote.vestingBps).toBe(0);
    expect(quote.lockedBps).toBe(5_000);

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    const ixs = groups[0].instructions;
    expect(cpAmmNames(ixs)).toEqual(["claim_position_fee", "remove_liquidity"]);
    expect(u128(ixs.find((ix) => isCpAmm(ix, "remove_liquidity"))!.data, 8).toString()).toBe(
      D.halfLiquidity.toString(),
    );
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("gives Token-2022 transfer-fee minimums net of the fee, minus the slippage", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "transferFee");
    const pool = cpAmmCoder.accounts.decode("Pool", chain.accounts.get(t.pool)!.data);
    const delta = D.positionLiquidity.divn(2);
    const grossA = getAmountAFromLiquidityDelta(pool.sqrt_price, pool.sqrt_max_price, delta, 1, 0, pool.token_a_amount, pool.liquidity);
    const grossB = getAmountBFromLiquidityDelta(pool.sqrt_min_price, pool.sqrt_price, delta, 1, 0, pool.token_b_amount, pool.liquidity);
    // 1% transfer fee, rounded up, capped at the maximum.
    const feeA = BN.min(grossA.muln(SYNTHETIC.transferFeeBps).addn(9_999).divn(10_000), new BN(SYNTHETIC.transferFeeMax));
    expect(feeA.gtn(0)).toBe(true);
    const slip = (n: BN) => n.muln(9_900).divn(10_000).toString();

    const quote = await quoteWithdraw(rpc, owner, t, 5_000, 100);
    expect(quote.minimums).toEqual([
      { mint: chain.mints.synt, symbol: "SYNT", decimals: 6, atoms: slip(grossA.sub(feeA)) },
      { mint: chain.mints.synb, symbol: "SYNB", decimals: 6, atoms: slip(grossB) },
    ]);

    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 5_000, 100);
    const remove = groups[0].instructions.find((ix) => isCpAmm(ix, "remove_liquidity"))!;
    expect([u64(remove.data, 24).toString(), u64(remove.data, 32).toString()]).toEqual([
      slip(grossA.sub(feeA)),
      slip(grossB),
    ]);
    expect(expectation.mints).toEqual(
      expect.arrayContaining([
        { mint: chain.mints.synt, tokenProgram: PROGRAM_IDS.token2022 },
        { mint: chain.mints.synb, tokenProgram: PROGRAM_IDS.token },
      ]),
    );
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("packs a full withdraw and close that refreshes a completed vesting", async () => {
    const chain = chainFixture();
    // After the last vesting period (cliff 1.7e9 + 4 × 1e9).
    setClock(chain, 6_000_000_000);
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "vested");

    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect([quote.withdrawableBps, quote.vestingBps, quote.closes]).toEqual([10_000, 0, true]);
    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    expect(cpAmmNames(groups[0].instructions)).toEqual([
      "refresh_vesting",
      "claim_position_fee",
      "remove_all_liquidity",
      "claim_reward",
      "close_position",
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it('quotes 0% withdrawable and refuses to build "Nothing to withdraw yet"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "locked");
    patchCpAmm(chain, t.position, "Position", (state) => {
      state.unlocked_liquidity = new BN(0);
    });
    const rpc = mockActionRpc(chain);
    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.withdrawableBps).toBe(0);
    expect(quote.closes).toBe(false);
    const build = buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    await expect(build).rejects.toBeInstanceOf(NothingToWithdrawError);
    await expect(build).rejects.toThrow("Nothing to withdraw yet");
  });

  it('refuses dust whose minimums both floor to 0 as "Amount too small to withdraw"', async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "unlocked");
    patchCpAmm(chain, t.position, "Position", (state) => {
      state.unlocked_liquidity = pow2(64);
    });
    const build = buildWithdrawGroups(mockActionRpc(chain), owner, t, 5_000, 100);
    await expect(build).rejects.toBeInstanceOf(AmountTooSmallError);
    await expect(build).rejects.toThrow("Amount too small to withdraw");
  });

  it("withdraws everything but keeps the position open when a reward vault is frozen", async () => {
    const chain = chainFixture();
    freezeRewardVault(chain);
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "unlocked");
    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect(quote.closes).toBe(false);
    expect(quote.depositRefundLamports).toBeNull();
    expect(quote.fees.map((f) => f.mint)).not.toContain(chain.mints.reward);
    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    const ixs = groups[0].instructions;
    expect(cpAmmNames(ixs)).toEqual(["claim_position_fee", "remove_liquidity"]);
    expect(u128(ixs.find((ix) => isCpAmm(ix, "remove_liquidity"))!.data, 8).toString()).toBe(
      D.positionLiquidity.toString(),
    );
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("releases fully elapsed inner vesting (no Vesting account) and closes at 100%", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "innerElapsed");
    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect([quote.withdrawableBps, quote.vestingBps, quote.closes]).toEqual([10_000, 0, true]);
    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    // The program releases inner vesting itself: no refresh_vesting.
    expect(cpAmmNames(groups[0].instructions)).toEqual([
      "claim_position_fee",
      "remove_all_liquidity",
      "claim_reward",
      "close_position",
    ]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("withdraws only the released part of partially elapsed inner vesting", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "innerPartial");
    // 2^103 unlocked + 3 × 2^100 released, of 2^104: 6875 / 3125 bps.
    const withdrawable = D.halfLiquidity.add(D.innerPartialReleasable);
    const quote = await quoteWithdraw(rpc, owner, t, 5_000, 100);
    expect([quote.withdrawableBps, quote.vestingBps, quote.closes]).toEqual([6_875, 3_125, false]);

    const half = await buildWithdrawGroups(rpc, owner, t, 5_000, 100);
    expect(cpAmmNames(half.groups[0].instructions)).toEqual(["claim_position_fee", "remove_liquidity"]);
    const remove = half.groups[0].instructions.find((ix) => isCpAmm(ix, "remove_liquidity"))!;
    expect(u128(remove.data, 8).toString()).toBe(withdrawable.divn(2).toString());
    expect(packAndVerify(chain, half.groups, half.expectation)).toEqual([{ ok: true }]);

    expect((await quoteWithdraw(rpc, owner, t, 10_000, 100)).closes).toBe(false);
    const all = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    expect(cpAmmNames(all.groups[0].instructions)).toEqual(["claim_position_fee", "remove_liquidity"]);
    expect(u128(all.groups[0].instructions.find((ix) => isCpAmm(ix, "remove_liquidity"))!.data, 8).toString()).toBe(
      withdrawable.toString(),
    );
  });

  it("closes at 100% when inner vesting released everything at its cliff (no per-period liquidity)", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "innerElapsed");
    // Periods still to come by the clock (cliff 1.7e9 + 4 × 1e8 > now), but
    // with 0 per period the cliff released the whole 2^103.
    patchCpAmm(chain, t.position, "Position", (state) => {
      state.inner_vesting = {
        ...state.inner_vesting,
        period_frequency: new BN(100_000_000),
        cliff_unlock_liquidity: D.halfLiquidity,
        liquidity_per_period: new BN(0),
        number_of_period: 4,
      };
    });
    const rpc = mockActionRpc(chain);
    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect([quote.withdrawableBps, quote.vestingBps, quote.closes]).toEqual([10_000, 0, true]);
    const { groups, expectation } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    expect(cpAmmNames(groups[0].instructions)).toContain("close_position");
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("quotes lockedBps 0 with nothing permanently locked, even when the shares are not whole bps", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "innerBeforeCliff");
    // A third unlocked, two thirds still vesting (before the cliff), nothing
    // locked: 3333 + 6666 = 9999 bps, yet lockedBps must be 0.
    const third = D.halfLiquidity.divn(3);
    patchCpAmm(chain, t.position, "Position", (state) => {
      state.unlocked_liquidity = third;
      state.vested_liquidity = third.muln(2);
    });
    const live = await quoteWithdraw(mockActionRpc(chain), owner, t, 10_000, 100);
    expect([live.withdrawableBps, live.vestingBps, live.lockedBps]).toEqual([3_333, 6_666, 0]);
  });

  it("releases nothing from inner vesting before its cliff", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "innerBeforeCliff");
    const quote = await quoteWithdraw(rpc, owner, t, 10_000, 100);
    expect([quote.withdrawableBps, quote.vestingBps, quote.closes]).toEqual([5_000, 5_000, false]);
    const { groups } = await buildWithdrawGroups(rpc, owner, t, 10_000, 100);
    expect(u128(groups[0].instructions.find((ix) => isCpAmm(ix, "remove_liquidity"))!.data, 8).toString()).toBe(
      D.halfLiquidity.toString(),
    );
  });

  it('refuses a deleted position with "Position no longer exists"', async () => {
    const chain = chainFixture();
    const t = target(chain, "unlocked");
    chain.accounts.delete(t.position);
    await expect(
      buildWithdrawGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t, 5_000, 100),
    ).rejects.toBeInstanceOf(PositionGoneError);
  });

  it("rejects out-of-range percentages and slippage", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const rpc = mockActionRpc(chain);
    const t = target(chain, "unlocked");
    await expect(buildWithdrawGroups(rpc, owner, t, 0, 100)).rejects.toThrow(RangeError);
    await expect(buildWithdrawGroups(rpc, owner, t, 10_001, 100)).rejects.toThrow(RangeError);
    await expect(buildWithdrawGroups(rpc, owner, t, 5_000, 501)).rejects.toThrow(RangeError);
    await expect(quoteWithdraw(rpc, owner, t, 2.5, 100)).rejects.toThrow(RangeError);
  });
});

describe("buildCloseGroups (Meteora DAMM v2)", () => {
  const empty = (chain: SyntheticChain, variant: Variant, extra: (s: Record<string, any>) => void = () => {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
    patchCpAmm(chain, chain.dammV2.variants[variant].position, "Position", (s) => {
      s.unlocked_liquidity = new BN(0);
      s.vested_liquidity = new BN(0);
      s.permanent_locked_liquidity = new BN(0);
      extra(s);
    });
  const lamports = (chain: SyntheticChain, v: DammV2Fixture) =>
    [v.position, v.positionNftAccount, v.positionMint].reduce((sum, a) => sum + chain.accounts.get(a)!.lamports, 0);

  it("collects the fees and rewards left in an empty position, then closes it, rent to the wallet", async () => {
    const chain = chainFixture();
    empty(chain, "unlocked");
    const owner = chain.owner.publicKey.toBase58();
    const t = target(chain, "unlocked");
    const { groups, expectation, refundLamports } = await buildCloseGroups(mockActionRpc(chain), owner, t);
    expect(groups).toHaveLength(1);
    expect(groups[0].positionIds).toEqual([t.id]);
    expect(groups[0].label).toBe("Close SYNA + SOL");
    const ixs = groups[0].instructions;
    expect(cpAmmNames(ixs)).toEqual(["claim_position_fee", "claim_reward", "close_position"]);
    const close = ixs.find((ix) => isCpAmm(ix, "close_position"))!;
    expect(close.keys[5].pubkey.toBase58()).toBe(owner); // rent_receiver
    expect(close.keys[1].pubkey.toBase58()).toBe(t.positionNftAccount);
    expect(isUnwrap(ixs.at(-1)!)).toBe(true);
    expect(refundLamports).toBe(String(lamports(chain, chain.dammV2.variants.unlocked)));
    expect(expectation).toEqual({
      kind: "close",
      owner,
      mints: expect.arrayContaining([
        { mint: chain.mints.syna, tokenProgram: PROGRAM_IDS.token },
        { mint: chain.mints.wsol, tokenProgram: PROGRAM_IDS.token },
        { mint: chain.mints.reward, tokenProgram: PROGRAM_IDS.token },
      ]),
      positions: [{ position: t.position, nftAccount: t.positionNftAccount, protocol: "meteora-damm-v2" }],
    });
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("only closes an empty position with nothing to collect: no token accounts, no unwrap", async () => {
    const chain = chainFixture();
    empty(chain, "noFees");
    const t = target(chain, "noFees");
    const { groups, expectation } = await buildCloseGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t);
    expect(groups[0].instructions.map((ix) => ix.programId.toBase58())).toEqual([CP_AMM]);
    expect(cpAmmNames(groups[0].instructions)).toEqual(["close_position"]);
    expect(expectation.mints).toEqual([]);
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("refreshes a fully released vesting account first (liquidity_per_period 0)", async () => {
    const chain = chainFixture();
    empty(chain, "vested", (s) => {
      s.fee_a_pending = new BN(0);
    });
    patchCpAmm(chain, chain.dammV2.variants.vested.vesting!, "Vesting", (s) => {
      s.inner_vesting.liquidity_per_period = new BN(0);
      s.inner_vesting.total_released_liquidity = s.inner_vesting.cliff_unlock_liquidity;
    });
    const t = target(chain, "vested");
    const { groups, expectation } = await buildCloseGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), t);
    const ixs = groups[0].instructions;
    expect(cpAmmNames(ixs)[0]).toBe("refresh_vesting");
    expect(cpAmmNames(ixs).at(-1)).toBe("close_position");
    expect(ixs[0].keys.slice(4).map((k) => k.pubkey.toBase58())).toEqual([chain.dammV2.variants.vested.vesting]);
    expect(cpAmmNames(ixs)).not.toContain("remove_liquidity");
    expect(cpAmmNames(ixs)).not.toContain("remove_all_liquidity");
    expect(packAndVerify(chain, groups, expectation)).toEqual([{ ok: true }]);
  });

  it("refuses a position that still holds liquidity, a lock or unreleased vesting", async () => {
    const chain = chainFixture();
    const rpc = mockActionRpc(chain);
    const owner = chain.owner.publicKey.toBase58();
    await expect(buildCloseGroups(rpc, owner, target(chain, "unlocked"))).rejects.toThrow(
      new PositionNotEmptyError("liquidity"),
    );
    patchCpAmm(chain, chain.dammV2.variants.locked.position, "Position", (s) => {
      s.unlocked_liquidity = new BN(0);
    });
    await expect(buildCloseGroups(rpc, owner, target(chain, "locked"))).rejects.toThrow(
      new PositionNotEmptyError("locked"),
    );
    patchCpAmm(chain, chain.dammV2.variants.vested.position, "Position", (s) => {
      s.unlocked_liquidity = new BN(0);
    });
    await expect(buildCloseGroups(rpc, owner, target(chain, "vested"))).rejects.toThrow(
      new PositionNotEmptyError("vesting"),
    );
    // No vesting liquidity on the position, but its vesting account has not released everything.
    empty(chain, "vested");
    await expect(buildCloseGroups(rpc, owner, target(chain, "vested"))).rejects.toBeInstanceOf(PositionNotEmptyError);
    expect(new PositionNotEmptyError("liquidity").message).toBe("This position still holds liquidity");
    expect(new PositionNotEmptyError("locked").message).toBe("Part of this position is locked for good");
    expect(new PositionNotEmptyError("vesting").message).toBe("Part of this position is still vesting");
  });

  it("refuses when a pending reward sits in a frozen vault, and when the position is gone", async () => {
    const chain = chainFixture();
    empty(chain, "unlocked");
    freezeRewardVault(chain);
    const owner = chain.owner.publicKey.toBase58();
    await expect(buildCloseGroups(mockActionRpc(chain), owner, target(chain, "unlocked"))).rejects.toThrow(
      new RewardsPausedError(),
    );
    expect(new RewardsPausedError().message).toBe("Rewards are paused by the pool");
    chain.accounts.delete(chain.dammV2.variants.noFees.position);
    await expect(buildCloseGroups(mockActionRpc(chain), owner, target(chain, "noFees"))).rejects.toBeInstanceOf(
      PositionGoneError,
    );
  });

  it("refuses CPMM and AMM v4 positions", async () => {
    const chain = chainFixture();
    const cpmm = { protocol: "raydium-cpmm", id: "c" } as FungibleTarget;
    await expect(buildCloseGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), cpmm)).rejects.toThrow(
      "close not supported",
    );
  });
});

describe("buildClaimGroups (Meteora DAMM v2): paused rewards", () => {
  it('skips a position whose only pending amount is in a frozen reward vault as "Rewards are paused by the pool"', async () => {
    const chain = chainFixture();
    const pool = cpAmmCoder.accounts.decode("Pool", chain.accounts.get(chain.dammV2.pool)!.data);
    patchCpAmm(chain, chain.dammV2.position, "Position", (s) => {
      s.fee_a_pending = new BN(0);
      s.fee_b_per_token_checkpoint = pool.fee_b_per_liquidity;
    });
    freezeRewardVault(chain);
    const t = target(chain, "unlocked");
    const { groups, skipped } = await buildClaimGroups(mockActionRpc(chain), chain.owner.publicKey.toBase58(), [t]);
    expect(groups).toEqual([]);
    expect(skipped).toEqual([{ positionId: t.id, reason: "Rewards are paused by the pool" }]);
  });
});

describe("unwrapsWrappedSol", () => {
  it("is true for a group that unwraps wSOL, and false otherwise", async () => {
    const chain = chainFixture();
    const owner = chain.owner.publicKey.toBase58();
    const wsol = await buildClaimGroups(mockActionRpc(chain), owner, [target(chain, "unlocked")]);
    const plain = await buildClaimGroups(mockActionRpc(chain), owner, [target(chain, "transferFee")]);
    expect(unwrapsWrappedSol(wsol.groups)).toBe(true);
    expect(unwrapsWrappedSol(plain.groups)).toBe(false);
    expect(unwrapsWrappedSol([])).toBe(false);
  });
});
