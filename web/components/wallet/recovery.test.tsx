import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Portfolio } from "./portfolio";
import { DEMO_ADDRESS, readFixture } from "@/lib/fixtures/wallet";
import type { ResourceName } from "@/lib/dmnd/contracts";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("replaces a queued headline and failed holdings without a click, then stops checking", async () => {
  vi.useFakeTimers();
  const counts = new Map<string, number>();
  const network = vi.fn(async (url: string) => {
    const resource = new URL(url, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName;
    const count = (counts.get(resource) ?? 0) + 1;
    counts.set(resource, count);
    return Response.json(count === 1 && resource === "overview"
      ? { ok: false, kind: "upstream" }
      : readFixture(resource, count === 1 ? "pending" : "complete"));
  });
  vi.stubGlobal("fetch", network);
  render(<Portfolio address={DEMO_ADDRESS} />);
  await act(async () => {});
  expect(screen.getByText(/sources still updating/)).toBeVisible();
  expect(screen.getByText("Couldn’t load this section")).toBeVisible();
  expect(screen.getAllByText("Checking for wallet data automatically…")).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("$12,345.67")).toBeVisible();
  expect(screen.getByText("USD Coin")).toBeVisible();
  expect(screen.queryByText("Couldn’t load this section")).not.toBeInTheDocument();
  expect(screen.queryByText("Checking for wallet data automatically…")).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
  expect(network).toHaveBeenCalledTimes(5);
  expect(counts.get("positions")).toBe(1);
});

it("keeps loaded values visible after a failed manual refresh", async () => {
  vi.useFakeTimers();
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(fail
    ? { ok: false, kind: "upstream" }
    : readFixture(new URL(url, "http://doxxd.test").pathname.split("/").at(-1) as ResourceName, "complete"))));
  render(<Portfolio address={DEMO_ADDRESS} />);
  await act(async () => {});
  fail = true;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh wallet" })));
  expect(screen.getByText("$12,345.67")).toBeVisible();
  expect(screen.getByText("USD Coin")).toBeVisible();
  expect(screen.getAllByText("Showing the last loaded data.")).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
  expect(screen.getAllByText(/Automatic checks have stopped/)).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(2);
});
