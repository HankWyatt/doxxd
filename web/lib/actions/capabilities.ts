// What a visitor can do with a position, from DMND's snapshot alone. Pure; all
// atom and liquidity math is BigInt. The live builders re-check against chain.
import type { ActionTarget } from "./types";

export type Capabilities = {
  claim: "yes" | "maybe" | "no";
  withdraw: "yes" | "locked" | "no";
  withdrawableBps: number;
  vestingBps: number;
};

// The tsconfig target (ES2017) rejects bigint literals, so build the constants.
const ZERO = BigInt(0);
const TEN_THOUSAND = BigInt(10000);

// Unparseable amounts count as zero, so a malformed row never offers an action.
const big = (value: string): bigint => (/^\d+$/.test(value) ? BigInt(value) : ZERO);

const bps = (part: bigint, total: bigint) =>
  total > ZERO ? Number((part * TEN_THOUSAND) / total) : 0;

export function capabilities(t: ActionTarget): Capabilities {
  switch (t.protocol) {
    case "meteora-damm-v2": {
      const unlocked = big(t.liquidity.unlocked);
      const vested = big(t.liquidity.vested);
      const total = big(t.liquidity.total);
      const withdrawable = unlocked + vested;
      const anyClaimable =
        big(t.feeAAtoms) > ZERO ||
        big(t.feeBAtoms) > ZERO ||
        t.rewards.some((r) => big(r.atoms) > ZERO);
      return {
        claim: anyClaimable ? "yes" : "no",
        withdraw: withdrawable > ZERO ? "yes" : total > ZERO ? "locked" : "no",
        withdrawableBps: bps(withdrawable, total),
        vestingBps: bps(vested, total),
      };
    }
    case "raydium-clmm": {
      const liquid = big(t.liquidity) > ZERO;
      const anyOwed =
        big(t.feeOwedAAtoms) > ZERO ||
        big(t.feeOwedBAtoms) > ZERO ||
        t.rewards.some((r) => big(r.atoms) > ZERO);
      return {
        claim: liquid || anyOwed ? "maybe" : "no",
        withdraw: liquid ? "yes" : "no",
        withdrawableBps: 10000,
        vestingBps: 0,
      };
    }
    case "raydium-cpmm":
    case "raydium-amm-v4":
      return {
        claim: "no",
        withdraw:
          big(t.lpAtoms) > ZERO && t.withdrawalAvailable !== false ? "yes" : "no",
        withdrawableBps: 10000,
        vestingBps: 0,
      };
  }
}

/** How the card should word a row's claimable fee amounts. */
export function claimableLabel(
  t: ActionTarget,
): "exact" | "lower-bound" | "included" {
  switch (t.protocol) {
    case "meteora-damm-v2":
      return "exact";
    case "raydium-clmm":
      return "lower-bound";
    default:
      return "included";
  }
}
