"use client";
// The pending-action store (./pending.ts) as React state. Like
// lib/use-watchlist.ts it follows this tab's change event, other tabs'
// storage events and pageshow, and every storage access is guarded; it reads
// through useSyncExternalStore, so the stored text is the snapshot. No
// web3.js; the UI imports it statically.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  PENDING_ACTIONS_KEY,
  PENDING_CHANGE_EVENT,
  parsePendingActions,
  pendingIn,
  type PendingAction,
  type PendingError,
} from "./pending";

// Snapshots are the stored text, or one of these markers (never valid JSON).
const SERVER = "\u0000server";
const EMPTY = "\u0000empty";
const UNAVAILABLE = "\u0000unavailable";

function snapshot(): string {
  try {
    return window.localStorage.getItem(PENDING_ACTIONS_KEY) ?? EMPTY;
  } catch {
    return UNAVAILABLE;
  }
}
const serverSnapshot = () => SERVER;

function subscribe(changed: () => void): () => void {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === PENDING_ACTIONS_KEY || event.key === null) changed();
  };
  window.addEventListener("storage", storageChanged);
  window.addEventListener(PENDING_CHANGE_EVENT, changed);
  window.addEventListener("pageshow", changed);
  return () => {
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener(PENDING_CHANGE_EVENT, changed);
    window.removeEventListener("pageshow", changed);
  };
}

type State = { ready: boolean; actions: PendingAction[]; error: PendingError | null };

function stateOf(raw: string): State {
  if (raw === SERVER) return { ready: false, actions: [], error: null };
  if (raw === UNAVAILABLE) return { ready: true, actions: [], error: "storage_unavailable" };
  const result = parsePendingActions(raw === EMPTY ? null : raw);
  return result.ok
    ? { ready: true, actions: result.actions, error: null }
    : { ready: true, actions: [], error: result.reason };
}

export function usePendingActions(): State & {
  /** The record still covering this row, or null (see pendingIn). */
  pendingFor(wallet: string, positionId: string, rowSnapshotSlot: number | null, now?: number): PendingAction | null;
} {
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const state = useMemo(() => stateOf(raw), [raw]);
  const pendingFor = useCallback(
    (wallet: string, positionId: string, rowSnapshotSlot: number | null, now: number = Date.now()) =>
      pendingIn(state.actions, wallet, positionId, rowSnapshotSlot, now),
    [state.actions],
  );
  return { ...state, pendingFor };
}
