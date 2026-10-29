// Raydium AMM v4 withdraw builder (no claim: fees are inside the LP tokens).
//
// Every number comes from live chain state read through the /api/rpc
// pass-through, never from DMND's snapshot or Raydium's HTTP API. Pool keys
// are rebuilt from the AMM state account and the AMM authority:
// create_program_address(["amm authority", nonce]) with the pool's stored
// nonce, as the program checks it (processor.rs:1656). The group (see
// ./fungible.ts): idempotent ATA creates, withdraw (tag 4), then the wSOL
// unwrap. The withdraw takes one of the two account forms the pre-sign check
// allows (lib/actions/programs.ts):
// - pools created without an OpenBook market (market program = the default
//   key; process_initialize2 stores open orders and the market program as
//   the default key since "Remove openbook dependency (#69)",
//   processor.rs:972-974): the 11-account form the program recommends,
//   built here in the order process_withdraw reads it (processor.rs:1561-1590);
// - pools with a market: the SDK's 22-account form, with the market account
//   read and checked, and its vault signer derived as
//   create_program_address([market, vault_signer_nonce as u64 LE]) under the
//   market's program. The program reads the 11-account form for these pools
//   too, but only since #69 (2026-07-23; its parent c613c87 accepts 20-23
//   accounts only), while the 22-account form works before and after it.
//
// The withdraw mirrors raydium-amm's program/src/processor.rs
// process_withdraw (master 91739d8, :1543-1800):
// - totals = vault amount − need_take_pnl, per side
//   (calc_total_without_take_pnl_no_orderbook, math.rs:238): the current
//   program no longer counts OpenBook open-orders balances, and its 22-account
//   form ignores the market accounts (they are `_`-prefixed and unread);
// - out = floor(total × lp / amm.lp_amount) (InvariantPool::
//   exchange_pool_to_token, Floor, math.rs:435);
// - a zero output on either leg fails (InvalidInput);
// - the minimums are checked against those outputs (ExceededSlippage);
// - only Token (not Token-2022) mints and status with withdraw permission
//   (AmmStatus::withdraw_permission, state.rs:283).
// Before computing the outputs the program may book more PnL from its target
// orders (calc_take_pnl), which can lower them slightly; the slippage allowance
// covers that and the simulation shows the exact amounts.
//
// RPC methods used (all allowed by lib/rpc/policy.ts): getMultipleAccounts
// (pool and LP account, then vaults, mints and market, then the wallet's
// ATAs) and getMinimumBalanceForRentExemption (./fungible.ts). The SDK helpers
// used make no RPC or HTTP calls: removeLiquidityInstruction
// (src/raydium/liquidity/instruction.ts:90), removeLiquidityLayout,
// liquidityStateV4Layout and MARKET_STATE_LAYOUT_V3.
import {
  liquidityStateV4Layout,
  MARKET_STATE_LAYOUT_V3,
  removeLiquidityInstruction,
  removeLiquidityLayout,
} from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import BN from "bn.js";
import type { InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import { ACTION_PROGRAM_IDS, type FungibleTarget } from "../types";
import type { Expectation } from "../verify";
import { ataOf, liveMint } from "./atas";
import {
  checkAmounts,
  checkTarget,
  lpBalance,
  lpShare,
  mismatch,
  paused,
  planWithdraw,
  vaultAmount,
  withdrawBuild,
  type FungiblePlan,
  type FungibleWithdraw,
} from "./fungible";
import { attempt, checkShare, readAccounts } from "./meteora-damm-v2";
import type { WithdrawQuote } from "./quote";

const AMM = new PublicKey(ACTION_PROGRAM_IDS["raydium-amm-v4"]);
const AUTHORITY_SEED = Buffer.from("amm authority");
// AmmStatus values whose withdraw_permission() is true: Initialized,
// WithdrawOnly, LiquidityOnly, OrderBookOnly, SwapOnly, WaitingTrade.
const WITHDRAW_STATUSES = new Set([1, 3, 4, 5, 6, 7]);

type AmmState = ReturnType<typeof liquidityStateV4Layout.decode>;
/** The OpenBook market's accounts the 22-account form carries. */
type MarketKeys = {
  market: PublicKey;
  marketAuthority: PublicKey;
  marketBaseVault: PublicKey;
  marketQuoteVault: PublicKey;
  eventQueue: PublicKey;
  bids: PublicKey;
  asks: PublicKey;
};
type Plan = FungiblePlan & {
  withdraw: FungibleWithdraw;
  amm: AmmState;
  authority: PublicKey;
  /** null for a pool without an OpenBook market (the 11-account form). */
  market: MarketKeys | null;
};

/** create_program_address, or null when the seeds land on the curve. */
const programAddress = (seeds: Buffer[], program: PublicKey) =>
  attempt(() => PublicKey.createProgramAddressSync(seeds, program));

async function plan(rpc: ActionRpc, owner: string, target: FungibleTarget, bps: number, slippageBps: number): Promise<Plan> {
  const keys = checkTarget(target, "raydium-amm-v4");
  const wallet = new PublicKey(owner);
  const first = await readAccounts(rpc, [keys.pool.toBase58(), keys.lpAccount.toBase58()]);

  // The pool: owned by the AMM v4 program (DMND names no program for these
  // rows, ruling R-T4b) and of AmmInfo's exact size (no discriminator).
  const info = first.get(keys.pool.toBase58());
  if (!info || !info.owner.equals(AMM) || info.data.length !== liquidityStateV4Layout.span) mismatch();
  const amm = attempt(() => liquidityStateV4Layout.decode(info.data));
  if (!amm || !amm.lpMint.equals(keys.lpMint) || amm.lpReserve.isZero()) mismatch();
  const authority = amm.nonce.ltn(256) ? programAddress([AUTHORITY_SEED, Buffer.from([amm.nonce.toNumber()])], AMM) : null;
  if (!authority) mismatch();
  const balance = lpBalance(first.get(keys.lpAccount.toBase58()), keys.lpAccount, wallet, keys.lpMint);
  if (balance.gt(amm.lpReserve)) mismatch();
  if (!amm.status.ltn(8) || !WITHDRAW_STATUSES.has(amm.status.toNumber())) paused();

  // A pool without an OpenBook market stores an arbitrary seed account as
  // its market, which is never read.
  const hasMarket = !amm.marketProgramId.equals(PublicKey.default);
  const second = await readAccounts(
    rpc,
    [amm.baseVault, amm.quoteVault, amm.baseMint, amm.quoteMint, ...(hasMarket ? [amm.marketId] : [])].map(String),
  );
  // AMM v4 moves tokens with the Token program only.
  const baseMint = liveMint(amm.baseMint, second.get(amm.baseMint.toBase58()));
  const quoteMint = liveMint(amm.quoteMint, second.get(amm.quoteMint.toBase58()));
  if (!baseMint || !quoteMint || !baseMint.program.equals(TOKEN_PROGRAM_ID) || !quoteMint.program.equals(TOKEN_PROGRAM_ID))
    mismatch();
  const baseVault = vaultAmount(amm.baseVault, second.get(amm.baseVault.toBase58()), baseMint);
  const quoteVault = vaultAmount(amm.quoteVault, second.get(amm.quoteVault.toBase58()), quoteMint);
  if (!baseVault || !quoteVault) mismatch();
  const totalBase = baseVault.sub(amm.baseNeedTakePnl);
  const totalQuote = quoteVault.sub(amm.quoteNeedTakePnl);
  if (totalBase.isNeg() || totalQuote.isNeg()) mismatch();

  const lp = lpShare(balance, bps);
  const out = (total: BN) => lp.mul(total).div(amm.lpReserve);
  const withdraw: FungibleWithdraw = { target, legs: [baseMint, quoteMint], lp, gross: [out(totalBase), out(totalQuote)] };
  return {
    ...(await planWithdraw(rpc, wallet, withdraw, slippageBps)),
    withdraw,
    amm,
    authority,
    market: hasMarket ? marketKeys(amm, second.get(amm.marketId.toBase58())) : null,
  };
}

/**
 * The market the pool names: owned by the program the pool names, of the v3
 * layout's size, naming itself and the pool's mints, with its vault signer
 * derived from its stored nonce.
 */
function marketKeys(amm: AmmState, info: AccountInfo<Buffer> | null | undefined): MarketKeys {
  if (!info || !info.owner.equals(amm.marketProgramId) || info.data.length !== MARKET_STATE_LAYOUT_V3.span) mismatch();
  const market = attempt(() => MARKET_STATE_LAYOUT_V3.decode(info.data));
  if (!market || !market.ownAddress.equals(amm.marketId)) mismatch();
  if (!market.baseMint.equals(amm.baseMint) || !market.quoteMint.equals(amm.quoteMint)) mismatch();
  const marketAuthority = programAddress(
    [amm.marketId.toBuffer(), market.vaultSignerNonce.toArrayLike(Buffer, "le", 8)],
    amm.marketProgramId,
  );
  if (!marketAuthority) mismatch();
  return {
    market: amm.marketId,
    marketAuthority,
    marketBaseVault: market.baseVault,
    marketQuoteVault: market.quoteVault,
    eventQueue: market.eventQueue,
    bids: market.bids,
    asks: market.asks,
  };
}

/** A live quote for burning `bps` (0–10,000) of the wallet's LP balance. */
export async function quoteAmmV4Withdraw(
  rpc: ActionRpc,
  owner: string,
  target: FungibleTarget,
  bps: number,
  slippageBps: number,
): Promise<WithdrawQuote> {
  checkShare(bps, slippageBps, 0);
  return (await plan(rpc, owner, target, bps, slippageBps)).quote;
}

/**
 * One group that burns `bps` (1–10,000) of the wallet's live LP balance with
 * withdraw(amount, min_coin, min_pc): the 11-account form for a pool without
 * an OpenBook market, else the SDK's 22-account form. Throws
 * NothingToWithdrawError, AmountTooSmallError, PositionGoneError, the
 * mismatch error or the paused error.
 */
export async function buildAmmV4WithdrawGroups(
  rpc: ActionRpc,
  owner: string,
  target: FungibleTarget,
  bps: number,
  slippageBps: number,
): Promise<{ groups: InstructionGroup[]; expectation: Expectation; closes: boolean }> {
  checkShare(bps, slippageBps, 1);
  const p = await plan(rpc, owner, target, bps, slippageBps);
  checkAmounts(p.withdraw, p);
  const wallet = new PublicKey(owner);
  const [base, quote] = p.withdraw.legs;
  const user = {
    lpTokenAccount: new PublicKey(target.lpAccount),
    baseTokenAccount: ataOf(wallet, base),
    quoteTokenAccount: ataOf(wallet, quote),
    owner: wallet,
  };
  const ix = p.market ? withdraw22(p, p.market, user) : withdraw11(p, user);
  return withdrawBuild(owner, p.withdraw, p, ix);
}

type UserKeys = { lpTokenAccount: PublicKey; baseTokenAccount: PublicKey; quoteTokenAccount: PublicKey; owner: PublicKey };

/** Tag 4, amount, min_coin, min_pc: the SDK's removeLiquidityLayout (25 bytes). */
function withdrawData(p: Plan): Buffer {
  const data = Buffer.alloc(removeLiquidityLayout.span);
  removeLiquidityLayout.encode(
    { instruction: 4, lpAmount: p.withdraw.lp, baseAmountMin: p.minimums[0], quoteAmountMin: p.minimums[1] },
    data,
  );
  return data;
}

/**
 * The 11-account form, in the order process_withdraw reads it
 * (processor.rs:1561-1590): token program, amm, authority, target orders, LP
 * mint, coin vault, pc vault, user LP, user coin, user pc, owner (signer).
 * Writable: what the program writes (amm and target orders state, the LP
 * burn, the vault transfers).
 */
function withdraw11(p: Plan, user: UserKeys): TransactionInstruction {
  const { amm } = p;
  const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({
    programId: AMM,
    keys: [
      meta(TOKEN_PROGRAM_ID, false),
      meta(new PublicKey(p.withdraw.target.pool!), true),
      meta(p.authority, false),
      meta(amm.targetOrders, true),
      meta(amm.lpMint, true),
      meta(amm.baseVault, true),
      meta(amm.quoteVault, true),
      meta(user.lpTokenAccount, true),
      meta(user.baseTokenAccount, true),
      meta(user.quoteTokenAccount, true),
      meta(user.owner, false, true),
    ],
    data: withdrawData(p),
  });
}

/** The SDK's 22-account form, with the pool's OpenBook market accounts. */
function withdraw22(p: Plan, market: MarketKeys, user: UserKeys): TransactionInstruction {
  const { amm } = p;
  // The builder reads only `pooltype` from poolInfo (to pick v4 over the
  // stable v5) and converts the string keys with jsonInfo2PoolKeys.
  type Params = Parameters<typeof removeLiquidityInstruction>[0];
  const poolKeys = {
    programId: AMM.toBase58(),
    id: p.withdraw.target.pool!,
    authority: p.authority.toBase58(),
    openOrders: amm.openOrders.toBase58(),
    targetOrders: amm.targetOrders.toBase58(),
    mintLp: { address: amm.lpMint.toBase58() },
    vault: { A: amm.baseVault.toBase58(), B: amm.quoteVault.toBase58() },
    marketProgramId: amm.marketProgramId.toBase58(),
    marketId: market.market.toBase58(),
    marketAuthority: market.marketAuthority.toBase58(),
    marketBaseVault: market.marketBaseVault.toBase58(),
    marketQuoteVault: market.marketQuoteVault.toBase58(),
    marketBids: market.bids.toBase58(),
    marketAsks: market.asks.toBase58(),
    marketEventQueue: market.eventQueue.toBase58(),
  };
  const ix = removeLiquidityInstruction({
    poolInfo: { pooltype: [] } as unknown as Params["poolInfo"],
    poolKeys: poolKeys as unknown as Params["poolKeys"],
    userKeys: user,
    lpAmount: p.withdraw.lp,
    baseAmountMin: p.minimums[0],
    quoteAmountMin: p.minimums[1],
  });
  // The builder's own guard (it returns an empty instruction for an unknown
  // version); the pre-sign check would refuse it too.
  if (!ix.programId.equals(AMM) || ix.keys.length !== 22) mismatch();
  return ix;
}
