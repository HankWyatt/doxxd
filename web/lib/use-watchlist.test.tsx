import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { WATCHLIST_KEY, MAX_SAVED_WALLETS, type SavedWallet } from "./watchlist";
import { useWatchlist } from "./use-watchlist";

const a = "11111111111111111111111111111111";
const b = bs58.encode(new Uint8Array(32).fill(255));
const c = bs58.encode(new Uint8Array(32).fill(22));
const payload = (wallets: SavedWallet[]) => JSON.stringify({ version: 1, wallets });
const seed = (wallets: SavedWallet[]) => localStorage.setItem(WATCHLIST_KEY, payload(wallets));

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("local watchlist hook", () => {
  it("does not read storage during SSR or pretend to be hydrated", () => {
    const read = vi.spyOn(Storage.prototype, "getItem");
    function Probe() {
      const list = useWatchlist();
      return <span>{`${list.ready}:${list.wallets.length}`}</span>;
    }
    expect(renderToString(<Probe />)).toContain("false:0");
    expect(read).not.toHaveBeenCalled();
  });

  it("loads existing saved wallets without writing on mount", () => {
    seed([{ address: a, label: "Known" }]);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(useWatchlist);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.wallets).toEqual([{ address: a, label: "Known" }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("adds normalized public keys, preserves duplicate labels, renames and removes", () => {
    const { result } = renderHook(useWatchlist);
    act(() => expect(result.current.add(` ${a} `, " First ")).toEqual({ ok: true }));
    expect(result.current.wallets).toEqual([{ address: a, label: "First" }]);
    act(() => expect(result.current.add(a, "Replacement")).toEqual({ ok: false, reason: "duplicate" }));
    expect(result.current.wallets[0].label).toBe("First");
    act(() => expect(result.current.rename(a, "Renamed")).toEqual({ ok: true }));
    expect(JSON.parse(localStorage.getItem(WATCHLIST_KEY)!).wallets).toEqual([{ address: a, label: "Renamed" }]);
    act(() => expect(result.current.remove(a)).toEqual({ ok: true }));
    expect(result.current.wallets).toEqual([]);
  });

  it("rejects invalid mutations without changing persisted data", () => {
    seed([{ address: a, label: "Original" }]);
    const original = localStorage.getItem(WATCHLIST_KEY);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(useWatchlist);
    act(() => expect(result.current.add("invalid")).toEqual({ ok: false, reason: "invalid_address" }));
    act(() => expect(result.current.rename(a, "🙂".repeat(81))).toEqual({ ok: false, reason: "invalid_label" }));
    act(() => expect(result.current.rename(b, "Missing")).toEqual({ ok: false, reason: "not_found" }));
    act(() => expect(result.current.remove(b)).toEqual({ ok: true }));
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(WATCHLIST_KEY)).toBe(original);
  });

  it("notifies other same-window hook instances after successful changes", () => {
    const first = renderHook(useWatchlist);
    const second = renderHook(useWatchlist);
    act(() => expect(first.result.current.add(a)).toEqual({ ok: true }));
    expect(second.result.current.wallets).toEqual([{ address: a, label: "" }]);
    act(() => expect(second.result.current.rename(a, "Both see this")).toEqual({ ok: true }));
    expect(first.result.current.wallets[0].label).toBe("Both see this");
  });

  it("reloads matching cross-tab events and clear, but ignores unrelated keys", () => {
    const { result } = renderHook(useWatchlist);
    seed([{ address: a, label: "Other tab" }]);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })));
    expect(result.current.wallets).toEqual([]);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: WATCHLIST_KEY, newValue: "not authoritative" })));
    expect(result.current.wallets).toEqual([{ address: a, label: "Other tab" }]);
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(result.current.wallets).toEqual([]);
  });

  it("reloads the latest saved wallets when a document returns from history", () => {
    seed([{ address: a, label: "Before leaving" }]);
    const { result } = renderHook(useWatchlist);
    seed([{ address: b, label: "Changed while away" }]);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(result.current.wallets).toEqual([{ address: a, label: "Before leaving" }]);
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(result.current.wallets).toEqual([{ address: b, label: "Changed while away" }]);
    expect(write).not.toHaveBeenCalled();
  });

  it("reports a newer stored format after history restoration without overwriting it", () => {
    seed([{ address: a, label: "Old reader" }]);
    const { result } = renderHook(useWatchlist);
    const future = JSON.stringify({ version: 2, wallets: [{ address: b, label: "Future reader" }] });
    localStorage.setItem(WATCHLIST_KEY, future);
    const write = vi.spyOn(Storage.prototype, "setItem");
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(result.current.error).toBe("unsupported_version");
    expect(result.current.wallets).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(WATCHLIST_KEY)).toBe(future);
  });

  it("rereads persistent state before a mutation instead of overwriting a stale snapshot", () => {
    const { result } = renderHook(useWatchlist);
    seed([{ address: a, label: "New elsewhere" }]);
    act(() => expect(result.current.add(b, "Here")).toEqual({ ok: true }));
    expect(result.current.wallets).toEqual([{ address: a, label: "New elsewhere" }, { address: b, label: "Here" }]);
  });

  it.each([
    ["{invalid", "invalid_data"],
    [JSON.stringify({ version: 2, wallets: [] }), "unsupported_version"],
  ] as const)("preserves unreadable raw storage and refuses all writes", (raw, reason) => {
    localStorage.setItem(WATCHLIST_KEY, raw);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(useWatchlist);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBe(reason);
    act(() => expect(result.current.add(a)).toEqual({ ok: false, reason }));
    act(() => expect(result.current.rename(a, "No overwrite")).toEqual({ ok: false, reason }));
    act(() => expect(result.current.remove(a)).toEqual({ ok: false, reason }));
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(WATCHLIST_KEY)).toBe(raw);
  });

  it("does not overwrite a newer format written after this hook loaded", () => {
    seed([{ address: a, label: "Old reader" }]);
    const { result } = renderHook(useWatchlist);
    const future = JSON.stringify({ version: 2, wallets: [{ address: a, label: "Future data" }] });
    localStorage.setItem(WATCHLIST_KEY, future);
    const write = vi.spyOn(Storage.prototype, "setItem");
    act(() => expect(result.current.remove(a)).toEqual({ ok: false, reason: "unsupported_version" }));
    expect(result.current.error).toBe("unsupported_version");
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(WATCHLIST_KEY)).toBe(future);
  });

  it("surfaces unavailable storage and can reload after access recovers", () => {
    seed([{ address: a, label: "Preserved" }]);
    const getter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    const { result } = renderHook(useWatchlist);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBe("storage_unavailable");
    act(() => expect(result.current.add(b)).toEqual({ ok: false, reason: "storage_unavailable" }));
    getter.mockRestore();
    act(() => result.current.reload());
    expect(result.current.error).toBeNull();
    expect(result.current.wallets).toEqual([{ address: a, label: "Preserved" }]);
  });

  it("does not confirm or display a mutation when persistence fails", () => {
    seed([{ address: a, label: "Before" }]);
    const { result } = renderHook(useWatchlist);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    act(() => expect(result.current.rename(a, "After")).toEqual({ ok: false, reason: "storage_unavailable" }));
    expect(result.current.error).toBeNull();
    expect(result.current.wallets).toEqual([{ address: a, label: "Before" }]);
    write.mockRestore();
    expect(localStorage.getItem(WATCHLIST_KEY)).toBe(payload([{ address: a, label: "Before" }]));
  });

  it("enforces capacity without changing the saved collection", () => {
    const wallets = Array.from({ length: MAX_SAVED_WALLETS }, (_, index) => {
      const bytes = new Uint8Array(32); bytes[0] = index;
      return { address: bs58.encode(bytes), label: "" };
    });
    seed(wallets);
    const { result } = renderHook(useWatchlist);
    act(() => expect(result.current.add(c)).toEqual({ ok: false, reason: "limit" }));
    expect(result.current.wallets).toEqual(wallets);
  });
});
