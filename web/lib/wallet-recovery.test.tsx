import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWalletResource } from "./use-wallet-resource";
import { DEMO_ADDRESS, readFixture } from "./fixtures/wallet";
import type { ResourceName, ResourceError } from "./dmnd/contracts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function respond(...bodies: unknown[]) {
  let index = 0;
  const network = vi.fn(async () => Response.json(bodies[Math.min(index++, bodies.length - 1)]));
  vi.stubGlobal("fetch", network);
  return network;
}

it.each(["summary", "overview", "stake", "kamino", "orca"] as ResourceName[])(
  "updates queued %s automatically and stops when the scan finishes", async (resource) => {
    const done = readFixture(resource, "complete");
    if (done.ok && "coverage" in done.data && "snapshot_status" in done.data.coverage)
      done.data.coverage.snapshot_status = "done"; // Actual live overview terminal status.
    const network = respond(readFixture(resource, "pending"), done);
    const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, resource));
    await flush();
    expect(result.current.recovery).toBe("waiting");
    await advance(4999);
    expect(network).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.current.recovery).toBe("idle");
    expect(result.current.result).toEqual(done);
    await advance(150_000);
    expect(network).toHaveBeenCalledTimes(2);
  },
);

it.each(["upstream", "timeout"] as const)("recovers an initial %s failure", async (kind) => {
  const network = respond({ ok: false, kind }, readFixture("overview", "complete"));
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "overview"));
  await flush();
  expect(result.current.result).toEqual({ ok: false, kind });
  await advance(5000);
  expect(result.current.result?.ok).toBe(true);
  expect(result.current.recovery).toBe("idle");
  expect(network).toHaveBeenCalledTimes(2);
});

it("retains loaded values through a failed refresh and then recovers", async () => {
  const old = readFixture("overview", "pending");
  const done = readFixture("overview", "complete");
  respond(old, { ok: false, kind: "upstream" }, done);
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "overview"));
  await flush();
  await advance(5000);
  expect(result.current.result).toEqual(old);
  expect(result.current.refreshError?.kind).toBe("upstream");
  await advance(5000);
  expect(result.current.result).toEqual(done);
  expect(result.current.refreshError).toBeNull();
});

it("stops after a bounded number of checks; manual refresh starts another window", async () => {
  const network = respond(readFixture("overview", "pending"));
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "overview"));
  await flush();
  await advance(150_000);
  expect(network).toHaveBeenCalledTimes(21); // Initial plus at most twenty rechecks.
  expect(result.current.recovery).toBe("stopped");
  expect(result.current.loading).toBe(false);
  await act(async () => result.current.refresh());
  expect(network).toHaveBeenCalledTimes(22);
  expect(result.current.recovery).toBe("waiting");
});

it("pauses hidden tabs, resumes in the same window, and expires without background requests", async () => {
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  const network = respond(readFixture("summary", "pending"));
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "summary"));
  await flush();
  await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
  expect(result.current.recovery).toBe("paused");
  await advance(30_000);
  expect(network).toHaveBeenCalledTimes(1);
  await act(async () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  await advance(5000);
  expect(network).toHaveBeenCalledTimes(2);
  await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
  await advance(90_000);
  expect(result.current.recovery).toBe("stopped");
  await act(async () => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  await advance(5000);
  expect(network).toHaveBeenCalledTimes(2);
});

it("aborts an automatic request on hide and ignores its late response", async () => {
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  const pending = readFixture("overview", "pending");
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  const network = vi.fn().mockResolvedValueOnce(Response.json(pending))
    .mockImplementationOnce((_url, init) => {
      signal = init.signal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
  vi.stubGlobal("fetch", network);
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "overview"));
  await flush();
  await advance(5000);
  await act(async () => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json(readFixture("overview", "complete"))));
  expect(result.current.result).toEqual(pending);
  expect(result.current.refreshError).toBeNull();
  expect(result.current.recovery).toBe("paused");
});

it("ends the wall-clock window even while an automatic request is unresolved", async () => {
  let signal!: AbortSignal;
  const network = vi.fn().mockResolvedValueOnce(Response.json(readFixture("summary", "pending")))
    .mockImplementationOnce((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
  vi.stubGlobal("fetch", network);
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "summary"));
  await flush();
  await advance(120_000);
  expect(signal.aborted).toBe(true);
  expect(result.current.recovery).toBe("stopped");
  expect(result.current.loading).toBe(false);
  expect(network).toHaveBeenCalledTimes(2);
});

it("does not send a retry before Retry-After, including manual refresh", async () => {
  const network = respond({ ok: false, kind: "rate_limited", retryAfterSeconds: 20 }, readFixture("summary", "complete"));
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "summary"));
  await flush();
  await advance(5000);
  await act(async () => result.current.refresh());
  await advance(14_999);
  expect(network).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(network).toHaveBeenCalledTimes(2);
  expect(result.current.result?.ok).toBe(true);
});

it.each(["configuration", "authentication", "refused", "invalid_input", "unsupported", "unavailable", "not_enabled"] as ResourceError["kind"][])(
  "does not retry a terminal %s error", async (kind) => {
    const network = respond({ ok: false, kind });
    const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "overview"));
    await flush();
    await advance(150_000);
    expect(network).toHaveBeenCalledTimes(1);
    expect(result.current.recovery).toBe("idle");
  },
);

it.each(["partial", "stale", "unpriced"] as const)("does not poll terminal %s coverage", async (scenario) => {
  const data = readFixture("summary", scenario);
  const network = respond(data);
  renderHook(() => useWalletResource(DEMO_ADDRESS, "summary"));
  await flush();
  await advance(150_000);
  expect(network).toHaveBeenCalledTimes(1);
});

it("does not auto-refresh the activity or continuation pages", async () => {
  const network = respond(readFixture("summary", "pending"));
  renderHook(() => useWalletResource(DEMO_ADDRESS, "activity"));
  renderHook(() => useWalletResource(DEMO_ADDRESS, "kamino", { cursor: "page2" }));
  await flush();
  await advance(150_000);
  expect(network).toHaveBeenCalledTimes(2);
});

it("still exposes failed activity refreshes to its existing error UI", async () => {
  const network = respond(readFixture("activity", "complete"), { ok: false, kind: "upstream" });
  const { result } = renderHook(() => useWalletResource(DEMO_ADDRESS, "activity"));
  await flush();
  await act(async () => result.current.refresh());
  expect(result.current.result).toEqual({ ok: false, kind: "upstream" });
  expect(result.current.refreshError).toBeNull();
  expect(result.current.recovery).toBe("idle");
  await advance(150_000);
  expect(network).toHaveBeenCalledTimes(2);
});

it("cancels the old wallet's retries on navigation and all timers on unmount", async () => {
  const network = vi.fn(async (url: string) => {
    const body = readFixture("summary", "pending");
    if (body.ok) body.data.wallet = url.includes("/A/") ? "A" : "B";
    return Response.json(body);
  });
  vi.stubGlobal("fetch", network);
  const { result, rerender, unmount } = renderHook(({ wallet }) => useWalletResource(wallet, "summary"), { initialProps: { wallet: "A" } });
  await flush();
  rerender({ wallet: "B" });
  await flush();
  await advance(5000);
  expect(network.mock.calls.filter(([url]) => url.includes("/A/"))).toHaveLength(1);
  expect(result.current.result?.ok && result.current.result.data.wallet).toBe("B");
  unmount();
  await advance(150_000);
  expect(network).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
