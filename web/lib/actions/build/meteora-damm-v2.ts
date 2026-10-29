// Meteora DAMM v2 (cp-amm) claim and withdraw builders.
//
// Every number comes from live chain state read through the /api/rpc
// pass-through, never from DMND's snapshot: the target only says where to
// look. Instructions come from @meteora-ag/cp-amm-sdk's own builders; this
// file only orders them into one group per position:
//   [refresh_vesting], idempotent ATA creates, cp-amm instructions in the
//   SDK's order, then the wSOL unwrap (Token CloseAccount to the owner).
//
// RPC methods used (all allowed by lib/rpc/policy.ts):
// - getMultipleAccounts: pools, positions, NFT accounts, Clock, mints, ATAs;
// - getProgramAccounts: a position's vesting accounts, with the pass-through's
//   exact filter shape (ruling R-P2; the SDK's getAllVestingsByPosition adds
//   a filter the pass-through refuses);
// - getMinimumBalanceForRentExemption: rent of ATAs a withdraw creates.
// The SDK builders used here (claimPositionFee2, claimReward, removeLiquidity,
// removeAllLiquidityAndClosePosition, refreshVesting) make no RPC calls of
// their own: their ATA helper builds idempotent creates without reading the
// chain. getCurrentPoint is not used (it calls getBlockTime); the Clock
// sysvar gives the slot, epoch and time instead.
import {
  CpAmm,
  calculateTransferFeeExcludedAmount,
  getAvailableVestingLiquidity,
  getTokenProgram,
  getUnClaimLpFee,
  isVestingComplete,
  type PoolState,
  type PositionState,
  type VestingState,
} from "@meteora-ag/cp-amm-sdk";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  unpackAccount,
  unpackMint,
  type Mint,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type AccountInfo,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { VESTING_POSITION_OFFSET, VESTING_SIZE } from "@/lib/rpc/policy";
import type { InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import { ACTION_PROGRAM_IDS, type DammV2Target } from "../types";
import type { Expectation } from "../verify";
import {
  AmountTooSmallError,
  NothingToWithdrawError,
  PositionGoneError,
  type SkipReason,
  type TokenAmount,
  type WithdrawQuote,
} from "./quote";

const CP_AMM = new PublicKey(ACTION_PROGRAM_IDS["meteora-damm-v2"]);
const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
const BPS = 10_000;
/** Largest price-move limit the dialog offers (5%). */
export const MAX_SLIPPAGE_BPS = 500;
/** lib/rpc/policy.ts MAX_ACCOUNTS. */
const MAX_ACCOUNTS_PER_READ = 100;
const ZERO = new BN(0);

type Account = AccountInfo<Buffer>;
type Clock = { slot: BN; epoch: number; unixTimestamp: BN };
type LiveMint = { address: PublicKey; program: PublicKey; mint: Mint };

type Live = {
  target: DammV2Target;
  pool: PoolState;
  position: PositionState;
  /** Lamports of the position, its NFT mint and NFT account (what closing returns). */
  closeLamports: number;
};

type Loaded =
  | { ok: true; live: Live }
  | { ok: false; reason: SkipReason };

// --- Reading ---------------------------------------------------------------

/** Reads `keys` with as few getMultipleAccounts calls as the pass-through allows. */
async function readAccounts(rpc: ActionRpc, keys: string[]): Promise<Map<string, Account | null>> {
  const unique = [...new Set(keys)];
  const out = new Map<string, Account | null>();
  for (let i = 0; i < unique.length; i += MAX_ACCOUNTS_PER_READ) {
    const chunk = unique.slice(i, i + MAX_ACCOUNTS_PER_READ);
    const infos = await rpc.connection.getMultipleAccountsInfo(
      chunk.map((k) => new PublicKey(k)),
      "confirmed",
    );
    chunk.forEach((k, j) => out.set(k, infos[j] ?? null));
  }
  return out;
}

// Clock sysvar: slot u64, epoch_start_timestamp i64, epoch u64,
// leader_schedule_epoch u64, unix_timestamp i64 (little-endian).
function decodeClock(info: Account | null | undefined): Clock {
  if (!info || info.owner.toBase58() !== SYSVAR_OWNER || info.data.length < 40)
    throw new Error("Could not read the cluster clock.");
  return {
    slot: new BN(info.data.readBigUInt64LE(0).toString()),
    epoch: Number(info.data.readBigUInt64LE(16)),
    unixTimestamp: new BN(info.data.readBigInt64LE(32).toString()),
  };
}

/** The point cp-amm measures vesting in: slot or unix time, per the pool. */
function currentPoint(pool: PoolState, clock: Clock): BN {
  if (pool.activationType === 0) return clock.slot;
  if (pool.activationType === 1) return clock.unixTimestamp;
  throw new Error("Unknown pool activation type.");
}

function checkTarget(target: DammV2Target) {
  if (target.program !== CP_AMM.toBase58())
    throw new Error("This position names an unexpected program.");
}

/**
 * Reads the live pool, position and position NFT account of each target (and
 * the Clock) in one batch. A missing position, or an NFT account the wallet
 * no longer holds, means the position is gone for this wallet.
 */
async function loadPositions(
  cpAmm: CpAmm,
  rpc: ActionRpc,
  owner: PublicKey,
  targets: DammV2Target[],
): Promise<{ loaded: Loaded[]; clock: Clock }> {
  targets.forEach(checkTarget);
  const accounts = await readAccounts(rpc, [
    SYSVAR_CLOCK_PUBKEY.toBase58(),
    ...targets.flatMap((t) => [t.pool, t.position, t.positionNftAccount, t.positionMint]),
  ]);
  const clock = decodeClock(accounts.get(SYSVAR_CLOCK_PUBKEY.toBase58()));
  const coder = cpAmm._program.coder.accounts;
  const loaded = targets.map((target): Loaded => {
    const positionInfo = accounts.get(target.position);
    if (!positionInfo || !positionInfo.owner.equals(CP_AMM))
      return { ok: false, reason: "Position no longer exists" };
    const position = coder.decode<PositionState>("position", positionInfo.data);
    if (position.pool.toBase58() !== target.pool || position.nftMint.toBase58() !== target.positionMint)
      throw new Error("The position does not match its pool.");

    const nftInfo = accounts.get(target.positionNftAccount);
    if (!nftInfo || !(nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID) || nftInfo.owner.equals(TOKEN_PROGRAM_ID)))
      return { ok: false, reason: "Position no longer exists" };
    const nft = unpackAccount(new PublicKey(target.positionNftAccount), nftInfo, nftInfo.owner);
    if (!nft.mint.equals(position.nftMint) || !nft.owner.equals(owner) || nft.amount !== BigInt(1))
      return { ok: false, reason: "Position no longer exists" };

    const poolInfo = accounts.get(target.pool);
    if (!poolInfo || !poolInfo.owner.equals(CP_AMM)) throw new Error("Could not read the pool.");
    const pool = coder.decode<PoolState>("pool", poolInfo.data);
    const closeLamports =
      positionInfo.lamports + nftInfo.lamports + (accounts.get(target.positionMint)?.lamports ?? 0);
    return { ok: true, live: { target, pool, position, closeLamports } };
  });
  return { loaded, clock };
}

const initializedRewards = (pool: PoolState) =>
  pool.rewardInfos.flatMap((info, index) => (info.initialized ? [{ index, info }] : []));

/**
 * Reads the mints of `pools` (token A and B, initialized rewards), checking
 * each against the token program the pool records for it.
 */
async function loadMints(rpc: ActionRpc, pools: PoolState[]): Promise<Map<string, LiveMint>> {
  const wanted = new Map<string, PublicKey>();
  for (const pool of pools) {
    wanted.set(pool.tokenAMint.toBase58(), getTokenProgram(pool.tokenAFlag));
    wanted.set(pool.tokenBMint.toBase58(), getTokenProgram(pool.tokenBFlag));
    for (const { info } of initializedRewards(pool))
      wanted.set(info.mint.toBase58(), getTokenProgram(info.rewardTokenFlag));
  }
  const accounts = await readAccounts(rpc, [...wanted.keys()]);
  const out = new Map<string, LiveMint>();
  for (const [address, program] of wanted) {
    const info = accounts.get(address);
    if (!info || !info.owner.equals(program)) throw new Error("A pool token is not what the pool records.");
    const key = new PublicKey(address);
    out.set(address, { address: key, program, mint: unpackMint(key, info, program) });
  }
  return out;
}

/**
 * The position's vesting accounts, through the pass-through's one allowed
 * getProgramAccounts shape. Only read when the position has vesting
 * liquidity: otherwise refresh_vesting would release nothing.
 */
async function loadVestings(
  cpAmm: CpAmm,
  rpc: ActionRpc,
  live: Live,
): Promise<{ account: PublicKey; vestingState: VestingState }[]> {
  if (live.position.vestedLiquidity.isZero()) return [];
  const found = await rpc.connection.getProgramAccounts(CP_AMM, {
    commitment: "confirmed",
    filters: [
      { dataSize: VESTING_SIZE },
      { memcmp: { offset: VESTING_POSITION_OFFSET, bytes: live.target.position } },
    ],
  });
  const coder = cpAmm._program.coder.accounts;
  return found
    .map(({ pubkey, account }) => ({
      account: pubkey,
      vestingState: coder.decode<VestingState>("vesting", account.data),
    }))
    .filter((v) => v.vestingState.position.toBase58() === live.target.position)
    .sort((a, b) => a.account.toBase58().localeCompare(b.account.toBase58()));
}

// --- Assembling ------------------------------------------------------------

/**
 * One group's instructions from the SDK's transactions: `first`, then each
 * distinct ATA create, then the protocol instructions in order, then each
 * distinct wSOL unwrap. The SDK puts an unwrap after every builder's
 * instructions; one at the very end unwraps everything the group paid out.
 */
function assemble(first: TransactionInstruction[], parts: Transaction[]): TransactionInstruction[] {
  const creates = new Map<string, TransactionInstruction>();
  const unwraps = new Map<string, TransactionInstruction>();
  const body: TransactionInstruction[] = [];
  for (const ix of parts.flatMap((tx) => tx.instructions)) {
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const ata = ix.keys[1].pubkey.toBase58();
      if (!creates.has(ata)) creates.set(ata, ix);
    } else if (
      ix.programId.equals(TOKEN_PROGRAM_ID) &&
      ix.data.length === 1 &&
      ix.data[0] === TokenInstruction.CloseAccount
    ) {
      unwraps.set(ix.keys[0].pubkey.toBase58(), ix);
    } else body.push(ix);
  }
  return [...first, ...creates.values(), ...body, ...unwraps.values()];
}

const legLabel = (leg: DammV2Target["tokenA"]) => leg.symbol ?? `${leg.mint.slice(0, 4)}…`;
const pair = (t: DammV2Target) => `${legLabel(t.tokenA)} + ${legLabel(t.tokenB)}`;

function mintExpectations(mints: Map<string, LiveMint>, addresses: string[]): Expectation["mints"] {
  return [...new Set(addresses)].map((mint) => ({ mint, tokenProgram: mints.get(mint)!.program.toBase58() }));
}

const positionExpectation = (t: DammV2Target): Expectation["positions"][number] => ({
  position: t.position,
  nftAccount: t.positionNftAccount,
  protocol: "meteora-damm-v2",
});

function feeAccounts(live: Live, mints: Map<string, LiveMint>) {
  const { pool, target } = live;
  return {
    pool: new PublicKey(target.pool),
    position: new PublicKey(target.position),
    positionNftAccount: new PublicKey(target.positionNftAccount),
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAProgram: mints.get(pool.tokenAMint.toBase58())!.program,
    tokenBProgram: mints.get(pool.tokenBMint.toBase58())!.program,
  };
}

// --- Claim -----------------------------------------------------------------

export type ClaimBuild = {
  groups: InstructionGroup[];
  skipped: { positionId: string; reason: SkipReason }[];
  expectation: Expectation;
};

/**
 * One group per position with something claimable live: fees (always
 * claimed together) and each initialized reward slot with a pending amount.
 */
export async function buildDammV2ClaimGroups(
  rpc: ActionRpc,
  owner: string,
  targets: DammV2Target[],
): Promise<ClaimBuild> {
  const wallet = new PublicKey(owner);
  const cpAmm = new CpAmm(rpc.connection);
  const { loaded, clock } = await loadPositions(cpAmm, rpc, wallet, targets);
  const lives = loaded.flatMap((l) => (l.ok ? [l.live] : []));
  const mints = await loadMints(rpc, lives.map((l) => l.pool));

  const groups: InstructionGroup[] = [];
  const skipped: ClaimBuild["skipped"] = [];
  const expectedMints: string[] = [];
  const positions: Expectation["positions"] = [];
  for (const [i, result] of loaded.entries()) {
    const target = targets[i];
    if (!result.ok) {
      skipped.push({ positionId: target.id, reason: result.reason });
      continue;
    }
    const live = result.live;
    const pending = getUnClaimLpFee(live.pool, live.position, clock.unixTimestamp);
    const rewards = initializedRewards(live.pool).filter(({ index }) => pending.rewards[index].gt(ZERO));
    if (pending.feeTokenA.isZero() && pending.feeTokenB.isZero() && rewards.length === 0) {
      skipped.push({ positionId: target.id, reason: "Nothing to claim" });
      continue;
    }
    const fee = await cpAmm.claimPositionFee2({ owner: wallet, receiver: wallet, ...feeAccounts(live, mints) });
    const rewardTxs = [];
    for (const { index } of rewards)
      rewardTxs.push(
        await cpAmm.claimReward({
          user: wallet,
          position: new PublicKey(target.position),
          positionNftAccount: new PublicKey(target.positionNftAccount),
          poolState: live.pool,
          positionState: live.position,
          rewardIndex: index,
          isSkipReward: false,
        }),
      );
    groups.push({
      positionIds: [target.id],
      instructions: assemble([], [fee, ...rewardTxs]),
      label: `Claim ${pair(target)}`,
    });
    expectedMints.push(
      live.pool.tokenAMint.toBase58(),
      live.pool.tokenBMint.toBase58(),
      ...rewards.map(({ info }) => info.mint.toBase58()),
    );
    positions.push(positionExpectation(target));
  }
  return {
    groups,
    skipped,
    expectation: { kind: "claim", owner, mints: mintExpectations(mints, expectedMints), positions },
  };
}

// --- Withdraw --------------------------------------------------------------

function checkShare(bps: number, slippageBps: number, min: number) {
  if (!Number.isInteger(bps) || bps < min || bps > BPS) throw new RangeError(`bps must be an integer from ${min} to ${BPS}.`);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS)
    throw new RangeError(`slippageBps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}.`);
}

const toBps = (part: BN, total: BN) => (total.isZero() ? 0 : part.muln(BPS).div(total).toNumber());

/** Size of the wallet's ATA for `mint`: the mint's account extensions, plus ImmutableOwner on Token-2022. */
function ataSize(mint: LiveMint): number {
  if (!mint.program.equals(TOKEN_2022_PROGRAM_ID)) return ACCOUNT_SIZE;
  const extensions = getExtensionTypes(mint.mint.tlvData)
    .map(getAccountTypeOfMintType)
    .filter((t) => t !== ExtensionType.Uninitialized);
  return getAccountLen([...new Set([...extensions, ExtensionType.ImmutableOwner])]);
}

/**
 * Whether removeAllLiquidityAndClosePosition claims reward slot `index`: the
 * same test as the SDK's buildLiquidatePositionInstruction
 * (dist/index.js:12037-12050), which skips a fully settled slot the position
 * has nothing in.
 */
function closeClaimsReward(pool: PoolState, position: PositionState, index: number): boolean {
  const info = pool.rewardInfos[index];
  const mine = position.rewardInfos[index];
  const settled = info.rewardDurationEnd.lte(info.lastUpdateTime);
  const nothing =
    mine.rewardPendings.isZero() &&
    Buffer.from(mine.rewardPerTokenCheckpoint).equals(Buffer.from(info.rewardPerTokenStored));
  return !(settled && nothing);
}

type WithdrawPlan = {
  quote: WithdrawQuote;
  live: Live;
  mints: Map<string, LiveMint>;
  vestings: { account: PublicKey; vestingState: VestingState }[];
  point: BN;
  withdrawable: BN;
  liquidityDelta: BN;
  minimums: [BN, BN];
  /** Reward mints the transaction may pay out. */
  rewardMints: string[];
};

/**
 * Live withdraw state for `bps` of the withdrawable liquidity.
 *
 * Withdrawable = unlocked + vesting releasable now, mirroring cp-amm's
 * refresh_vesting: each vesting account releases
 *   cliff_unlock + min((now − cliff_point) / period_frequency, periods) × per_period
 *   − already_released
 * once now ≥ cliff_point (the SDK's getAvailableVestingLiquidity), where
 * "now" is the pool's activation point type (slot or unix time) from the
 * Clock sysvar. Liquidity removed is withdrawable × bps / 10,000.
 */
async function planWithdraw(
  rpc: ActionRpc,
  owner: string,
  target: DammV2Target,
  bps: number,
  slippageBps: number,
): Promise<WithdrawPlan> {
  const wallet = new PublicKey(owner);
  const cpAmm = new CpAmm(rpc.connection);
  const {
    loaded: [result],
    clock,
  } = await loadPositions(cpAmm, rpc, wallet, [target]);
  if (!result.ok) throw new PositionGoneError();
  const live = result.live;
  const { pool, position } = live;
  const [mints, vestings] = await Promise.all([loadMints(rpc, [pool]), loadVestings(cpAmm, rpc, live)]);
  const point = currentPoint(pool, clock);

  const available = vestings.reduce((sum, v) => sum.add(getAvailableVestingLiquidity(v.vestingState, point)), new BN(0));
  const releasable = BN.min(available, position.vestedLiquidity);
  const withdrawable = position.unlockedLiquidity.add(releasable);
  const stillVesting = position.vestedLiquidity.sub(releasable);
  const total = position.unlockedLiquidity.add(position.vestedLiquidity).add(position.permanentLockedLiquidity);
  const liquidityDelta = withdrawable.muln(bps).divn(BPS);
  const closes =
    bps === BPS &&
    !withdrawable.isZero() &&
    position.permanentLockedLiquidity.isZero() &&
    stillVesting.isZero() &&
    vestings.every((v) => isVestingComplete(v.vestingState, point));

  const mintA = mints.get(pool.tokenAMint.toBase58())!;
  const mintB = mints.get(pool.tokenBMint.toBase58())!;
  const out = liquidityDelta.isZero()
    ? { outAmountA: new BN(0), outAmountB: new BN(0) }
    : cpAmm.getWithdrawQuote({
        liquidityDelta,
        sqrtPrice: pool.sqrtPrice,
        minSqrtPrice: pool.sqrtMinPrice,
        maxSqrtPrice: pool.sqrtMaxPrice,
        tokenATokenInfo: { mint: mintA.mint, currentEpoch: clock.epoch },
        tokenBTokenInfo: { mint: mintB.mint, currentEpoch: clock.epoch },
        collectFeeMode: pool.collectFeeMode,
        tokenAAmount: pool.tokenAAmount,
        tokenBAmount: pool.tokenBAmount,
        liquidity: pool.liquidity,
      });
  const slip = (amount: BN) => amount.muln(BPS - slippageBps).divn(BPS);
  const minimums: [BN, BN] = [slip(out.outAmountA), slip(out.outAmountB)];

  // Fees are always claimed with a withdrawal; rewards only when it closes.
  const pending = getUnClaimLpFee(pool, position, clock.unixTimestamp);
  const net = (amount: BN, mint: LiveMint) => calculateTransferFeeExcludedAmount(amount, mint.mint, clock.epoch).amount;
  const rewards = closes ? initializedRewards(pool).filter(({ index }) => closeClaimsReward(pool, position, index)) : [];
  const amount = (mint: LiveMint, atoms: BN): TokenAmount => {
    const address = mint.address.toBase58();
    const leg = [target.tokenA, target.tokenB].find((l) => l.mint === address);
    return { mint: address, symbol: leg?.symbol ?? null, decimals: mint.mint.decimals, atoms: atoms.toString() };
  };
  const feeA = net(pending.feeTokenA, mintA);
  const feeB = net(pending.feeTokenB, mintB);
  const rewardAmounts = rewards
    .map(({ index, info }) => {
      const mint = mints.get(info.mint.toBase58())!;
      return amount(mint, net(pending.rewards[index], mint));
    })
    .filter((r) => r.atoms !== "0");
  const fees = [amount(mintA, feeA), amount(mintB, feeB), ...rewardAmounts];
  const receive = [amount(mintA, out.outAmountA.add(feeA)), amount(mintB, out.outAmountB.add(feeB)), ...rewardAmounts];

  // Rent for ATAs the transaction creates and keeps (a wSOL ATA is closed again).
  const rewardMints = rewards.map(({ info }) => info.mint.toBase58());
  const paid = [...new Set([mintA.address.toBase58(), mintB.address.toBase58(), ...rewardMints])]
    .map((m) => mints.get(m)!)
    .filter((m) => !m.address.equals(NATIVE_MINT));
  const atas = await readAccounts(
    rpc,
    paid.map((m) => getAssociatedTokenAddressSync(m.address, wallet, true, m.program).toBase58()),
  );
  const missing = paid.filter((m) => !atas.get(getAssociatedTokenAddressSync(m.address, wallet, true, m.program).toBase58()));
  const rents = await Promise.all(missing.map((m) => rpc.connection.getMinimumBalanceForRentExemption(ataSize(m), "confirmed")));

  return {
    quote: {
      receive,
      fees,
      minimums: [amount(mintA, minimums[0]), amount(mintB, minimums[1])],
      closes,
      depositRefundLamports: closes ? String(live.closeLamports) : null,
      rentLamports: String(rents.reduce((a, b) => a + b, 0)),
      withdrawableBps: toBps(withdrawable, total),
      vestingBps: toBps(stillVesting, total),
    },
    live,
    mints,
    vestings,
    point,
    withdrawable,
    liquidityDelta,
    minimums,
    rewardMints,
  };
}

/** A live quote for withdrawing `bps` (0–10,000) of the withdrawable liquidity. */
export async function quoteDammV2Withdraw(
  rpc: ActionRpc,
  owner: string,
  target: DammV2Target,
  bps: number,
  slippageBps: number,
): Promise<WithdrawQuote> {
  checkShare(bps, slippageBps, 0);
  return (await planWithdraw(rpc, owner, target, bps, slippageBps)).quote;
}

/**
 * One group that withdraws `bps` (1–10,000) of the withdrawable liquidity:
 * - partial: [refresh_vesting], claim fees, remove_liquidity(withdrawable ×
 *   bps / 10,000) with the quote's minimums;
 * - 100% with nothing locked or left vesting: [refresh_vesting], then the
 *   SDK's removeAllLiquidityAndClosePosition (claim fees, remove all, claim
 *   rewards, close the position).
 * Throws NothingToWithdrawError, AmountTooSmallError or PositionGoneError.
 */
export async function buildDammV2WithdrawGroups(
  rpc: ActionRpc,
  owner: string,
  target: DammV2Target,
  bps: number,
  slippageBps: number,
): Promise<{ groups: InstructionGroup[]; expectation: Expectation }> {
  checkShare(bps, slippageBps, 1);
  const plan = await planWithdraw(rpc, owner, target, bps, slippageBps);
  if (plan.withdrawable.isZero()) throw new NothingToWithdrawError();
  const [minA, minB] = plan.minimums;
  if (plan.liquidityDelta.isZero() || (minA.isZero() && minB.isZero())) throw new AmountTooSmallError();

  const wallet = new PublicKey(owner);
  const cpAmm = new CpAmm(rpc.connection);
  const { live, mints, vestings, point } = plan;
  const accounts = feeAccounts(live, mints);
  // The SDK builders get no vestings: refresh_vesting is built once, first.
  const first = vestings.length
    ? (
        await cpAmm.refreshVesting({
          owner: wallet,
          position: accounts.position,
          positionNftAccount: accounts.positionNftAccount,
          pool: accounts.pool,
          vestingAccounts: vestings.map((v) => v.account),
        })
      ).instructions
    : [];
  const parts = plan.quote.closes
    ? [
        await cpAmm.removeAllLiquidityAndClosePosition({
          owner: wallet,
          position: accounts.position,
          positionNftAccount: accounts.positionNftAccount,
          poolState: live.pool,
          positionState: live.position,
          tokenAAmountThreshold: minA,
          tokenBAmountThreshold: minB,
          vestings: [],
          currentPoint: point,
          isSkipReward: false,
        }),
      ]
    : [
        await cpAmm.claimPositionFee2({ owner: wallet, receiver: wallet, ...accounts }),
        await cpAmm.removeLiquidity({
          owner: wallet,
          ...accounts,
          liquidityDelta: plan.liquidityDelta,
          tokenAAmountThreshold: minA,
          tokenBAmountThreshold: minB,
          vestings: [],
          currentPoint: point,
        }),
      ];
  return {
    groups: [{ positionIds: [target.id], instructions: assemble(first, parts), label: `Withdraw ${pair(target)}` }],
    expectation: {
      kind: "withdraw",
      owner,
      mints: mintExpectations(mints, [
        live.pool.tokenAMint.toBase58(),
        live.pool.tokenBMint.toBase58(),
        ...plan.rewardMints,
      ]),
      positions: [positionExpectation(target)],
    },
  };
}
