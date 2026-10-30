// Confirmed wallet actions that DMND has not caught up with yet, kept in the
// visitor's browser so a row never shows already-claimed fees as claimable.
// Pure apart from localStorage: no web3.js, so the UI imports it statically.
// Follows lib/watchlist.ts: a versioned payload, decoded strictly, and data
// that can't be read (or a newer version) is never overwritten.
import bs58 from "bs58";
import { normalizeAddress } from "../address";
import type { ActionKind } from "./programs";

export const PENDING_ACTIONS_KEY = "doxxd.pending-actions.v1";
export const PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_PENDING_ACTIONS = 500;
export const MAX_PENDING_BYTES = 256 * 1024;
const MAX_POSITION_ID_LENGTH = 200;
/** Dispatched on window after this tab writes the store. */
export const PENDING_CHANGE_EVENT = "doxxd-pending-actions-change";

export type PendingAction = {
  wallet: string;
  positionId: string;
  kind: ActionKind;
  signature: string;
  /** The slot the transaction was confirmed in. */
  slot: number;
  /** When it was confirmed, in ms since the epoch. */
  at: number;
};
export type PendingError = "storage_unavailable" | "invalid_data" | "unsupported_version";
export type PendingReadResult = { ok: true; actions: PendingAction[] } | { ok: false; reason: PendingError };

const invalid = (): PendingReadResult => ({ ok: false, reason: "invalid_data" });
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 88) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}
const FIELDS = ["wallet", "positionId", "kind", "signature", "slot", "at"] as const;

/** A copy of `value` when it is a valid record, else null. */
function validAction(value: unknown): PendingAction | null {
  if (!object(value) || !FIELDS.every((field) => Object.hasOwn(value, field))) return null;
  const { wallet, positionId, kind, signature, slot, at } = value;
  if (
    typeof wallet !== "string" || normalizeAddress(wallet) !== wallet ||
    typeof positionId !== "string" || !positionId || positionId.length > MAX_POSITION_ID_LENGTH ||
    (kind !== "claim" && kind !== "withdraw" && kind !== "close") ||
    !validSignature(signature) ||
    !Number.isSafeInteger(slot) || (slot as number) < 0 ||
    !Number.isSafeInteger(at) || (at as number) < 0
  )
    return null;
  return { wallet, positionId, kind, signature, slot: slot as number, at: at as number };
}

/** Decode only the supported version. Unreadable data must not be overwritten. */
export function parsePendingActions(raw: string | null): PendingReadResult {
  if (raw === null) return { ok: true, actions: [] };
  if (raw.length > MAX_PENDING_BYTES || new TextEncoder().encode(raw).byteLength > MAX_PENDING_BYTES)
    return invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!object(value) || !Object.hasOwn(value, "version")) return invalid();
  if (typeof value.version === "number" && value.version !== 1) return { ok: false, reason: "unsupported_version" };
  if (value.version !== 1 || !Array.isArray(value.actions) || value.actions.length > MAX_PENDING_ACTIONS)
    return invalid();
  const actions: PendingAction[] = [];
  for (const row of value.actions) {
    const valid = validAction(row);
    if (!valid) return invalid();
    actions.push(valid);
  }
  return { ok: true, actions };
}

export function serializePendingActions(actions: PendingAction[]): string {
  const raw = JSON.stringify({ version: 1, actions: actions.map((a) => validAction(a)) });
  if (!parsePendingActions(raw).ok) throw new Error("Invalid pending actions");
  return raw;
}

const expired = (action: PendingAction, now: number) => now - action.at >= PENDING_TTL_MS;

/**
 * The record that still covers this row, or null. A record clears when DMND's
 * row has caught up (`rowSnapshotSlot >= slot`), after 24 hours, or when the
 * row is absent from a complete page (`rowSnapshotSlot === null`).
 */
export function pendingIn(
  actions: readonly PendingAction[],
  wallet: string,
  positionId: string,
  rowSnapshotSlot: number | null,
  now: number,
): PendingAction | null {
  if (rowSnapshotSlot === null) return null;
  const found = actions.find((a) => a.wallet === wallet && a.positionId === positionId);
  if (!found || expired(found, now) || rowSnapshotSlot >= found.slot) return null;
  return found;
}

type Read = { ok: true; actions: PendingAction[]; storage: Storage } | { ok: false; reason: PendingError };

/** The stored records with the storage they came from. Never throws. */
export function readPendingActions(): Read {
  try {
    const storage = window.localStorage;
    const result = parsePendingActions(storage.getItem(PENDING_ACTIONS_KEY));
    return result.ok ? { ...result, storage } : result;
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
}

/** pendingIn over the stored records. Never throws. */
export function pendingFor(
  wallet: string,
  positionId: string,
  rowSnapshotSlot: number | null,
  now: number = Date.now(),
): PendingAction | null {
  const read = readPendingActions();
  return read.ok ? pendingIn(read.actions, wallet, positionId, rowSnapshotSlot, now) : null;
}

/**
 * Stores a confirmed action, replacing any older record for the same wallet
 * and position and dropping expired ones. Returns false, leaving storage as
 * it was, when the record is invalid or the stored data can't be read or
 * written. Never throws.
 */
export function recordPending(action: PendingAction, now: number = Date.now()): boolean {
  const valid = validAction(action);
  if (!valid) return false;
  const current = readPendingActions();
  if (!current.ok) return false;
  const kept = current.actions.filter(
    (a) => !expired(a, now) && !(a.wallet === valid.wallet && a.positionId === valid.positionId),
  );
  const actions = [...kept, valid].slice(-MAX_PENDING_ACTIONS);
  try {
    current.storage.setItem(PENDING_ACTIONS_KEY, serializePendingActions(actions));
  } catch {
    return false;
  }
  try {
    window.dispatchEvent(new Event(PENDING_CHANGE_EVENT));
  } catch {
    // Saved; other hooks pick it up on their next read.
  }
  return true;
}
