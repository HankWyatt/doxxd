// Shared by the Raydium CPMM and AMM v4 withdraw builders. Both pools pay
// fees into their reserves, so a position is a balance of LP tokens and the
// only action is a withdraw that burns some of them for both legs. Each
// builder reads its own pool and computes what leaves the vaults; this file
// checks the target and the LP account, nets out transfer fees, sets the
// minimums, and assembles the group and its quote:
//   idempotent creates of the wallet's missing ATAs of both legs (the wSOL
//   ATA always), the protocol's withdraw, then the wSOL unwrap.
//
// RPC methods used: getMultipleAccounts (the wallet's ATAs), getEpochInfo
// (only when a leg has a Token-2022 transfer fee) and
// getMinimumBalanceForRentExemption (rent of ATAs the group creates and keeps).
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  calculateEpochFee,
  getTransferFeeConfig,
  unpackAccount,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import type { InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import type { FungibleTarget } from "../types";
import type { Expectation } from "../verify";
import { ataCreates, ataOf, existingAtas, wsolUnwraps } from "./atas";
import { ataSize, attempt, isAddress, type LiveMint } from "./meteora-damm-v2";
import {
  AmountTooSmallError,
  NothingToWithdrawError,
  PositionGoneError,
  type TokenAmount,
  type WithdrawQuote,
} from "./quote";

const BPS = 10_000;

export type FungibleProtocol = FungibleTarget["protocol"];

/** The live state disagrees with the target or with itself. */
export function mismatch(): never {
  throw new Error("Position data doesn't match the pool");
}

/** The pool's state does not allow withdrawals now. */
export function paused(): never {
  throw new Error("Withdrawals are paused for this pool");
}

/**
 * The target's addresses, checked before anything is read: the protocol is
 * `protocol`, DMND has not marked the withdrawal unavailable, and every
 * address is a well-formed key.
 */
export function checkTarget(
  target: FungibleTarget,
  protocol: FungibleProtocol,
): { pool: PublicKey; lpMint: PublicKey; lpAccount: PublicKey } {
  if (target.protocol !== protocol) mismatch();
  if (target.withdrawalAvailable === false) throw new NothingToWithdrawError();
  const { pool, lpMint, lpAccount } = target;
  if (!isAddress(pool) || !isAddress(lpMint) || !isAddress(lpAccount)) mismatch();
  return { pool: new PublicKey(pool), lpMint: new PublicKey(lpMint), lpAccount: new PublicKey(lpAccount) };
}

/**
 * The wallet's live LP balance in the target's LP account: a Token account
 * (both programs mint LP tokens under Token) of `lpMint` whose owner is the
 * wallet, else the mismatch error. A missing or empty account means the
 * position is gone.
 */
export function lpBalance(
  info: AccountInfo<Buffer> | null | undefined,
  address: PublicKey,
  wallet: PublicKey,
  lpMint: PublicKey,
): BN {
  if (!info) throw new PositionGoneError();
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) mismatch();
  const account = attempt(() => unpackAccount(address, info, TOKEN_PROGRAM_ID));
  if (!account || !account.isInitialized || !account.mint.equals(lpMint) || !account.owner.equals(wallet)) mismatch();
  if (account.amount === BigInt(0)) throw new PositionGoneError();
  return new BN(account.amount.toString());
}

/** A pool vault's amount: a token account of `mint` under the mint's program, else null. */
export function vaultAmount(address: PublicKey, info: AccountInfo<Buffer> | null | undefined, mint: LiveMint): BN | null {
  if (!info || !info.owner.equals(mint.program)) return null;
  const account = attempt(() => unpackAccount(address, info, mint.program));
  if (!account || !account.isInitialized || !account.mint.equals(mint.address)) return null;
  return new BN(account.amount.toString());
}

/** One withdraw, as a protocol builder computed it from live state. */
export type FungibleWithdraw = {
  target: FungibleTarget;
  /** The two legs in the instruction's order (token 0 / base first). */
  legs: [LiveMint, LiveMint];
  /** LP tokens burned: floor(live balance × bps / 10,000). */
  lp: BN;
  /** What leaves each vault, before any transfer fee. */
  gross: [BN, BN];
};

export type FungiblePlan = {
  quote: WithdrawQuote;
  minimums: [BN, BN];
  /** The wallet's ATAs that already exist (no create is built for them). */
  existing: Set<string>;
};

/**
 * The quote and minimums for `w`:
 * - receive: gross net of any Token-2022 transfer fee at the current epoch
 *   (the fee the token program withholds from the vault's transfer);
 * - minimums: floor(receive × (10,000 − slippage) / 10,000);
 * - fees: none listed, since fees are inside the LP tokens;
 * - rent: the ATAs the group creates and keeps (a wSOL ATA is closed again).
 */
export async function planWithdraw(
  rpc: ActionRpc,
  wallet: PublicKey,
  w: FungibleWithdraw,
  slippageBps: number,
): Promise<FungiblePlan> {
  const configs = w.legs.map((leg) => getTransferFeeConfig(leg.mint));
  const epoch = configs.some(Boolean) ? (await rpc.connection.getEpochInfo("confirmed")).epoch : 0;
  const net = w.gross.map((amount, i) => {
    const config = configs[i];
    if (!config) return amount;
    const fee = calculateEpochFee(config, BigInt(epoch), BigInt(amount.toString()));
    return amount.sub(new BN(fee.toString()));
  }) as [BN, BN];
  const minimums = net.map((amount) => amount.muln(BPS - slippageBps).divn(BPS)) as [BN, BN];

  const existing = await existingAtas(rpc, wallet, w.legs);
  const missing = w.legs.filter((m) => !m.address.equals(NATIVE_MINT) && !existing.has(ataOf(wallet, m).toBase58()));
  const rents = await Promise.all(
    missing.map((m) => rpc.connection.getMinimumBalanceForRentExemption(ataSize(m), "confirmed")),
  );

  const amount = (mint: LiveMint, atoms: BN): TokenAmount => {
    const address = mint.address.toBase58();
    const leg = w.target.legs.find((l) => l.mint === address);
    return { mint: address, symbol: leg?.symbol ?? null, decimals: mint.mint.decimals, atoms: atoms.toString() };
  };
  return {
    quote: {
      receive: w.legs.map((leg, i) => amount(leg, net[i])),
      fees: [],
      minimums: w.legs.map((leg, i) => amount(leg, minimums[i])),
      closes: false,
      depositRefundLamports: null,
      rentLamports: String(rents.reduce((a, b) => a + b, 0)),
      withdrawableBps: BPS,
      vestingBps: 0,
      lockedBps: 0,
    },
    minimums,
    existing,
  };
}

/**
 * Refuses a withdraw the program would reject or the pre-sign check would
 * refuse: nothing burned, a leg paying out nothing (both programs reject a
 * zero output), or both minimums zero.
 */
export function checkAmounts(w: FungibleWithdraw, plan: FungiblePlan): void {
  if (w.lp.isZero() || w.gross.some((g) => g.isZero()) || plan.minimums.every((m) => m.isZero()))
    throw new AmountTooSmallError();
}

const legLabel = (t: FungibleTarget, mint: LiveMint) => {
  const address = mint.address.toBase58();
  return t.legs.find((l) => l.mint === address)?.symbol ?? `${address.slice(0, 4)}…`;
};

/** The single withdraw group and the pre-sign check's expectation for it. */
export function withdrawBuild(
  owner: string,
  w: FungibleWithdraw,
  plan: FungiblePlan,
  withdraw: TransactionInstruction,
): { groups: InstructionGroup[]; expectation: Expectation; closes: boolean } {
  const wallet = new PublicKey(owner);
  const { target, legs } = w;
  return {
    groups: [
      {
        positionIds: [target.id],
        instructions: [...ataCreates(wallet, legs, plan.existing), withdraw, ...wsolUnwraps(wallet, legs)],
        label: `Withdraw ${legLabel(target, legs[0])} + ${legLabel(target, legs[1])}`,
      },
    ],
    expectation: {
      kind: "withdraw",
      owner,
      mints: legs.map((leg) => ({ mint: leg.address.toBase58(), tokenProgram: leg.program.toBase58() })),
      // The LP account stands in for a position NFT account, so the pre-sign
      // check refuses any CloseAccount of it.
      positions: [{ position: target.pool!, nftAccount: target.lpAccount, protocol: target.protocol }],
    },
    closes: false,
  };
}

/** floor(balance × bps / 10,000). */
export const lpShare = (balance: BN, bps: number) => balance.muln(bps).divn(BPS);
