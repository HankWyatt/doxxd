import { normalizeAddress } from "./address";

export const WATCHLIST_KEY = "doxxd.watchlist.v1";
export const MAX_SAVED_WALLETS = 100;
export const MAX_WATCHLIST_BYTES = 64 * 1024;
export const MAX_WATCHLIST_LABEL_LENGTH = 80;

export type SavedWallet = { address: string; label: string };
export type WatchlistError =
  | "storage_unavailable"
  | "invalid_data"
  | "unsupported_version"
  | "limit"
  | "invalid_address"
  | "invalid_label"
  | "duplicate"
  | "not_found";
export type WatchlistResult = { ok: true } | { ok: false; reason: WatchlistError };
export type WatchlistReadResult =
  | { ok: true; wallets: SavedWallet[] }
  | { ok: false; reason: WatchlistError };

const invalid = (): WatchlistReadResult => ({ ok: false, reason: "invalid_data" });
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validWatchlistLabel(label: unknown): label is string {
  return typeof label === "string" && Array.from(label).length <= MAX_WATCHLIST_LABEL_LENGTH;
}

/** Decode only the supported version. Unreadable data must not be overwritten. */
export function parseWatchlist(raw: string | null): WatchlistReadResult {
  if (raw === null) return { ok: true, wallets: [] };
  if (
    raw.length > MAX_WATCHLIST_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_WATCHLIST_BYTES
  ) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!object(value) || !Object.hasOwn(value, "version")) return invalid();
  if (typeof value.version === "number" && value.version !== 1)
    return { ok: false, reason: "unsupported_version" };
  if (value.version !== 1 || !Array.isArray(value.wallets) || value.wallets.length > MAX_SAVED_WALLETS)
    return invalid();
  const wallets: SavedWallet[] = [];
  const seen = new Set<string>();
  for (const row of value.wallets) {
    if (
      !object(row) || !Object.hasOwn(row, "address") || !Object.hasOwn(row, "label") ||
      typeof row.address !== "string" || normalizeAddress(row.address) !== row.address ||
      !validWatchlistLabel(row.label) || seen.has(row.address)
    ) return invalid();
    seen.add(row.address);
    wallets.push({ address: row.address, label: row.label });
  }
  return { ok: true, wallets };
}

export function serializeWatchlist(wallets: SavedWallet[]): string {
  const raw = JSON.stringify({
    version: 1,
    wallets: wallets.map(({ address, label }) => ({ address, label })),
  });
  if (!parseWatchlist(raw).ok) throw new Error("Invalid saved wallets");
  return raw;
}
