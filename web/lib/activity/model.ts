import type { Schemas } from "../dmnd/contracts";
export type TransactionView = {
  signature: string;
  at: string;
  label:
    | "Observed executions"
    | "Observed transfers"
    | "Balance changes"
    | "Network fee";
  source: Schemas["WalletTransaction"];
};
export function toTransactionView(
  raw: Schemas["WalletTransaction"],
): TransactionView {
  const label =
    raw.observed_trades.length || raw.trade_count > 0
      ? "Observed executions"
      : raw.observed_transfers.length || raw.transfer_count > 0
        ? "Observed transfers"
        : raw.changes.length
          ? "Balance changes"
          : raw.fee
            ? "Network fee"
            : "Balance changes";
  return { signature: raw.signature, at: raw.block_time, label, source: raw };
}
