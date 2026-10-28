import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import {
  MAX_SAVED_WALLETS,
  MAX_WATCHLIST_BYTES,
  parseWatchlist,
  serializeWatchlist,
} from "./watchlist";

const address = "11111111111111111111111111111111";
const other = bs58.encode(new Uint8Array(32).fill(255));
const payload = (wallets: unknown, version: unknown = 1) =>
  JSON.stringify({ version, wallets });

describe("saved wallet format", () => {
  it("treats absent storage as empty and preserves public keys and user labels", () => {
    expect(parseWatchlist(null)).toEqual({ ok: true, wallets: [] });
    const wallets = [{ address, label: "Whale <one>" }, { address: other, label: "🙂" }];
    expect(parseWatchlist(serializeWatchlist(wallets))).toEqual({ ok: true, wallets });
  });

  it.each([
    "not json",
    "null",
    "[]",
    payload(null),
    payload([{ address }]),
    payload([{ address: "not-a-wallet", label: "Unknown" }]),
    payload([{ address: ` ${address}`, label: "Whitespace address" }]),
    payload([{ address, label: "🙂".repeat(81) }]),
    payload([{ address, label: "First" }, { address, label: "Second" }]),
  ])("rejects unreadable version-one payload without recovering or dropping entries", (raw) => {
    expect(parseWatchlist(raw)).toEqual({ ok: false, reason: "invalid_data" });
  });

  it("distinguishes a future version from corrupt current data", () => {
    expect(parseWatchlist(payload({ future: "shape" }, 2))).toEqual({
      ok: false, reason: "unsupported_version",
    });
  });

  it("accepts exactly the count and Unicode label limits", () => {
    const wallets = Array.from({ length: MAX_SAVED_WALLETS }, (_, index) => {
      const key = new Uint8Array(32);
      key[0] = index;
      return { address: bs58.encode(key), label: "🙂".repeat(80) };
    });
    expect(parseWatchlist(payload(wallets))).toEqual({ ok: true, wallets });
    expect(parseWatchlist(payload([...wallets, { address: other, label: "Extra" }]))).toEqual({
      ok: false, reason: "invalid_data",
    });
  });

  it("bounds stored UTF-8 bytes before decoding a large payload", () => {
    const raw = JSON.stringify({ version: 1, wallets: [], extra: "é".repeat(MAX_WATCHLIST_BYTES / 2) });
    expect(raw.length).toBeLessThan(MAX_WATCHLIST_BYTES);
    expect(parseWatchlist(raw)).toEqual({ ok: false, reason: "invalid_data" });
  });

  it("refuses encoding invalid saved identities", () => {
    expect(() => serializeWatchlist([{ address: "invalid", label: "No" }])).toThrow();
  });
});
