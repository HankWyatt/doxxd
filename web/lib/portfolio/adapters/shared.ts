import type { AmountView, PositionView } from "../model";
export const sourceDetail = (
  label: string,
  value: string | number | boolean | null | undefined,
) => ({ label, value: value == null ? "Unknown" : String(value) });
export const sourceClockNote = {
  label: "Source clocks",
  value:
    "Account and conversion snapshots are independent observations; slots do not establish current or atomic state.",
};
export const short = (value: string) =>
  value.length > 16 ? value.slice(0, 5) + "…" + value.slice(-5) : value;
export function mintName(mint: string): string {
  return mint === "So11111111111111111111111111111111111111112"
    ? "WSOL"
    : mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ? "USDC"
      : short(mint);
}
export const position = (id: string, label: string): PositionView => ({
  id,
  label,
  assets: [],
  debts: [],
  rewards: [],
  valueUsd: null,
  details: [],
});
export const leg = (row: {
  mint: string;
  ui_amount?: string | null;
  value_usd?: string | null;
  amount_reason?: string | null;
}): AmountView => ({
  label: mintName(row.mint),
  mint: row.mint,
  amount: row.ui_amount ?? null,
  valueUsd: row.value_usd ?? null,
  ...(row.amount_reason
    ? { qualifier: row.amount_reason.replaceAll("_", " ") }
    : {}),
});
