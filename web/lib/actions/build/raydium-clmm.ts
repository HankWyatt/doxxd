// Raydium CLMM claim (collect) and withdraw builders.
//
// Every number comes from live chain state read through the /api/rpc
// pass-through, never from DMND's snapshot or Raydium's HTTP API: the target
// only says where to look. Pool keys are rebuilt from the pool account (mints,
// vaults, reward slots), the mints' owners (token programs) and PDAs derived
// from the position (tick arrays, protocol position, bitmap extension).
// Instructions come from the SDK's low-level ClmmInstrument builders, which
// take the NFT account as given (the high-level ones assume the wallet's ATA
// of the NFT, which DMND's NFT account need not be). One group per position:
//   idempotent ATA creates (token A, token B and every reward mint whose
//   ATA does not exist yet),
//   decrease_liquidity_v2, [close_position], then the wSOL unwrap (Token
//   CloseAccount of the wallet's wSOL ATA, to the wallet).
// A claim is decrease_liquidity_v2(liquidity 0, minimums 0): the program
// collects the position's fees and every reward with it.
//
// RPC methods used (all allowed by lib/rpc/policy.ts):
// - getMultipleAccounts: pools, positions, NFT accounts and mints, then tick
//   arrays and token mints, then the wallet's ATAs of those mints;
// - getEpochInfo: the epoch that picks a Token-2022 transfer fee (withdraws);
// - getMinimumBalanceForRentExemption: rent of ATAs a withdraw creates.
// The SDK helpers used make no RPC or HTTP calls: ClmmInstrument's
// decreaseLiquidityV2Instruction and closePositionInstruction, the getPda*
// derivations, PoolUtil.isOverflowDefaultTickarrayBitmap, TickArrayUtil,
// TickUtil.getSqrtPriceAtTick, LiquidityMathUtil.getAmountsForLiquidity,
// PositionUtils.GetPositionFees / GetPositionRewards, and the account layouts.
import {
  ClmmInstrument,
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress,
  getPdaTickArrayAddress,
  LiquidityMathUtil,
  PersonalPositionLayout,
  PoolInfoLayout,
  PoolUtil,
  PositionUtils,
  TickArrayLayout,
  TickArrayUtil,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  calculateEpochFee,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { GroupTooLargeError, partitionGroups, type InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import { ACTION_PROGRAM_IDS, type ClmmTarget } from "../types";
import type { Expectation } from "../verify";
import {
  ataSize,
  attempt,
  checkShare,
  GONE,
  isAddress,
  MISMATCH,
  readAccounts,
  type ClaimBuild,
  type LiveMint,
} from "./meteora-damm-v2";
import {
  AmountTooSmallError,
  NothingToWithdrawError,
  PositionGoneError,
  type SkipReason,
  type TokenAmount,
  type WithdrawQuote,
} from "./quote";

const CLMM = new PublicKey(ACTION_PROGRAM_IDS["raydium-clmm"]);
const BPS = 10_000;

// Anchor account discriminators: sha256("account:<Name>")[..8]. The SDK's
// layouts skip these bytes, so they are checked here.
const POOL_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]); // PoolState
const POSITION_DISCRIMINATOR = Buffer.from([70, 111, 150, 126, 230, 15, 25, 117]); // PersonalPositionState
const TICK_ARRAY_DISCRIMINATOR = Buffer.from([192, 155, 85, 205, 49, 249, 129, 42]); // TickArrayState

type Account = AccountInfo<Buffer>;
type PoolState = ReturnType<typeof PoolInfoLayout.decode>;
type PositionState = ReturnType<typeof PersonalPositionLayout.decode>;
type TickState = ReturnType<typeof TickArrayLayout.decode>["ticks"][number];

/** A pool reward slot the program pays out with every decrease. */
type Reward = { mint: LiveMint; vault: PublicKey; growthGlobalX64: BN };

type Live = {
  target: ClmmTarget;
  pool: PoolState;
  position: PositionState;
  mintA: LiveMint;
  mintB: LiveMint;
  /** The pool's initialized reward slots, in slot order. */
  rewards: Reward[];
  tickArrayLower: PublicKey;
  tickArrayUpper: PublicKey;
  tickLower: TickState;
  tickUpper: TickState;
  /** The tick-array bitmap extension, when a tick array lies beyond the pool's default bitmap. */
  bitmapExtension: PublicKey | null;
  nftMint: PublicKey;
  nftProgram: PublicKey;
  /** Lamports closing returns: the position, the NFT account and (Token-2022) the NFT mint. */
  closeLamports: number;
};

type Loaded = { ok: true; live: Live } | { ok: false; reason: SkipReason };

// --- Reading ---------------------------------------------------------------

/** A CLMM program account's state, or null unless its owner, size and discriminator match. */
function decodeClmm<T>(
  info: Account | null | undefined,
  layout: { span: number; decode(data: Buffer): T },
  discriminator: Buffer,
): T | null {
  if (!info || !info.owner.equals(CLMM) || info.data.length !== layout.span) return null;
  if (!info.data.subarray(0, 8).equals(discriminator)) return null;
  return attempt(() => layout.decode(info.data));
}

/** The mint at `address` with its live token program, or null. */
function liveMint(address: PublicKey, info: Account | null | undefined): LiveMint | null {
  if (!info) return null;
  const program = info.owner.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : info.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : null;
  if (!program) return null;
  const mint = attempt(() => unpackMint(address, info, program));
  return mint && { address, program, mint };
}

/**
 * The pool's initialized reward slots (mint and vault set), or null when
 * they are not a prefix of the slots: decrease_liquidity_v2 takes one triple
 * per initialized slot and pairs the i-th triple with slot i.
 */
function rewardSlots(pool: PoolState): PoolState["rewardInfos"] | null {
  const initialized = pool.rewardInfos.map((r) => !r.mint.equals(PublicKey.default) && !r.vault.equals(PublicKey.default));
  const count = initialized.filter(Boolean).length;
  if (initialized.slice(0, count).some((ok) => !ok)) return null;
  return pool.rewardInfos.slice(0, count);
}

type Read = {
  target: ClmmTarget;
  pool: PoolState;
  position: PositionState;
  slots: PoolState["rewardInfos"];
  starts: [number, number];
  tickArrays: [PublicKey, PublicKey];
  nftMint: PublicKey;
  nftProgram: PublicKey;
  closeLamports: number;
};

/**
 * Reads each target's live pool, position, NFT account and NFT mint in one
 * batch, then the tick arrays and token mints in a second. Each target's own
 * problems become its skip reason:
 * - "Position no longer exists": no position account, or the NFT account is
 *   gone or no longer holds the position's NFT for this wallet;
 * - "Position data doesn't match the pool · skipped": a malformed address, an
 *   unexpected program, a position that is not the PDA of the NFT mint or of
 *   another pool, or a pool, tick array, mint or NFT account whose bytes are
 *   not what they should be.
 */
async function loadPositions(rpc: ActionRpc, owner: PublicKey, targets: ClmmTarget[]): Promise<Loaded[]> {
  // A row with a malformed address is skipped before the read, so it cannot
  // fail the batch.
  const keysOf = (t: ClmmTarget) => [t.pool, t.position, t.positionNftAccount, t.positionMint];
  const wellFormed = targets.map((t) => keysOf(t).every(isAddress));
  const accounts = await readAccounts(
    rpc,
    targets.flatMap((t, i) => (wellFormed[i] ? keysOf(t) : [])),
  );

  const read = targets.map((target, i): { ok: true; read: Read } | { ok: false; reason: SkipReason } => {
    if (!wellFormed[i] || target.program !== CLMM.toBase58()) return { ok: false, reason: MISMATCH };
    const nftMint = new PublicKey(target.positionMint);
    if (getPdaPersonalPositionAddress(CLMM, nftMint).publicKey.toBase58() !== target.position)
      return { ok: false, reason: MISMATCH };
    const positionInfo = accounts.get(target.position);
    if (!positionInfo) return { ok: false, reason: GONE };
    const position = decodeClmm(positionInfo, PersonalPositionLayout, POSITION_DISCRIMINATOR);
    if (!position || position.poolId.toBase58() !== target.pool || !position.nftMint.equals(nftMint))
      return { ok: false, reason: MISMATCH };

    const nftInfo = accounts.get(target.positionNftAccount);
    if (!nftInfo) return { ok: false, reason: GONE };
    const nftProgram = nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID) || nftInfo.owner.equals(TOKEN_PROGRAM_ID) ? nftInfo.owner : null;
    const nft = nftProgram && attempt(() => unpackAccount(new PublicKey(target.positionNftAccount), nftInfo, nftProgram));
    const mintInfo = accounts.get(target.positionMint);
    if (!nft || !nftProgram || !nft.mint.equals(nftMint) || !mintInfo || !mintInfo.owner.equals(nftProgram))
      return { ok: false, reason: MISMATCH };
    if (!nft.owner.equals(owner) || nft.amount !== BigInt(1)) return { ok: false, reason: GONE };

    const pool = decodeClmm(accounts.get(target.pool), PoolInfoLayout, POOL_DISCRIMINATOR);
    const slots = pool && rewardSlots(pool);
    if (!pool || !slots || pool.tickSpacing === 0) return { ok: false, reason: MISMATCH };
    const { tickLower, tickUpper } = position;
    const ticksValid =
      TickUtil.isValidTick(tickLower) &&
      TickUtil.isValidTick(tickUpper) &&
      tickLower < tickUpper &&
      tickLower % pool.tickSpacing === 0 &&
      tickUpper % pool.tickSpacing === 0;
    if (!ticksValid) return { ok: false, reason: MISMATCH };
    const starts: [number, number] = [
      TickArrayUtil.getTickArrayStartIndex(tickLower, pool.tickSpacing),
      TickArrayUtil.getTickArrayStartIndex(tickUpper, pool.tickSpacing),
    ];
    const poolKey = new PublicKey(target.pool);
    const tickArrays: [PublicKey, PublicKey] = [
      getPdaTickArrayAddress(CLMM, poolKey, starts[0]).publicKey,
      getPdaTickArrayAddress(CLMM, poolKey, starts[1]).publicKey,
    ];
    // Closing returns the position's and NFT account's rent; Token-2022 NFT
    // mints are closed too (their close authority is the position).
    const closeLamports =
      positionInfo.lamports + nftInfo.lamports + (nftProgram.equals(TOKEN_2022_PROGRAM_ID) ? mintInfo.lamports : 0);
    return { ok: true, read: { target, pool, position, slots, starts, tickArrays, nftMint, nftProgram, closeLamports } };
  });

  const second = await readAccounts(
    rpc,
    read.flatMap((r) =>
      r.ok
        ? [
            ...r.read.tickArrays.map(String),
            r.read.pool.mintA.toBase58(),
            r.read.pool.mintB.toBase58(),
            ...r.read.slots.map((s) => s.mint.toBase58()),
          ]
        : [],
    ),
  );
  const mintOf = (address: PublicKey) => liveMint(address, second.get(address.toBase58()));
  const tickOf = (r: Read, side: 0 | 1, tick: number): TickState | null => {
    const array = decodeClmm(second.get(r.tickArrays[side].toBase58()), TickArrayLayout, TICK_ARRAY_DISCRIMINATOR);
    if (!array || array.poolId.toBase58() !== r.target.pool || array.startTickIndex !== r.starts[side]) return null;
    return array.ticks[TickArrayUtil.getTickOffsetInArray(tick, r.pool.tickSpacing)] ?? null;
  };

  return read.map((r): Loaded => {
    if (!r.ok) return r;
    const { read: x } = r;
    const mintA = mintOf(x.pool.mintA);
    const mintB = mintOf(x.pool.mintB);
    const rewards = x.slots.map((s) => {
      const mint = mintOf(s.mint);
      return mint && { mint, vault: s.vault, growthGlobalX64: s.growthGlobalX64 };
    });
    const tickLower = tickOf(x, 0, x.position.tickLower);
    const tickUpper = tickOf(x, 1, x.position.tickUpper);
    if (!mintA || !mintB || !tickLower || !tickUpper || rewards.some((reward) => !reward))
      return { ok: false, reason: MISMATCH };
    const overflows = PoolUtil.isOverflowDefaultTickarrayBitmap({ tickSpacing: x.pool.tickSpacing, tickIndexs: x.starts });
    return {
      ok: true,
      live: {
        target: x.target,
        pool: x.pool,
        position: x.position,
        mintA,
        mintB,
        rewards: rewards as Reward[],
        tickArrayLower: x.tickArrays[0],
        tickArrayUpper: x.tickArrays[1],
        tickLower,
        tickUpper,
        bitmapExtension: overflows ? getPdaExBitmapAccount(CLMM, new PublicKey(x.target.pool)).publicKey : null,
        nftMint: x.nftMint,
        nftProgram: x.nftProgram,
        closeLamports: x.closeLamports,
      },
    };
  });
}

// --- Assembling ------------------------------------------------------------

/** Token A, token B and every reward mint, without repeats. */
function paidMints(live: Live): LiveMint[] {
  const out = new Map<string, LiveMint>();
  for (const mint of [live.mintA, live.mintB, ...live.rewards.map((r) => r.mint)])
    if (!out.has(mint.address.toBase58())) out.set(mint.address.toBase58(), mint);
  return [...out.values()];
}

const ataOf = (wallet: PublicKey, mint: LiveMint) =>
  getAssociatedTokenAddressSync(mint.address, wallet, false, mint.program);

/**
 * The wallet's ATAs (of `lives`' paid mints) that need no create: an
 * initialized token account the mint's token program owns, of that mint,
 * whose owner field is the wallet. Anything else keeps its idempotent
 * create, which fails safely on an account that is not the wallet's (ruling
 * R-T9b). The wSOL ATA is never "existing": every group that unwraps it
 * closes it, so the next group must create it again.
 */
async function existingAtas(rpc: ActionRpc, wallet: PublicKey, lives: Live[]): Promise<Set<string>> {
  const mints = new Map<string, LiveMint>();
  for (const mint of lives.flatMap(paidMints)) mints.set(ataOf(wallet, mint).toBase58(), mint);
  const accounts = await readAccounts(rpc, [...mints.keys()]);
  const out = new Set<string>();
  for (const [ata, mint] of mints) {
    const info = accounts.get(ata);
    if (mint.address.equals(NATIVE_MINT) || !info || !info.owner.equals(mint.program)) continue;
    // Lamports sent to an ATA address do not make it a token account, and a
    // token account whose owner was reassigned is not the wallet's.
    const account = attempt(() => unpackAccount(new PublicKey(ata), info, mint.program));
    if (account && account.isInitialized && account.owner.equals(wallet) && account.mint.equals(mint.address))
      out.add(ata);
  }
  return out;
}

/** True when `group` fits one transaction, sized exactly as packGroups sizes it. */
function fitsAlone(wallet: PublicKey, group: InstructionGroup): boolean {
  try {
    partitionGroups([group], wallet);
    return true;
  } catch (error) {
    if (error instanceof GroupTooLargeError) return false;
    throw error;
  }
}

/**
 * One position's group: idempotent ATA creates for the paid mints whose ATA
 * is not in `existing` (ruling R-T9a: creates for existing ATAs cost bytes
 * the largest groups do not have), the decrease (liquidity 0 and minimums 0
 * collect fees and rewards), the close when asked, then the wSOL unwrap.
 */
function positionInstructions(
  wallet: PublicKey,
  live: Live,
  existing: Set<string>,
  liquidity: BN,
  minimums: [BN, BN],
  close: boolean,
): TransactionInstruction[] {
  const { target, pool, position } = live;
  const poolKey = new PublicKey(target.pool);
  const nftAccount = new PublicKey(target.positionNftAccount);
  const personalPosition = new PublicKey(target.position);
  const mints = paidMints(live);
  const creates = mints
    .filter((mint) => !existing.has(ataOf(wallet, mint).toBase58()))
    .map((mint) =>
      createAssociatedTokenAccountIdempotentInstruction(wallet, ataOf(wallet, mint), wallet, mint.address, mint.program),
    );
  const decrease = ClmmInstrument.decreaseLiquidityV2Instruction(
    CLMM,
    wallet,
    nftAccount,
    personalPosition,
    poolKey,
    getPdaProtocolPositionAddress(CLMM, poolKey, position.tickLower, position.tickUpper).publicKey,
    live.tickArrayLower,
    live.tickArrayUpper,
    ataOf(wallet, live.mintA),
    ataOf(wallet, live.mintB),
    pool.vaultA,
    pool.vaultB,
    pool.mintA,
    pool.mintB,
    live.rewards.map((r) => ({
      poolRewardVault: r.vault,
      ownerRewardVault: ataOf(wallet, r.mint),
      rewardMint: r.mint.address,
    })),
    liquidity,
    minimums[0],
    minimums[1],
    live.bitmapExtension ?? undefined,
  );
  const closeIxs = close
    ? [
        ClmmInstrument.closePositionInstruction(
          CLMM,
          wallet,
          live.nftMint,
          nftAccount,
          personalPosition,
          live.nftProgram.equals(TOKEN_2022_PROGRAM_ID),
          poolKey,
        ),
      ]
    : [];
  const unwraps = mints
    .filter((mint) => mint.address.equals(NATIVE_MINT))
    .map((mint) => createCloseAccountInstruction(ataOf(wallet, mint), wallet, wallet, [], mint.program));
  return [...creates, decrease, ...closeIxs, ...unwraps];
}

const legLabel = (leg: ClmmTarget["tokenA"]) => leg.symbol ?? `${leg.mint.slice(0, 4)}…`;
const pair = (t: ClmmTarget) => `${legLabel(t.tokenA)} + ${legLabel(t.tokenB)}`;

function mintExpectations(lives: Live[]): Expectation["mints"] {
  const out = new Map<string, string>();
  for (const mint of lives.flatMap(paidMints))
    if (!out.has(mint.address.toBase58())) out.set(mint.address.toBase58(), mint.program.toBase58());
  return [...out].map(([mint, tokenProgram]) => ({ mint, tokenProgram }));
}

const positionExpectation = (t: ClmmTarget): Expectation["positions"][number] => ({
  position: t.position,
  nftAccount: t.positionNftAccount,
  protocol: "raydium-clmm",
});

// --- Claim -----------------------------------------------------------------

/**
 * One collect group per live position. Nothing is pre-computed: a position
 * with nothing to collect still gets a group, and the runner's simulation
 * reports "Nothing to claim". Targets repeating an earlier id are ignored.
 */
export async function buildClmmClaimGroups(
  rpc: ActionRpc,
  owner: string,
  requested: ClmmTarget[],
): Promise<ClaimBuild> {
  const seen = new Set<string>();
  const targets = requested.filter((t) => !seen.has(t.id) && seen.add(t.id));
  const wallet = new PublicKey(owner);
  const loaded = await loadPositions(rpc, wallet, targets);
  const existing = await existingAtas(
    rpc,
    wallet,
    loaded.flatMap((r) => (r.ok ? [r.live] : [])),
  );

  const groups: InstructionGroup[] = [];
  const skipped: ClaimBuild["skipped"] = [];
  const built: Live[] = [];
  const zero = new BN(0);
  for (const [i, result] of loaded.entries()) {
    const target = targets[i];
    if (!result.ok) {
      skipped.push({ positionId: target.id, reason: result.reason });
      continue;
    }
    groups.push({
      positionIds: [target.id],
      instructions: positionInstructions(wallet, result.live, existing, zero, [zero, zero], false),
      label: `Claim ${pair(target)}`,
    });
    built.push(result.live);
  }
  return {
    groups,
    skipped,
    expectation: {
      kind: "claim",
      owner,
      mints: mintExpectations(built),
      positions: built.map((l) => positionExpectation(l.target)),
    },
  };
}

// --- Withdraw --------------------------------------------------------------

type WithdrawPlan = {
  quote: WithdrawQuote;
  live: Live;
  liquidity: BN;
  minimums: [BN, BN];
  /** The wallet's ATAs that already exist (no create is built for them). */
  existing: Set<string>;
};

/**
 * Live withdraw state for `bps` of the position's liquidity (CLMM positions
 * have no locks or vesting: all of it is withdrawable).
 * - Liquidity removed: floor(L × bps / 10,000).
 * - Principal: the SDK's getAmountsForLiquidity at the pool's live sqrt
 *   price over the position's tick range, rounded down as the program does.
 * - Minimums: principal net of any Token-2022 transfer fee (current epoch),
 *   minus the slippage allowance, floored.
 * - Fees and rewards: what the decrease pays out besides the principal,
 *   from the pool's and ticks' growth (PositionUtils). Reward growth is the
 *   pool's as last stored, so rewards are a lower bound; the simulation
 *   shows the exact figures.
 */
async function planWithdraw(
  rpc: ActionRpc,
  owner: string,
  target: ClmmTarget,
  bps: number,
  slippageBps: number,
): Promise<WithdrawPlan> {
  const wallet = new PublicKey(owner);
  const [result] = await loadPositions(rpc, wallet, [target]);
  if (!result.ok) {
    if (result.reason === GONE) throw new PositionGoneError();
    throw new Error("Position data doesn't match the pool");
  }
  const live = result.live;
  const { pool, position, mintA, mintB } = live;
  const { epoch } = await rpc.connection.getEpochInfo("confirmed");

  const liquidity = position.liquidity.muln(bps).divn(BPS);
  const out = LiquidityMathUtil.getAmountsForLiquidity(
    pool.sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(position.tickLower),
    TickUtil.getSqrtPriceAtTick(position.tickUpper),
    liquidity,
    false,
  );
  const net = (mint: LiveMint, amount: BN): BN => {
    const config = getTransferFeeConfig(mint.mint);
    if (!config) return amount;
    const fee = calculateEpochFee(config, BigInt(epoch), BigInt(amount.toString()));
    return amount.sub(new BN(fee.toString()));
  };
  const slip = (amount: BN) => amount.muln(BPS - slippageBps).divn(BPS);
  const minimums: [BN, BN] = [slip(net(mintA, out.amountA)), slip(net(mintB, out.amountB))];

  const fees = PositionUtils.GetPositionFees(pool, position, live.tickLower, live.tickUpper);
  const rewardOwed = PositionUtils.GetPositionRewards(
    { tickCurrent: pool.tickCurrent, rewardInfos: live.rewards },
    position,
    live.tickLower,
    live.tickUpper,
  );

  // Amounts by mint, in order: token A, token B, then reward mints. A reward
  // paid in token A or B adds to that entry; zero rewards are left out.
  const amounts = () => new Map<string, { mint: LiveMint; atoms: BN }>();
  const add = (into: ReturnType<typeof amounts>, mint: LiveMint, atoms: BN, keepZero: boolean) => {
    const key = mint.address.toBase58();
    const entry = into.get(key);
    if (entry) entry.atoms = entry.atoms.add(atoms);
    else if (keepZero || !atoms.isZero()) into.set(key, { mint, atoms });
  };
  const receive = amounts();
  const feeAmounts = amounts();
  // Principal and fees of a leg leave the vault in one transfer.
  add(receive, mintA, net(mintA, out.amountA.add(fees.tokenFeeAmountA)), true);
  add(receive, mintB, net(mintB, out.amountB.add(fees.tokenFeeAmountB)), true);
  add(feeAmounts, mintA, net(mintA, fees.tokenFeeAmountA), true);
  add(feeAmounts, mintB, net(mintB, fees.tokenFeeAmountB), true);
  live.rewards.forEach((reward, i) => {
    const atoms = net(reward.mint, rewardOwed[i]);
    add(receive, reward.mint, atoms, false);
    add(feeAmounts, reward.mint, atoms, false);
  });
  const amount = (mint: LiveMint, atoms: BN): TokenAmount => {
    const address = mint.address.toBase58();
    const leg = [target.tokenA, target.tokenB].find((l) => l.mint === address);
    return { mint: address, symbol: leg?.symbol ?? null, decimals: mint.mint.decimals, atoms: atoms.toString() };
  };
  const list = (m: ReturnType<typeof amounts>) => [...m.values()].map((e) => amount(e.mint, e.atoms));

  // Rent for ATAs the transaction creates and keeps (a wSOL ATA is closed
  // again): exactly the creates the group will carry.
  const existing = await existingAtas(rpc, wallet, [live]);
  const missing = paidMints(live).filter(
    (m) => !m.address.equals(NATIVE_MINT) && !existing.has(ataOf(wallet, m).toBase58()),
  );
  const rents = await Promise.all(
    missing.map((m) => rpc.connection.getMinimumBalanceForRentExemption(ataSize(m), "confirmed")),
  );

  // At 100% the group also closes the position, unless that no longer fits
  // one transaction (bitmap extension plus three new reward ATAs, ruling
  // R-T9a): then it withdraws everything and collects, and the empty
  // position stays open. Quote and build share this decision.
  const hasLiquidity = !position.liquidity.isZero();
  const closes =
    bps === BPS &&
    hasLiquidity &&
    fitsAlone(wallet, {
      positionIds: [target.id],
      instructions: positionInstructions(wallet, live, existing, liquidity, minimums, true),
      label: "",
    });
  return {
    quote: {
      receive: list(receive),
      fees: list(feeAmounts),
      minimums: [amount(mintA, minimums[0]), amount(mintB, minimums[1])],
      closes,
      depositRefundLamports: closes ? String(live.closeLamports) : null,
      rentLamports: String(rents.reduce((a, b) => a + b, 0)),
      withdrawableBps: hasLiquidity ? BPS : 0,
      vestingBps: 0,
    },
    live,
    liquidity,
    minimums,
    existing,
  };
}

/** A live quote for withdrawing `bps` (0–10,000) of the position's liquidity. */
export async function quoteClmmWithdraw(
  rpc: ActionRpc,
  owner: string,
  target: ClmmTarget,
  bps: number,
  slippageBps: number,
): Promise<WithdrawQuote> {
  checkShare(bps, slippageBps, 0);
  return (await planWithdraw(rpc, owner, target, bps, slippageBps)).quote;
}

/**
 * One group that withdraws `bps` (1–10,000) of the position's liquidity:
 * decrease_liquidity_v2(floor(L × bps / 10,000), the quote's minimums),
 * which also pays out the fees and rewards; at 100%, close_position then
 * burns the NFT and returns the position's rent, when the group still fits
 * one transaction (the quote's `closes`).
 * Throws NothingToWithdrawError, AmountTooSmallError or PositionGoneError.
 */
export async function buildClmmWithdrawGroups(
  rpc: ActionRpc,
  owner: string,
  target: ClmmTarget,
  bps: number,
  slippageBps: number,
): Promise<{ groups: InstructionGroup[]; expectation: Expectation; closes: boolean }> {
  checkShare(bps, slippageBps, 1);
  const plan = await planWithdraw(rpc, owner, target, bps, slippageBps);
  if (plan.live.position.liquidity.isZero()) throw new NothingToWithdrawError();
  const [minA, minB] = plan.minimums;
  if (plan.liquidity.isZero() || (minA.isZero() && minB.isZero())) throw new AmountTooSmallError();

  const wallet = new PublicKey(owner);
  return {
    groups: [
      {
        positionIds: [target.id],
        instructions: positionInstructions(wallet, plan.live, plan.existing, plan.liquidity, plan.minimums, plan.quote.closes),
        label: `Withdraw ${pair(target)}`,
      },
    ],
    expectation: {
      kind: "withdraw",
      owner,
      mints: mintExpectations([plan.live]),
      positions: [positionExpectation(target)],
    },
    closes: plan.quote.closes,
  };
}
