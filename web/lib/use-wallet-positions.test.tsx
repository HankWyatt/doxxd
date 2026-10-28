import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEMO_ADDRESS, readFixture } from "./fixtures/wallet";
import { useWalletPositions } from "./use-wallet-positions";
import { WalletRefreshContext } from "./use-wallet-resource";
import type { Schemas } from "./dmnd/contracts";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function page(): Schemas["WalletPositions"] {
  const result = readFixture("positions", "complete");
  if (!result.ok) throw Error("fixture");
  return { ...result.data, sort: "value" };
}
function Probe({ wallet = DEMO_ADDRESS }: { wallet?: string }) {
  const data = useWalletPositions(wallet, { kind: "live" });
  return <>
    <output data-testid="count">{data.loadedCount}</output>
    <output data-testid="mints">{[...data.positions.keys()].join(",")}</output>
    <output data-testid="error">{data.error?.kind}</output>
    <output data-testid="continuation">{String(data.continuationUnavailable)}</output>
    <button disabled={!data.hasMore || data.loading} onClick={data.loadMore}>More</button>
    <button onClick={data.reload}>Reload</button>
  </>;
}

it("loads one independent page, retains earlier rows, and only follows on a click", async () => {
  const first = page();
  first.has_more = true;
  first.cursor = "page-two";
  first.position_count = 2;
  const second = page();
  second.data = [{ ...second.data[0], mint: "So11111111111111111111111111111111111111112" }];
  second.position_count = 2;
  const fetcher = vi.fn(async (input: string) => Response.json({
    ok: true, data: input.includes("cursor=page-two") ? second : first,
  }));
  vi.stubGlobal("fetch", fetcher);
  render(<Probe />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(fetcher.mock.calls[0][0], "http://test.local");
  expect(url.pathname).toBe("/api/wallet/" + DEMO_ADDRESS + "/positions");
  expect(url.searchParams.get("sort")).toBe("value");
  expect(url.searchParams.get("limit")).toBe("100");
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
  expect(screen.getByTestId("mints")).toHaveTextContent(first.data[0].mint);
  expect(screen.getByTestId("mints")).toHaveTextContent(second.data[0].mint);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
});

it("keeps prior data after continuation failure and reloads from the first page", async () => {
  const first = page(); first.has_more = true; first.cursor = "expired";
  const fetcher = vi.fn(async (input: string) => Response.json(input.includes("cursor=")
    ? { ok: false, kind: "invalid_input" }
    : { ok: true, data: first }));
  vi.stubGlobal("fetch", fetcher);
  render(<Probe />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("invalid_input"));
  expect(screen.getByTestId("count")).toHaveTextContent("1");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(fetcher.mock.calls[2][0]).not.toContain("cursor=");
});

it("refuses repeated cursors instead of looping or fetching automatically", async () => {
  const first = page(); first.has_more = true; first.cursor = "same";
  const fetcher = vi.fn(async () => Response.json({ ok: true, data: first }));
  vi.stubGlobal("fetch", fetcher);
  render(<Probe />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByTestId("continuation")).toHaveTextContent("true"));
  expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("starts a fresh first page on wallet refresh instead of mixing frozen result pages", async () => {
  const first = page(); first.has_more = true; first.cursor = "page-two";
  const second = { ...page(), data: [], position_count: 1 };
  const fetcher = vi.fn(async (input: string) => Response.json({
    ok: true, data: input.includes("cursor=") ? second : first,
  }));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<WalletRefreshContext.Provider value={0}><Probe /></WalletRefreshContext.Provider>);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  rerender(<WalletRefreshContext.Provider value={1}><Probe /></WalletRefreshContext.Provider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(fetcher.mock.calls[2][0]).not.toContain("cursor=");
});

it("does not bypass a continuation Retry-After by resetting its cursor", async () => {
  const first = page(); first.has_more = true; first.cursor = "page-two";
  const fetcher = vi.fn(async (input: string) => Response.json(input.includes("cursor=")
    ? { ok: false, kind: "rate_limited", retryAfterSeconds: 60 }
    : { ok: true, data: first }));
  vi.stubGlobal("fetch", fetcher);
  render(<Probe />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("rate_limited"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload" })));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("count")).toHaveTextContent("1");
});

it("preserves a continuation Retry-After through the wallet Refresh action", async () => {
  const first = page(); first.has_more = true; first.cursor = "page-two";
  const fetcher = vi.fn(async (input: string) => Response.json(input.includes("cursor=")
    ? { ok: false, kind: "rate_limited", retryAfterSeconds: 60 }
    : { ok: true, data: first }));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<WalletRefreshContext.Provider value={0}><Probe /></WalletRefreshContext.Provider>);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("rate_limited"));
  await act(async () => rerender(<WalletRefreshContext.Provider value={1}><Probe /></WalletRefreshContext.Provider>));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId("count")).toHaveTextContent("1");
  const later = Date.now() + 61_000;
  vi.spyOn(Date, "now").mockReturnValue(later);
  rerender(<WalletRefreshContext.Provider value={2}><Probe /></WalletRefreshContext.Provider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(fetcher.mock.calls[2][0]).not.toContain("cursor=");
});

it("never carries another wallet's loaded mint rows into a new wallet", async () => {
  const first = page();
  const otherWallet = "11111111111111111111111111111111";
  const second = page();
  second.wallet = otherWallet;
  second.data = [{ ...second.data[0], mint: "So11111111111111111111111111111111111111112" }];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json({
    ok: true, data: input.includes(otherWallet) ? second : first,
  })));
  const { rerender } = render(<Probe />);
  await waitFor(() => expect(screen.getByTestId("mints")).toHaveTextContent(first.data[0].mint));
  rerender(<Probe wallet={otherWallet} />);
  expect(screen.getByTestId("mints")).not.toHaveTextContent(first.data[0].mint);
  await waitFor(() => expect(screen.getByTestId("mints")).toHaveTextContent(second.data[0].mint));
});
