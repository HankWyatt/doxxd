"use client";
import { useCallback, useEffect, useState } from "react";
import { normalizeAddress } from "./address";
import {
  MAX_SAVED_WALLETS,
  WATCHLIST_KEY,
  parseWatchlist,
  serializeWatchlist,
  validWatchlistLabel,
  type SavedWallet,
  type WatchlistError,
  type WatchlistResult,
} from "./watchlist";

const CHANGE_EVENT = "doxxd-watchlist-change";
type State = { ready: boolean; wallets: SavedWallet[]; error: WatchlistError | null };
type Read =
  | { ok: true; wallets: SavedWallet[]; storage: Storage }
  | { ok: false; reason: WatchlistError };
type Mutation =
  | { type: "add"; address: string; label: string }
  | { type: "rename"; address: string; label: string }
  | { type: "remove"; address: string };

function read(): Read {
  try {
    const storage = window.localStorage;
    const result = parseWatchlist(storage.getItem(WATCHLIST_KEY));
    return result.ok ? { ...result, storage } : result;
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
}
function fromRead(result: Read): State {
  return result.ok
    ? { ready: true, wallets: result.wallets, error: null }
    : { ready: true, wallets: [], error: result.reason };
}

export function useWatchlist(): State & {
  add(address: string, label?: string): WatchlistResult;
  rename(address: string, label: string): WatchlistResult;
  remove(address: string): WatchlistResult;
  reload(): void;
} {
  const [state, setState] = useState<State>({ ready: false, wallets: [], error: null });
  const reload = useCallback(() => setState(fromRead(read())), []);
  useEffect(() => {
    const storageChanged = (event: StorageEvent) => {
      if (event.key === WATCHLIST_KEY || event.key === null) reload();
    };
    window.addEventListener("storage", storageChanged);
    window.addEventListener(CHANGE_EVENT, reload);
    window.addEventListener("pageshow", reload);
    reload();
    return () => {
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener(CHANGE_EVENT, reload);
      window.removeEventListener("pageshow", reload);
    };
  }, [reload]);

  const mutate = useCallback((mutation: Mutation): WatchlistResult => {
    // Component state may be stale after another tab writes. Mutations always
    // begin with the currently persisted collection, never its rendered copy.
    const current = read();
    setState(fromRead(current));
    if (!current.ok) return current;
    const address = typeof mutation.address === "string" ? normalizeAddress(mutation.address) : null;
    if (!address) return { ok: false, reason: "invalid_address" };
    let label = "";
    if (mutation.type !== "remove") {
      if (typeof mutation.label !== "string") return { ok: false, reason: "invalid_label" };
      label = mutation.label.trim();
      if (!validWatchlistLabel(label)) return { ok: false, reason: "invalid_label" };
    }
    const index = current.wallets.findIndex((wallet) => wallet.address === address);
    let wallets = current.wallets;
    if (mutation.type === "add") {
      if (index !== -1) return { ok: false, reason: "duplicate" };
      if (wallets.length >= MAX_SAVED_WALLETS) return { ok: false, reason: "limit" };
      wallets = [...wallets, { address, label }];
    } else if (mutation.type === "rename") {
      if (index === -1) return { ok: false, reason: "not_found" };
      if (wallets[index].label === label) return { ok: true };
      wallets = wallets.map((wallet) => wallet.address === address ? { address, label } : wallet);
    } else {
      if (index === -1) return { ok: true };
      wallets = wallets.filter((wallet) => wallet.address !== address);
    }
    let serialized: string;
    try {
      serialized = serializeWatchlist(wallets);
    } catch {
      return { ok: false, reason: "invalid_data" };
    }
    try {
      current.storage.setItem(WATCHLIST_KEY, serialized);
    } catch {
      // Retain the last persisted state; an attempted write is not a save.
      return { ok: false, reason: "storage_unavailable" };
    }
    setState({ ready: true, wallets, error: null });
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return { ok: true };
  }, []);

  const add = useCallback((address: string, label = "") => mutate({ type: "add", address, label }), [mutate]);
  const rename = useCallback((address: string, label: string) => mutate({ type: "rename", address, label }), [mutate]);
  const remove = useCallback((address: string) => mutate({ type: "remove", address }), [mutate]);
  return { ...state, add, rename, remove, reload };
}
