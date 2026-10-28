import bs58 from "bs58";
export function normalizeAddress(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 44) return null;
  try {
    return bs58.decode(value).length === 32 ? value : null;
  } catch {
    return null;
  }
}
export function walletHref(
  address: string,
  tab: "portfolio" | "activity",
): string {
  return `/wallet/${encodeURIComponent(address)}${tab === "activity" ? "/activity" : ""}`;
}
