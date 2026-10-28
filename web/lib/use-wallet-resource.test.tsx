import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWalletResource } from "./use-wallet-resource";
import { DEMO_ADDRESS, readFixture } from "./fixtures/wallet";
import type { ProtocolResource } from "./dmnd/contracts";
afterEach(() => vi.unstubAllGlobals());
it("never renders a slow previous wallet under the next address", async () => {
  let finishA!: (response: Response) => void;
  let finishB!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          if (url.includes("/wallet/A/")) finishA = resolve;
          else finishB = resolve;
        }),
    ),
  );
  const { result, rerender } = renderHook(
    ({ wallet }) => useWalletResource(wallet, "summary"),
    { initialProps: { wallet: "A" } },
  );
  rerender({ wallet: "B" });
  await act(async () =>
    finishB(new Response(JSON.stringify({ ok: true, data: { wallet: "B" } }))),
  );
  await waitFor(() =>
    expect(result.current.result?.ok && result.current.result.data.wallet).toBe(
      "B",
    ),
  );
  await act(async () =>
    finishA(new Response(JSON.stringify({ ok: true, data: { wallet: "A" } }))),
  );
  expect(result.current.result?.ok && result.current.result.data.wallet).toBe(
    "B",
  );
});
it("never selects demo data from a live wallet query", async () => {
  const network = vi.fn(
    async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify({ ok: false, kind: "configuration" })),
  );
  vi.stubGlobal("fetch", network);
  const { result } = renderHook(() =>
    useWalletResource(DEMO_ADDRESS, "summary"),
  );
  await waitFor(() =>
    expect(result.current.result).toEqual({ ok: false, kind: "configuration" }),
  );
  expect(String(network.mock.calls[0]?.[0])).toContain("/api/wallet/");
});
it("fetches resources only through the same-origin wallet route", async () => {
  const network = vi.fn(
    async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify(readFixture("summary", "complete"))),
  );
  vi.stubGlobal("fetch", network);
  const { result } = renderHook(() =>
    useWalletResource(DEMO_ADDRESS, "summary"),
  );
  await waitFor(() => expect(result.current.result?.ok).toBe(true));
  expect(network).toHaveBeenCalledTimes(1);
  expect(String(network.mock.calls[0]?.[0])).toBe(
    "/api/wallet/" + DEMO_ADDRESS + "/summary",
  );
});
it("bounds simultaneously open protocol requests to four", async () => {
  const finishes: (() => void)[] = [];
  let active = 0,
    max = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          active++;
          max = Math.max(max, active);
          const resource = new URL(url, "http://test").pathname
            .split("/")
            .at(-1) as ProtocolResource;
          finishes.push(() => {
            active--;
            resolve(
              new Response(JSON.stringify(readFixture(resource, "complete"))),
            );
          });
        }),
    ),
  );
  const hooks = (
    [
      "stake",
      "orca",
      "kamino",
      "solend",
      "marginfi",
      "drift",
    ] as ProtocolResource[]
  ).map((resource) =>
    renderHook(() => useWalletResource(DEMO_ADDRESS, resource)),
  );
  await waitFor(() => expect(finishes.length).toBe(4));
  await act(async () => {
    finishes.splice(0).forEach((f) => f());
  });
  await waitFor(() => expect(finishes.length).toBe(2));
  await act(async () => {
    finishes.splice(0).forEach((f) => f());
  });
  await waitFor(() =>
    expect(hooks.every((h) => h.result.current.result?.ok)).toBe(true),
  );
  expect(max).toBe(4);
});
