// Raydium CPMM withdraw builder (no claim: fees are inside the LP tokens).
//
// Every number comes from live chain state read through the /api/rpc
// pass-through, never from DMND's snapshot or Raydium's HTTP API. Pool keys
// are rebuilt from the pool account (vaults, mints, LP mint) and the program's
// authority PDA. The group (see ./fungible.ts):
//   idempotent ATA creates, withdraw, then the wSOL unwrap.
//
// The withdraw mirrors raydium-cp-swap's
// programs/cp-swap/src/instructions/withdraw.rs (master f4b9b26):
// - reserves = vault amount − protocol − fund − creator fees
//   (PoolState::vault_amount_without_fee, states/pool.rs:225);
// - out = floor(lp × reserve / pool.lp_supply), capped at the reserve
//   (CurveCalculator::lp_tokens_to_trading_tokens, Floor; withdraw.rs:116-139);
// - a zero output on either leg fails (ZeroTradingTokens, withdraw.rs:124);
// - the minimums are compared with the amount net of the Token-2022 transfer
//   fee (withdraw.rs:129-176);
// - status bit 1 set disables withdrawals (withdraw.rs:109, pool.rs:196).
//
// RPC methods used (all allowed by lib/rpc/policy.ts): getMultipleAccounts
// (pool and LP account, then vaults and mints, then the wallet's ATAs),
// getEpochInfo and getMinimumBalanceForRentExemption (./fungible.ts).
// The SDK helpers used make no RPC or HTTP calls: makeWithdrawCpmmInInstruction
// (src/raydium/cpmm/instruction.ts:170), getPdaPoolAuthority
// (src/raydium/cpmm/pda.ts) and CpmmPoolInfoLayout.
import { CpmmPoolInfoLayout, getPdaPoolAuthority, makeWithdrawCpmmInInstruction } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
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

const CPMM = new PublicKey(ACTION_PROGRAM_IDS["raydium-cpmm"]);
// sha256("account:PoolState")[..8]; CpmmPoolInfoLayout skips these bytes.
const POOL_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
// PoolStatusBitIndex::Withdraw: a set bit disables withdrawals.
const WITHDRAW_DISABLED = 1 << 1;

type PoolState = ReturnType<typeof CpmmPoolInfoLayout.decode>;
type Plan = FungiblePlan & { withdraw: FungibleWithdraw; pool: PoolState };

async function plan(rpc: ActionRpc, owner: string, target: FungibleTarget, bps: number, slippageBps: number): Promise<Plan> {
  const keys = checkTarget(target, "raydium-cpmm");
  const wallet = new PublicKey(owner);
  const first = await readAccounts(rpc, [keys.pool.toBase58(), keys.lpAccount.toBase58()]);

  // The pool: owned by the CPMM program (DMND names no program for these
  // rows, ruling R-T4b), of the exact size, with PoolState's discriminator.
  const info = first.get(keys.pool.toBase58());
  if (!info || !info.owner.equals(CPMM) || info.data.length !== CpmmPoolInfoLayout.span) mismatch();
  if (!info.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) mismatch();
  const pool = attempt(() => CpmmPoolInfoLayout.decode(info.data));
  if (!pool || !pool.mintLp.equals(keys.lpMint) || pool.lpAmount.isZero()) mismatch();
  const balance = lpBalance(first.get(keys.lpAccount.toBase58()), keys.lpAccount, wallet, keys.lpMint);
  if (balance.gt(pool.lpAmount)) mismatch();
  if (pool.status & WITHDRAW_DISABLED) paused();

  const second = await readAccounts(rpc, [pool.vaultA, pool.vaultB, pool.mintA, pool.mintB].map(String));
  const mintA = liveMint(pool.mintA, second.get(pool.mintA.toBase58()));
  const mintB = liveMint(pool.mintB, second.get(pool.mintB.toBase58()));
  if (!mintA || !mintB || !mintA.program.equals(pool.mintProgramA) || !mintB.program.equals(pool.mintProgramB))
    mismatch();
  const vaultA = vaultAmount(pool.vaultA, second.get(pool.vaultA.toBase58()), mintA);
  const vaultB = vaultAmount(pool.vaultB, second.get(pool.vaultB.toBase58()), mintB);
  if (!vaultA || !vaultB) mismatch();
  const reserveA = vaultA.sub(pool.protocolFeesMintA).sub(pool.fundFeesMintA).sub(pool.creatorFeesMintA);
  const reserveB = vaultB.sub(pool.protocolFeesMintB).sub(pool.fundFeesMintB).sub(pool.creatorFeesMintB);
  if (reserveA.isNeg() || reserveB.isNeg()) mismatch();

  const lp = lpShare(balance, bps);
  const out = (reserve: BN) => BN.min(lp.mul(reserve).div(pool.lpAmount), reserve);
  const withdraw: FungibleWithdraw = { target, legs: [mintA, mintB], lp, gross: [out(reserveA), out(reserveB)] };
  return { ...(await planWithdraw(rpc, wallet, withdraw, slippageBps)), withdraw, pool };
}

/** A live quote for burning `bps` (0–10,000) of the wallet's LP balance. */
export async function quoteCpmmWithdraw(
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
 * withdraw(lp, minimum_token_0, minimum_token_1). Throws
 * NothingToWithdrawError, AmountTooSmallError, PositionGoneError, the
 * mismatch error or the paused error.
 */
export async function buildCpmmWithdrawGroups(
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
  const [mintA, mintB] = p.withdraw.legs;
  const ix = makeWithdrawCpmmInInstruction(
    CPMM,
    wallet,
    getPdaPoolAuthority(CPMM).publicKey,
    new PublicKey(target.pool!),
    new PublicKey(target.lpAccount),
    ataOf(wallet, mintA),
    ataOf(wallet, mintB),
    p.pool.vaultA,
    p.pool.vaultB,
    mintA.address,
    mintB.address,
    p.pool.mintLp,
    p.withdraw.lp,
    p.minimums[0],
    p.minimums[1],
  );
  return withdrawBuild(owner, p.withdraw, p, ix);
}
