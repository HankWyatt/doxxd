import { act, renderHook } from "@testing-library/react";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_ACTIONS_KEY,
  PENDING_TTL_MS,
  parsePendingActions,
  pendingFor,
  recordPending,
  serializePendingActions,
  type PendingAction,
} from "./pending";
import { usePendingActions } from "./use-pending-actions";

// Synthetic: fixed-byte addresses and signatures, round numbers.
const WALLET = bs58.encode(new Uint8Array(32).fill(7));
const OTHER = bs58.encode(new Uint8Array(32).fill(8));
const signature = (byte: number) => bs58.encode(new Uint8Array(64).fill(byte));
const T0 = 1_800_000_000_000;

const action = (patch: Partial<PendingAction> = {}): PendingAction => ({
  wallet: WALLET,
  positionId: "position-1",
  kind: "claim",
  signature: signature(1),
  slot: 1_000,
  at: T0,
  ...patch,
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("pending action payload", () => {
  it("round-trips a versioned payload", () => {
    const actions = [action(), action({ positionId: "position-2", kind: "withdraw", signature: signature(2) })];
    const raw = serializePendingActions(actions);
    expect(JSON.parse(raw).version).toBe(1);
    expect(parsePendingActions(raw)).toEqual({ ok: true, actions });
    expect(parsePendingActions(null)).toEqual({ ok: true, actions: [] });
  });

  it("rejects malformed records and other versions", () => {
    expect(parsePendingActions("{")).toEqual({ ok: false, reason: "invalid_data" });
    expect(parsePendingActions(JSON.stringify({ version: 2, actions: [] }))).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
    for (const bad of [
      { wallet: "not-an-address" },
      { kind: "swap" },
      { signature: "x" },
      { slot: -1 },
      { slot: 1.5 },
      { at: Number.NaN },
      { positionId: "" },
    ])
      expect(parsePendingActions(JSON.stringify({ version: 1, actions: [{ ...action(), ...bad }] })).ok).toBe(false);
  });
});

describe("recordPending and pendingFor", () => {
  it("shows a record until DMND's row catches up to the confirmed slot", () => {
    expect(recordPending(action(), T0)).toBe(true);
    expect(pendingFor(WALLET, "position-1", 999, T0 + 1_000)).toEqual(action());
    expect(pendingFor(WALLET, "position-1", 1_000, T0 + 1_000)).toBeNull();
    expect(pendingFor(WALLET, "position-1", 1_200, T0 + 1_000)).toBeNull();
  });

  it("clears a record after 24 hours", () => {
    recordPending(action(), T0);
    expect(pendingFor(WALLET, "position-1", 500, T0 + PENDING_TTL_MS - 1)).not.toBeNull();
    expect(pendingFor(WALLET, "position-1", 500, T0 + PENDING_TTL_MS)).toBeNull();
  });

  it("clears a record whose row is absent from a complete page", () => {
    recordPending(action(), T0);
    expect(pendingFor(WALLET, "position-1", null, T0 + 1_000)).toBeNull();
  });

  it("matches by wallet and position", () => {
    recordPending(action(), T0);
    expect(pendingFor(OTHER, "position-1", 500, T0)).toBeNull();
    expect(pendingFor(WALLET, "position-2", 500, T0)).toBeNull();
  });

  it("keeps the newest record per wallet and position, and prunes expired ones", () => {
    const later = T0 + PENDING_TTL_MS;
    const withdrawn = action({ kind: "withdraw", signature: signature(3), slot: 1_100, at: later + 1 });
    recordPending(action({ positionId: "old", at: T0 }), T0);
    recordPending(action({ at: later }), later);
    recordPending(withdrawn, later + 1);
    const stored = parsePendingActions(localStorage.getItem(PENDING_ACTIONS_KEY));
    expect(stored).toEqual({ ok: true, actions: [withdrawn] });
  });

  it("does not overwrite an unsupported version", () => {
    const future = JSON.stringify({ version: 2, actions: [{ something: "else" }] });
    localStorage.setItem(PENDING_ACTIONS_KEY, future);
    expect(recordPending(action(), T0)).toBe(false);
    expect(localStorage.getItem(PENDING_ACTIONS_KEY)).toBe(future);
    expect(pendingFor(WALLET, "position-1", 500, T0)).toBeNull();
  });

  it("does not overwrite unreadable data", () => {
    localStorage.setItem(PENDING_ACTIONS_KEY, "{");
    expect(recordPending(action(), T0)).toBe(false);
    expect(localStorage.getItem(PENDING_ACTIONS_KEY)).toBe("{");
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(recordPending(action(), T0)).toBe(false);
    expect(pendingFor(WALLET, "position-1", 500, T0)).toBeNull();
  });

  it("refuses an invalid record", () => {
    expect(recordPending(action({ wallet: "nope" }), T0)).toBe(false);
    expect(localStorage.getItem(PENDING_ACTIONS_KEY)).toBeNull();
  });
});

describe("usePendingActions", () => {
  it("follows records written in this tab and in others", () => {
    const { result } = renderHook(() => usePendingActions());
    expect(result.current.pendingFor(WALLET, "position-1", 500, T0)).toBeNull();
    act(() => void recordPending(action(), T0));
    expect(result.current.pendingFor(WALLET, "position-1", 500, T0)).toEqual(action());

    act(() => {
      localStorage.setItem(PENDING_ACTIONS_KEY, serializePendingActions([action({ positionId: "position-2" })]));
      window.dispatchEvent(new StorageEvent("storage", { key: PENDING_ACTIONS_KEY }));
    });
    expect(result.current.pendingFor(WALLET, "position-1", 500, T0)).toBeNull();
    expect(result.current.pendingFor(WALLET, "position-2", 500, T0)).not.toBeNull();
  });
});
