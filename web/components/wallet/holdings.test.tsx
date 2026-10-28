import { render, screen, fireEvent, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import bs58 from "bs58";
import { Holdings } from "./holdings";
import { readFixture } from "@/lib/fixtures/wallet";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
function overview() {
  const result = readFixture("overview", "complete");
  if (!result.ok) throw new Error("Fixture");
  return result.data;
}

// Zero known values and unpriced observations keep the synthetic subtotal
// coherent without introducing a pricing or aggregation rule in this view.
function largeOverview() {
  const data = overview();
  data.assets = Array.from({ length: 45 }, (_, index) => ({
    ...data.assets[0],
    mint: bs58.encode(new Uint8Array(32).fill(index + 20)),
    symbol: index === 43 ? null : index === 42 ? "" : "TOKEN" + index,
    name: index === 43 ? null : index === 42 ? "" : "Observed token " + index,
    amount: index < 2 ? "0" : index === 44 ? "10000000000000001" : "1",
    decimals: 9,
    ui_amount: index < 2 ? "0" : index === 44 ? "10000000.000000001" : "0.000000001",
    price_usd: null,
    value_usd: index < 2 ? "0" : null,
    estimated_value_usd: null,
    price_updated_at: null,
    last_slot: index,
  }));
  data.native_sol_lamports = "0";
  data.native_sol_value_usd = "0";
  data.native_sol_slot = 101;
  data.wrapped_sol_lamports = "1000000000";
  data.wrapped_sol_value_usd = null;
  data.wrapped_sol_slot = 202;
  data.sol_price_usd = null;
  data.sol_price_updated_at = null;
  data.known_value_usd = "0";
  data.unpriced_asset_count = 44;
  data.coverage = {
    ...data.coverage,
    complete: false,
    reason: "snapshot_queued",
    snapshot_status: "queued",
    token_snapshot_slot: 99,
    native_sol_lamports: data.native_sol_lamports,
    native_sol_slot: data.native_sol_slot,
    wrapped_sol_lamports: data.wrapped_sol_lamports,
    wrapped_sol_slot: data.wrapped_sol_slot,
  };
  expect(validResourcePayload("overview", data)).toBe(true);
  return data;
}
function holdingButtons() {
  return screen.getAllByRole("button", { name: /^Inspect .*holding$/ });
}
function searchFor(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search observed holdings" }), {
    target: { value },
  });
}

it("bounds loaded observations to 20 rows per page without changing the DTO or fetching", () => {
  const data = largeOverview();
  const original = structuredClone(data);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    render(<Holdings overview={data} />);
    const pages = screen.getByRole("navigation", { name: "Holdings pages" });
    const previous = within(pages).getByRole("button", { name: "Previous holdings" });
    const next = within(pages).getByRole("button", { name: "Next holdings" });
    expect(holdingButtons()).toHaveLength(20);
    expect(screen.getByText("Showing 1–20 of 47 observed holdings")).toBeVisible();
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    expect(holdingButtons().slice(0, 3).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Inspect TOKEN0 holding", "Inspect TOKEN1 holding", "Inspect SOL holding"]);
    fireEvent.click(holdingButtons()[0]);
    expect(screen.getByText("Raw atoms")).toBeVisible();
    fireEvent.click(next);
    expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
    expect(holdingButtons()).toHaveLength(20);
    expect(screen.getByText("Showing 21–40 of 47 observed holdings")).toBeVisible();
    fireEvent.click(next);
    expect(holdingButtons()).toHaveLength(7);
    expect(screen.getByText("Showing 41–47 of 47 observed holdings")).toBeVisible();
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inspect TOKEN44 holding" })).toBeVisible();
    fireEvent.click(previous);
    expect(screen.getByText("Showing 21–40 of 47 observed holdings")).toBeVisible();
    expect(holdingButtons()).toHaveLength(20);
    fireEvent.click(previous);
    expect(screen.getByText("Showing 1–20 of 47 observed holdings")).toBeVisible();
    searchFor("TOKEN44");
    fireEvent.click(screen.getByRole("button", { name: "Inspect TOKEN44 holding" }));
    searchFor("no-such-observation");
    fireEvent.click(screen.getByRole("button", { name: "Clear holdings search" }));
    expect(screen.getByRole("heading", { name: "Wallet holdings 47" })).toBeVisible();
    expect(data).toEqual(original);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

it("searches every loaded observed symbol, name and mint with null or empty metadata retained", () => {
  const data = largeOverview();
  render(<Holdings overview={data} />);
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" }))
    .toHaveAttribute("placeholder", "Token name, symbol or mint");
  for (const query of ["  tOkEn44  ", "OBSERVED TOKEN 44", data.assets[44].mint.toUpperCase()]) {
    searchFor(query);
    expect(holdingButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Inspect TOKEN44 holding" })).toBeVisible();
    expect(screen.getByText("Showing 1–1 of 1 matching observed holdings (47 observed holdings total)")).toBeVisible();
  }
  for (const index of [42, 43]) {
    searchFor(data.assets[index].mint);
    expect(holdingButtons()).toHaveLength(1);
    fireEvent.click(holdingButtons()[0]);
    expect(screen.getByRole("link", { name: data.assets[index].mint })).toBeVisible();
  }
  searchFor("native-sol");
  expect(screen.getByRole("button", { name: "Inspect SOL holding" })).toBeVisible();
  searchFor("wrapped-sol");
  expect(screen.getByRole("button", { name: "Inspect WSOL holding" })).toBeVisible();
  searchFor("   ");
  expect(holdingButtons()).toHaveLength(20);
  expect(screen.getByText("Showing 1–20 of 47 observed holdings")).toBeVisible();
});

it.each(["", " \t\n ", null])("labels missing metadata %j with a searchable mint fallback", (metadata) => {
  const data = largeOverview();
  const asset = data.assets[44];
  asset.symbol = metadata;
  asset.name = metadata;
  const original = structuredClone(data);
  expect(validResourcePayload("overview", data)).toBe(true);
  render(<Holdings overview={data} />);
  searchFor(asset.mint);
  const identity = asset.mint.slice(0, 5) + "…" + asset.mint.slice(-5);
  const expander = screen.getByRole("button", { name: "Inspect " + identity + " holding" });
  expect(within(expander).getByText(identity, { selector: "strong" })).toBeVisible();
  expect(within(expander).getByText("Unknown token")).toBeVisible();
  fireEvent.click(expander);
  expect(expander).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("link", { name: asset.mint })).toBeVisible();
  expect(screen.getByText("10000000000000001", { exact: true })).toBeVisible();
  expect(data).toEqual(original);
});

it("preserves nonblank source metadata when testing for missing labels", () => {
  const data = largeOverview();
  data.assets[44].symbol = "  TOKEN44  ";
  data.assets[44].name = "  Observed token 44  ";
  const original = structuredClone(data);
  render(<Holdings overview={data} />);
  searchFor(data.assets[44].mint);
  const expander = screen.getByRole("button", { name: "Inspect TOKEN44 holding" });
  expect(expander.querySelector("strong")?.textContent).toBe("  TOKEN44  ");
  expect(expander.querySelector("small")?.textContent).toBe("  Observed token 44  ");
  expect(data).toEqual(original);
});

it("keeps raw details, source clocks, coverage and the known subtotal independent of the search", () => {
  const data = largeOverview();
  const original = structuredClone(data);
  render(<Holdings overview={data} />);
  searchFor("TOKEN44");
  fireEvent.click(screen.getByRole("button", { name: "Inspect TOKEN44 holding" }));
  expect(screen.getByText("10000000000000001", { exact: true })).toBeVisible();
  expect(screen.getByText("10000000.000000001 TOKEN44")).toBeVisible();
  expect(within(screen.getByText("Balance observation slot").parentElement!).getByText("44")).toBeVisible();
  for (const [query, symbol, slot] of [["native-sol", "SOL", "101"], ["wrapped-sol", "WSOL", "202"]]) {
    searchFor(query);
    expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect " + symbol + " holding" }));
    expect(within(screen.getByText("Balance observation slot").parentElement!).getByText(slot)).toBeVisible();
  }
  expect(screen.getByText("$0.00", { selector: ".section-heading > span" })).toBeVisible();
  const coverage = screen.getByText(/Token coverage is incomplete/).closest("details")!;
  expect(coverage).toHaveTextContent("44 unpriced");
  expect(coverage).toHaveTextContent("Snapshot status: queued. Token slot: 99.");
  expect(data).toEqual(original);
});

it("retains the authoritative known subtotal when a filter only matches an unpriced observation", () => {
  const data = overview();
  data.assets.push(...largeOverview().assets.slice(2));
  data.unpriced_asset_count = 43;
  expect(validResourcePayload("overview", data)).toBe(true);
  render(<Holdings overview={data} />);
  searchFor("TOKEN44");
  const row = screen.getByRole("button", { name: "Inspect TOKEN44 holding" }).closest("tr")!;
  expect(within(row).getAllByText("—")).toHaveLength(2);
  expect(screen.getByText("$7,200.00", { selector: ".section-heading > span" })).toBeVisible();
  expect(screen.getByText(/Token snapshot observed/)).toHaveTextContent("43 unpriced");
});

it("resets paging and expansion for search changes and distinguishes no matches from an empty source", () => {
  render(<Holdings overview={largeOverview()} />);
  fireEvent.click(screen.getByRole("button", { name: "Next holdings" }));
  fireEvent.click(holdingButtons()[0]);
  searchFor("TOKEN");
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
  expect(screen.getByText("Showing 1–20 of 45 matching observed holdings (47 observed holdings total)")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next holdings" }));
  expect(screen.getByText("Showing 21–40 of 45 matching observed holdings (47 observed holdings total)")).toBeVisible();
  searchFor("no-such-observation");
  expect(screen.getByText("No observed holdings match this search.")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText("No token balances in the available snapshot")).not.toBeInTheDocument();
  expect(screen.queryByText("Token balances aren’t available yet")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear holdings search" }));
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" })).toHaveValue("");
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" })).toHaveFocus();
  expect(screen.getByText("Showing 1–20 of 47 observed holdings")).toBeVisible();
  expect(holdingButtons()).toHaveLength(20);
});

it("clamps the current filtered page when refreshed data shrinks and resets for a new wallet", () => {
  const data = largeOverview();
  const { rerender } = render(<Holdings overview={data} />);
  searchFor("TOKEN");
  fireEvent.click(screen.getByRole("button", { name: "Next holdings" }));
  fireEvent.click(screen.getByRole("button", { name: "Next holdings" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspect TOKEN44 holding" }));
  const smaller = { ...data, assets: data.assets.slice(0, 22), unpriced_asset_count: 21 };
  expect(validResourcePayload("overview", smaller)).toBe(true);
  rerender(<Holdings overview={smaller} />);
  expect(screen.getByText("Showing 21–22 of 22 matching observed holdings (24 observed holdings total)")).toBeVisible();
  expect(holdingButtons()).toHaveLength(2);
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
  rerender(<Holdings overview={data} />);
  expect(screen.getByText("Showing 21–40 of 45 matching observed holdings (47 observed holdings total)")).toBeVisible();
  fireEvent.click(holdingButtons()[0]);
  expect(screen.getByText("Raw atoms")).toBeVisible();
  const other = { ...data, wallet: bs58.encode(new Uint8Array(32).fill(90)) };
  expect(validResourcePayload("overview", other)).toBe(true);
  rerender(<Holdings overview={other} />);
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" })).toHaveValue("");
  expect(screen.getByText("Showing 1–20 of 47 observed holdings")).toBeVisible();
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
  searchFor("TOKEN44");
  const pending = {
    ...other,
    assets: [],
    native_sol_lamports: null,
    native_sol_slot: null,
    wrapped_sol_lamports: null,
    wrapped_sol_slot: null,
    native_sol_value_usd: null,
    unpriced_asset_count: 0,
    coverage: {
      ...other.coverage,
      token_snapshot_slot: null,
      native_sol_lamports: null,
      native_sol_slot: null,
      wrapped_sol_lamports: null,
      wrapped_sol_slot: null,
    },
  };
  expect(validResourcePayload("overview", pending)).toBe(true);
  rerender(<Holdings overview={pending} />);
  expect(screen.getByText("Token balances aren’t available yet")).toBeVisible();
  expect(screen.getByText("Native SOL balance: Unknown")).toBeVisible();
  expect(screen.getByText("Wrapped SOL balance: Unknown")).toBeVisible();
  expect(screen.queryByText("No observed holdings match this search.")).not.toBeInTheDocument();
});
it("retains separate SOL, wrapped SOL and token balance slots including zero and unknown", () => {
  const data = overview();
  data.native_sol_slot = 101;
  data.wrapped_sol_lamports = "1000000000";
  data.wrapped_sol_slot = 202;
  data.assets[0].last_slot = 0;
  data.assets[1].last_slot = 303;
  render(<Holdings overview={data} />);
  for (const [symbol, slot] of [
    ["SOL", "101"],
    ["WSOL", "202"],
    ["USDC", "0"],
    ["JitoSOL", "303"],
  ]) {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect " + symbol + " holding",
      }),
    );
    const clock = screen.getByText("Balance observation slot").parentElement!;
    expect(within(clock).getByText(slot, { exact: true })).toBeVisible();
    expect(screen.getByText("Price observation")).toBeVisible();
  }
});
it('keeps an unknown native balance slot separate from a known quantity',()=>{
  const data=overview();data.native_sol_slot=null;
  render(<Holdings overview={data}/>);
  fireEvent.click(screen.getByRole('button',{name:'Inspect SOL holding'}));
  expect(within(screen.getByText('Balance observation slot').parentElement!).getByText('Unknown')).toBeVisible();
  expect(screen.getByText('20 SOL')).toBeVisible();
});
it("does not turn token-only completeness into an empty SOL wallet", () => {
  const data = overview();
  data.assets = [];
  data.native_sol_lamports = null;
  data.wrapped_sol_lamports = null;
  data.coverage.complete = true;
  data.known_value_usd = "0";
  render(<Holdings overview={data} />);
  expect(
    screen.getByText("No token balances in the available snapshot"),
  ).toBeVisible();
  expect(screen.getByText("Native SOL balance: Unknown")).toBeVisible();
  expect(screen.getByText("Wrapped SOL balance: Unknown")).toBeVisible();
  expect(
    screen.queryByText("No holdings in the available snapshot"),
  ).not.toBeInTheDocument();
});
it("keeps missing SOL sources explicit while token rows are present", () => {
  const data = overview();
  data.native_sol_lamports = null;
  data.wrapped_sol_lamports = null;
  render(<Holdings overview={data} />);
  expect(
    screen.getByRole("button", { name: "Inspect USDC holding" }),
  ).toBeVisible();
  expect(screen.getByText("Native SOL balance: Unknown")).toBeVisible();
  expect(screen.getByText("Wrapped SOL balance: Unknown")).toBeVisible();
});

it("retains a large wrapped SOL observation before token inventory completes", () => {
  const data = overview();
  data.assets = [];
  data.known_value_usd = "0";
  data.unpriced_asset_count = 1;
  data.native_sol_lamports = null;
  data.native_sol_slot = null;
  data.native_sol_value_usd = null;
  data.wrapped_sol_lamports = "10000000000000001";
  data.wrapped_sol_slot = 460400689;
  data.wrapped_sol_value_usd = null;
  data.sol_price_usd = null;
  data.sol_price_updated_at = null;
  data.coverage = {
    ...data.coverage,
    complete: false,
    reason: "snapshot_queued",
    snapshot_status: "queued",
    token_snapshot_slot: null,
    native_sol_lamports: null,
    native_sol_slot: null,
    wrapped_sol_lamports: data.wrapped_sol_lamports,
    wrapped_sol_slot: data.wrapped_sol_slot,
  };
  expect(validResourcePayload("overview", data)).toBe(true);
  render(<Holdings overview={data} />);
  expect(screen.getByText("Native SOL balance: Unknown")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Inspect WSOL holding" }));
  expect(screen.getByText("10000000000000001", { exact: true })).toBeVisible();
  expect(screen.getByText("10000000.000000001 WSOL", { exact: true })).toBeVisible();
  const clock = screen.getByText("Balance observation slot").parentElement!;
  expect(within(clock).getByText("460400689", { exact: true })).toBeVisible();
  const coverage = screen.getByText(/Token coverage is incomplete/).closest("details")!;
  expect(coverage).toHaveTextContent("1 unpriced");
  expect(within(coverage).getByText(/Token slot: Unknown/)).toBeInTheDocument();
});
