// What a withdraw dialog shows, and the builders' typed refusals. Pure: no
// web3.js or SDK imports, so the UI may import these statically.

/** An amount of one token, in its smallest units. */
export type TokenAmount = { mint: string; symbol: string | null; decimals: number; atoms: string };

/**
 * A live withdraw quote, read from chain state when the dialog asks for it.
 * - `receive`: what the wallet gets (liquidity out plus claimed fees and, when
 *   the position closes, rewards), net of any Token-2022 transfer fee;
 * - `fees`: the claimed fees (and rewards) included in `receive`;
 * - `minimums`: token A and B minimums the transaction enforces;
 * - `closes`: the position closes and its deposit comes back;
 * - `depositRefundLamports`: lamports returned by closing, or null;
 * - `rentLamports`: rent for token accounts the transaction creates and keeps;
 * - `withdrawableBps` / `vestingBps` / `lockedBps`: live shares of the
 *   position's total liquidity that can be withdrawn now / are still vesting /
 *   are permanently locked, each floored on its own (so they need not sum to
 *   10,000); `lockedBps` is 0 exactly when nothing is permanently locked.
 */
export type WithdrawQuote = {
  receive: TokenAmount[];
  fees: TokenAmount[];
  minimums: TokenAmount[];
  closes: boolean;
  depositRefundLamports: string | null;
  rentLamports: string;
  withdrawableBps: number;
  vestingBps: number;
  lockedBps: number;
};

/** Why a position gets no claim transaction. */
export type SkipReason =
  | "Nothing to claim"
  | "Rewards are paused by the pool"
  | "Position no longer exists"
  | "Position data doesn't match the pool · skipped";

/** No liquidity can be withdrawn now: everything is locked or still vesting. */
export class NothingToWithdrawError extends Error {
  constructor() {
    super("Nothing to withdraw yet");
    this.name = "NothingToWithdrawError";
  }
}

/** The requested share would pay out nothing after the slippage allowance. */
export class AmountTooSmallError extends Error {
  constructor() {
    super("Amount too small to withdraw");
    this.name = "AmountTooSmallError";
  }
}

/** The position was closed, or its NFT left the wallet, since DMND saw it. */
export class PositionGoneError extends Error {
  constructor() {
    super("Position no longer exists");
    this.name = "PositionGoneError";
  }
}

const NOT_EMPTY = {
  liquidity: "This position still holds liquidity",
  locked: "Part of this position is locked for good",
  vesting: "Part of this position is still vesting",
} as const;

/** A close was asked for a position that is not empty: liquidity, a lock or vesting remains. */
export class PositionNotEmptyError extends Error {
  constructor(readonly remains: keyof typeof NOT_EMPTY) {
    super(NOT_EMPTY[remains]);
    this.name = "PositionNotEmptyError";
  }
}

/** A pending reward sits in a reward vault the pool has frozen: it can't be paid out now. */
export class RewardsPausedError extends Error {
  constructor() {
    super("Rewards are paused by the pool");
    this.name = "RewardsPausedError";
  }
}
