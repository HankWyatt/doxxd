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
export type LiveMint = { address: PublicKey; program: PublicKey; mint: Mint };

/** A pool's live token mints, and the reward slots that cannot pay out now. */
type PoolTokens = {
  mints: Map<string, LiveMint>;
  /** Initialized reward slots whose vault is frozen, unreadable or not as the pool records. */
  unclaimableRewards: Set<number>;
};

type Live = {
  target: DammV2Target;
  pool: PoolState;
  position: PositionState;
  tokens: PoolTokens;
  /** Lamports of the position, its NFT mint and NFT account (what closing returns). */
  closeLamports: number;
};

type Loaded = { ok: true; live: Live } | { ok: false; reason: SkipReason };

export const GONE: SkipReason = "Position no longer exists";
export const MISMATCH: SkipReason = "Position data doesn't match the pool · skipped";

// --- Reading ---------------------------------------------------------------

/** Reads `keys` with as few getMultipleAccounts calls as the pass-through allows. */
export async function readAccounts(rpc: ActionRpc, keys: string[]): Promise<Map<string, Account | null>> {
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

/** True for a base58 string that is a 32-byte public key. */
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && attempt(() => new PublicKey(value)) !== null;
}

/** `parse()`, or null when the bytes do not decode. */
export function attempt<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

const initializedRewards = (pool: PoolState) =>
  pool.rewardInfos.flatMap((info, index) => (info.initialized ? [{ index, info }] : []));

/**
 * The live mints of each pool (token A and B, initialized rewards) and the
 * state of its reward vaults, in one batch. A pool whose A or B mint is
 * missing or not under the token program the pool records maps to null. A
 * reward slot whose mint or vault is unusable, or whose vault is frozen, is
 * unclaimable: claim_reward would fail and revert its whole group.
 */
async function loadPoolTokens(rpc: ActionRpc, pools: PoolState[]): Promise<Map<PoolState, PoolTokens | null>> {
  const keys = pools.flatMap((pool) => [
    pool.tokenAMint.toBase58(),
    pool.tokenBMint.toBase58(),
    ...initializedRewards(pool).flatMap(({ info }) => [info.mint.toBase58(), info.vault.toBase58()]),
  ]);
  const accounts = await readAccounts(rpc, keys);
  const liveMint = (mint: PublicKey, program: PublicKey): LiveMint | null => {
    const info = accounts.get(mint.toBase58());
    if (!info || !info.owner.equals(program)) return null;
    const parsed = attempt(() => unpackMint(mint, info, program));
    return parsed && { address: mint, program, mint: parsed };
  };
  const out = new Map<PoolState, PoolTokens | null>();
  for (const pool of pools) {
    const a = liveMint(pool.tokenAMint, getTokenProgram(pool.tokenAFlag));
    const b = liveMint(pool.tokenBMint, getTokenProgram(pool.tokenBFlag));
    if (!a || !b) {
      out.set(pool, null);
      continue;
    }
    const mints = new Map([
      [a.address.toBase58(), a],
      [b.address.toBase58(), b],
    ]);
    const unclaimableRewards = new Set<number>();
    for (const { index, info } of initializedRewards(pool)) {
      const program = getTokenProgram(info.rewardTokenFlag);
      const mint = liveMint(info.mint, program);
      const vaultInfo = accounts.get(info.vault.toBase58());
      const vault =
        vaultInfo && vaultInfo.owner.equals(program) ? attempt(() => unpackAccount(info.vault, vaultInfo, program)) : null;
      if (!mint || !vault || !vault.mint.equals(info.mint) || vault.isFrozen) unclaimableRewards.add(index);
      else mints.set(mint.address.toBase58(), mint);
    }
    out.set(pool, { mints, unclaimableRewards });
  }
  return out;
}

/**
 * Reads the live pool, position and position NFT account of each target (and
 * the Clock) in one batch, then the pools' tokens. Only an unreadable Clock
 * fails the whole read; each target's own problems become its skip reason:
 * - "Position no longer exists": no position account, or the NFT account is
 *   gone or no longer holds the position's NFT for this wallet;
 * - "Position data doesn't match the pool · skipped": an unexpected program,
 *   a position of another pool or NFT, or a pool, mint or NFT account whose
 *   bytes are not what they should be.
 */
async function loadPositions(
  cpAmm: CpAmm,
  rpc: ActionRpc,
  owner: PublicKey,
  targets: DammV2Target[],
): Promise<{ loaded: Loaded[]; clock: Clock }> {
  // A row with a malformed address is skipped before the read, so it cannot
  // fail the batch.
  const keysOf = (t: DammV2Target) => [t.pool, t.position, t.positionNftAccount, t.positionMint];
  const wellFormed = targets.map((t) => keysOf(t).every(isAddress));
  const accounts = await readAccounts(rpc, [
    SYSVAR_CLOCK_PUBKEY.toBase58(),
    ...targets.flatMap((t, i) => (wellFormed[i] ? keysOf(t) : [])),
  ]);
  const clock = decodeClock(accounts.get(SYSVAR_CLOCK_PUBKEY.toBase58()));
  const coder = cpAmm._program.coder.accounts;
  const pools = new Map<string, PoolState | null>();
  const poolState = (address: string): PoolState | null => {
    if (!pools.has(address)) {
      const info = accounts.get(address);
      pools.set(
        address,
        info && info.owner.equals(CP_AMM) ? attempt(() => coder.decode<PoolState>("pool", info.data)) : null,
      );
    }
    return pools.get(address)!;
  };

  type Read = Omit<Live, "tokens">;
  const read = targets.map((target, i): { ok: true; live: Read } | { ok: false; reason: SkipReason } => {
    if (!wellFormed[i] || target.program !== CP_AMM.toBase58()) return { ok: false, reason: MISMATCH };
    const positionInfo = accounts.get(target.position);
    if (!positionInfo) return { ok: false, reason: GONE };
    const position = positionInfo.owner.equals(CP_AMM)
      ? attempt(() => coder.decode<PositionState>("position", positionInfo.data))
      : null;
    if (!position) return { ok: false, reason: MISMATCH };
    if (position.pool.toBase58() !== target.pool || position.nftMint.toBase58() !== target.positionMint)
      return { ok: false, reason: MISMATCH };

    const nftInfo = accounts.get(target.positionNftAccount);
    if (!nftInfo) return { ok: false, reason: GONE };
    const nft =
      nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID) || nftInfo.owner.equals(TOKEN_PROGRAM_ID)
        ? attempt(() => unpackAccount(new PublicKey(target.positionNftAccount), nftInfo, nftInfo.owner))
        : null;
    if (!nft || !nft.mint.equals(position.nftMint)) return { ok: false, reason: MISMATCH };
    if (!nft.owner.equals(owner) || nft.amount !== BigInt(1)) return { ok: false, reason: GONE };

    const pool = poolState(target.pool);
    if (!pool) return { ok: false, reason: MISMATCH };
    const closeLamports =
      positionInfo.lamports + nftInfo.lamports + (accounts.get(target.positionMint)?.lamports ?? 0);
    return { ok: true, live: { target, pool, position, closeLamports } };
  });

  const tokens = await loadPoolTokens(
    rpc,
    [...new Set(read.flatMap((r) => (r.ok ? [r.live.pool] : [])))],
  );
  const loaded = read.map((r): Loaded => {
    if (!r.ok) return r;
    const poolTokens = tokens.get(r.live.pool);
    return poolTokens ? { ok: true, live: { ...r.live, tokens: poolTokens } } : { ok: false, reason: MISMATCH };
  });
  return { loaded, clock };
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

function mintExpectations(lives: Live[], addresses: string[]): Expectation["mints"] {
  const program = (mint: string) =>
    lives.map((l) => l.tokens.mints.get(mint)).find((m) => m)!.program.toBase58();
  return [...new Set(addresses)].map((mint) => ({ mint, tokenProgram: program(mint) }));
}

const positionExpectation = (t: DammV2Target): Expectation["positions"][number] => ({
  position: t.position,
  nftAccount: t.positionNftAccount,
  protocol: "meteora-damm-v2",
});

function feeAccounts(live: Live) {
  const { pool, target, tokens } = live;
  return {
    pool: new PublicKey(target.pool),
    position: new PublicKey(target.position),
    positionNftAccount: new PublicKey(target.positionNftAccount),
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAProgram: tokens.mints.get(pool.tokenAMint.toBase58())!.program,
    tokenBProgram: tokens.mints.get(pool.tokenBMint.toBase58())!.program,
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
 * claimed together) and each initialized reward slot with a pending amount
 * whose vault can pay out. Targets repeating an earlier id are ignored.
 */
export async function buildDammV2ClaimGroups(
  rpc: ActionRpc,
  owner: string,
  requested: DammV2Target[],
): Promise<ClaimBuild> {
  const seen = new Set<string>();
  const targets = requested.filter((t) => !seen.has(t.id) && seen.add(t.id));
  const wallet = new PublicKey(owner);
  const cpAmm = new CpAmm(rpc.connection);
  const { loaded, clock } = await loadPositions(cpAmm, rpc, wallet, targets);

  const groups: InstructionGroup[] = [];
  const skipped: ClaimBuild["skipped"] = [];
  const built: Live[] = [];
  const expectedMints: string[] = [];
  for (const [i, result] of loaded.entries()) {
    const target = targets[i];
    if (!result.ok) {
      skipped.push({ positionId: target.id, reason: result.reason });
      continue;
    }
    const live = result.live;
    const pending = getUnClaimLpFee(live.pool, live.position, clock.unixTimestamp);
    const rewards = initializedRewards(live.pool).filter(
      ({ index }) => pending.rewards[index].gt(ZERO) && !live.tokens.unclaimableRewards.has(index),
    );
    if (pending.feeTokenA.isZero() && pending.feeTokenB.isZero() && rewards.length === 0) {
      skipped.push({ positionId: target.id, reason: "Nothing to claim" });
      continue;
    }
    const fee = await cpAmm.claimPositionFee2({ owner: wallet, receiver: wallet, ...feeAccounts(live) });
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
    built.push(live);
    expectedMints.push(
      live.pool.tokenAMint.toBase58(),
      live.pool.tokenBMint.toBase58(),
      ...rewards.map(({ info }) => info.mint.toBase58()),
    );
  }
  return {
    groups,
    skipped,
    expectation: {
      kind: "claim",
      owner,
      mints: mintExpectations(built, expectedMints),
      positions: built.map((l) => positionExpectation(l.target)),
    },
  };
}

// --- Withdraw --------------------------------------------------------------

export function checkShare(bps: number, slippageBps: number, min: number) {
  if (!Number.isInteger(bps) || bps < min || bps > BPS) throw new RangeError(`bps must be an integer from ${min} to ${BPS}.`);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS)
    throw new RangeError(`slippageBps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}.`);
}

const toBps = (part: BN, total: BN) => (total.isZero() ? 0 : part.muln(BPS).div(total).toNumber());

/** Size of the wallet's ATA for `mint`: the mint's account extensions, plus ImmutableOwner on Token-2022. */
export function ataSize(mint: LiveMint): number {
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
 * Withdrawable = unlocked + vesting releasable now. Vesting comes in two
 * places, both released by the program before it removes liquidity:
 * - Vesting accounts, released by refresh_vesting (built first);
 * - the position's own inner_vesting (DBC migrations), which
 *   remove_liquidity and remove_all_liquidity release themselves
 *   (refresh_inner_vesting), so it needs no instruction.
 * Each schedule releases
 *   cliff_unlock + min((now − cliff_point) / period_frequency, periods) × per_period
 *   − already_released
 * once now ≥ cliff_point (the SDK's getAvailableVestingLiquidity, which
 * reads only `innerVesting`), where "now" is the pool's activation point
 * type (slot or unix time) from the Clock sysvar. An empty (all-zero) inner
 * schedule releases 0. Liquidity removed is withdrawable × bps / 10,000.
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
  if (!result.ok) {
    if (result.reason === GONE) throw new PositionGoneError();
    throw new Error("Position data doesn't match the pool");
  }
  const live = result.live;
  const { pool, position } = live;
  const mints = live.tokens.mints;
  const vestings = await loadVestings(cpAmm, rpc, live);
  const point = currentPoint(pool, clock);

  // getAvailableVestingLiquidity reads only `innerVesting`.
  const schedules = [
    ...vestings.map((v) => v.vestingState),
    { innerVesting: position.innerVesting } as unknown as VestingState,
  ];
  const available = schedules.reduce((sum, v) => sum.add(getAvailableVestingLiquidity(v, point)), new BN(0));
  const releasable = BN.min(available, position.vestedLiquidity);
  const withdrawable = position.unlockedLiquidity.add(releasable);
  const stillVesting = position.vestedLiquidity.sub(releasable);
  const total = position.unlockedLiquidity.add(position.vestedLiquidity).add(position.permanentLockedLiquidity);
  const liquidityDelta = withdrawable.muln(bps).divn(BPS);
  // Closing claims every reward slot the SDK picks; one it cannot pay out
  // (frozen vault) would revert the close, and skipping it would forfeit the
  // rewards, so such a position is withdrawn but kept open.
  const closeRewards = initializedRewards(pool).filter(({ index }) => closeClaimsReward(pool, position, index));
  const closes =
    bps === BPS &&
    !withdrawable.isZero() &&
    position.permanentLockedLiquidity.isZero() &&
    stillVesting.isZero() &&
    // Vesting accounts must have run their course (the SDK's own close check,
    // canUnlockPosition). The inner schedule is gated by stillVesting alone:
    // the program releases it in remove_all_liquidity and resets it once
    // nothing is left to vest, even with periods still nominally to come
    // (e.g. liquidity_per_period = 0).
    vestings.every((v) => isVestingComplete(v.vestingState, point)) &&
    closeRewards.every(({ index }) => !live.tokens.unclaimableRewards.has(index));

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
  const rewards = closes ? closeRewards : [];
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
      // Floored: a sliver of permanent lock may read 0, but 0 never stands
      // for floored rounding of the other two shares (ruling R-F1).
      lockedBps: toBps(position.permanentLockedLiquidity, total),
    },
    live,
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
): Promise<{ groups: InstructionGroup[]; expectation: Expectation; closes: boolean }> {
  checkShare(bps, slippageBps, 1);
  const plan = await planWithdraw(rpc, owner, target, bps, slippageBps);
  if (plan.withdrawable.isZero()) throw new NothingToWithdrawError();
  const [minA, minB] = plan.minimums;
  if (plan.liquidityDelta.isZero() || (minA.isZero() && minB.isZero())) throw new AmountTooSmallError();

  const wallet = new PublicKey(owner);
  const cpAmm = new CpAmm(rpc.connection);
  const { live, vestings, point } = plan;
  const accounts = feeAccounts(live);
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
      mints: mintExpectations([live], [
        live.pool.tokenAMint.toBase58(),
        live.pool.tokenBMint.toBase58(),
        ...plan.rewardMints,
      ]),
      positions: [positionExpectation(target)],
    },
    closes: plan.quote.closes,
  };
}
