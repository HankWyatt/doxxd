import Decimal from "decimal.js";
import type { ResourceError, Schemas } from "./dmnd/contracts";
import { formatUsd } from "./decimal";

export type HoldingsTradingDetails = {
  positions: ReadonlyMap<string, Schemas["WalletPosition"]>;
  loading: boolean;
  error: ResourceError | null;
  positionsTracked: boolean | null;
  positionsSince: string | null;
  loadedCount: number;
  positionCount: number | null;
  hasMore: boolean;
  continuationUnavailable: boolean;
  loadMore: () => void;
  reload: () => void;
};

function decimal(value: string | null | undefined): Decimal | null {
  if (typeof value !== "string" || !value.trim() || value.length > 512) return null;
  try {
    const number = new Decimal(value);
    return number.isFinite() ? number : null;
  } catch {
    return null;
  }
}

export function pnlTone(value: string | null | undefined): "positive" | "negative" | "" {
  const number = decimal(value);
  return !number || number.isZero() ? "" : number.isNegative() ? "negative" : "positive";
}

export function formatSignedUsd(value: string | null | undefined): string {
  return (pnlTone(value) === "positive" ? "+" : "") + formatUsd(value);
}

/**
 * These are the source's indexed average-cost estimates, never qualified wallet
 * profit. Even fully priced recorded trades do not establish opening inventory,
 * transfer basis, fees or complete history. This gate only withholds estimates
 * when the recorded USD basis is itself unavailable; it adds no accounting.
 */
export function indexedPnl(position: Schemas["WalletPosition"]) {
  const unavailableReason = position.unpriced_trades > 0
    ? "Some indexed trades have missing prices."
    : position.bought.count < 1 ||
        !decimal(position.bought.usd)?.greaterThan(0) ||
        !decimal(position.avg_buy_price_usd)?.greaterThan(0)
      ? "A priced indexed buy basis is unavailable."
      : null;
  return {
    total: unavailableReason ? null : position.total_pnl_usd ?? null,
    realized: unavailableReason ? null : position.realized_pnl_usd,
    unrealized: unavailableReason ? null : position.unrealized_pnl_usd ?? null,
    unavailableReason,
  };
}
