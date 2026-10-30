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
  return mint === WSOL_MINT
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
const WSOL_MINT = "So11111111111111111111111111111111111111112";
/**
 * DMND's token labels for a leg, reward or fee (name, symbol and image_url,
 * from its token index or the mint's saved metadata). Creator-supplied, so
 * never identity: the mint stays in the row's details. Wrapped SOL takes no
 * creator labels; it always shows as SOL.
 */
export function tokenLabels(row: {
  mint?: string | null;
  symbol?: string | null;
  name?: string | null;
  image_url?: string | null;
}): Pick<AmountView, "symbol" | "name" | "image"> {
  if (!row.mint || row.mint === WSOL_MINT) return {};
  const symbol = row.symbol?.trim();
  const name = row.name?.trim();
  return {
    ...(symbol ? { symbol } : {}),
    ...(name ? { name } : {}),
    ...(row.image_url ? { image: row.image_url } : {}),
  };
}
// Wrapped SOL in a protocol position reads as SOL. Blank symbols fall back to
// the short mint.
export const legLabel = (row: { mint: string; symbol?: string | null }) =>
  row.mint === WSOL_MINT ? "SOL" : row.symbol?.trim() || mintName(row.mint);
export const leg = (row: {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  image_url?: string | null;
  ui_amount?: string | null;
  value_usd?: string | null;
  amount_reason?: string | null;
}): AmountView => ({
  label: legLabel(row),
  mint: row.mint,
  ...tokenLabels(row),
  amount: row.ui_amount ?? null,
  valueUsd: row.value_usd ?? null,
  // Symbols are not identity: the expanded row always shows the mint.
  sourceDetails: [{ label: "Mint", value: row.mint }],
  ...(row.amount_reason
    ? { qualifier: row.amount_reason.replaceAll("_", " ") }
    : {}),
});
