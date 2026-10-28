import { render, screen, fireEvent, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import bs58 from "bs58";
import { Holdings, splitRows, type Row } from "./holdings";
import { readFixture } from "@/lib/fixtures/wallet";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import type { Schemas } from "@/lib/dmnd/contracts";
import type { HoldingsTradingDetails } from "@/lib/indexed-trading";
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
function showCollapsed() {
  fireEvent.click(screen.getByRole("button", { name: /tokens? with no price or tiny balances · show$/ }));
}
function openDetails() {
  const details = document.querySelector("details.coverage-note") as HTMLDetailsElement;
  details.open = true;
  return details;
}
function searchFor(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search observed holdings" }), {
    target: { value },
  });
}
function indexedPosition(overrides: Partial<Schemas["WalletPosition"]> = {}): Schemas["WalletPosition"] {
  const fixture = readFixture("positions", "complete");
  if (!fixture.ok) throw new Error("Fixture");
  return {
    ...fixture.data.data[0],
    bought: { amount: "1000.000000001", sol: "2", usd: "400", count: 4 },
    sold: { amount: "100", sol: "0.5", usd: "90", count: 2 },
    avg_buy_price_usd: "0.4",
    avg_sell_price_usd: "0.9",
    realized_pnl_usd: "50",
    unrealized_pnl_usd: "100",
    total_pnl_usd: "150",
    ...overrides,
  };
}
function tradingDetails(
  positions: Schemas["WalletPosition"][] = [indexedPosition()],
  overrides: Partial<HoldingsTradingDetails> = {},
): HoldingsTradingDetails {
  return {
    positions: new Map(positions.map((position) => [position.mint, position])),
    loading: false,
    error: null,
    positionsTracked: true,
    positionsSince: "2026-10-26T12:00:00Z",
    loadedCount: positions.length,
    positionCount: positions.length,
    hasMore: false,
    continuationUnavailable: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  };
}
function holdingRow(symbol: string) {
  return screen.getByRole("button", { name: "Inspect " + symbol + " holding" }).closest("tr")!;
}

it("renders token images from public CDNs without sending the page referrer", () => {
  const data = overview();
  data.assets[0].image_url = "https://cdn.backpack.exchange/token.png";
  const { container } = render(<Holdings overview={data} />);
  const image = container.querySelector('img[src="https://cdn.backpack.exchange/token.png"]');
  expect(image).toBeInTheDocument();
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(image).toHaveAttribute("loading", "lazy");
});

it("falls back on a broken image and tries a newly supplied image URL", () => {
  const data = overview();
  data.assets[0].image_url = "https://tokens.example.com/old.png";
  const { container, rerender } = render(<Holdings overview={data} />);
  const image = container.querySelector('img[src="https://tokens.example.com/old.png"]')!;
  fireEvent.error(image);
  expect(container.querySelector("img")).not.toBeInTheDocument();
  const updated = structuredClone(data);
  updated.assets[0].image_url = "https://tokens.example.com/new.png";
  rerender(<Holdings overview={updated} />);
  expect(container.querySelector('img[src="https://tokens.example.com/new.png"]')).toBeInTheDocument();
});

it("provides a local native SOL icon without relying on token metadata", () => {
  render(<Holdings overview={overview()} />);
  const button = screen.getByRole("button", { name: "Inspect SOL holding" });
  expect(button.querySelector("svg[viewBox='0 0 32 32']")).toBeInTheDocument();
  expect(button.querySelector("img")).not.toBeInTheDocument();
});

it("tries an alternate IPFS gateway once, then falls back without a retry loop", () => {
  const data = overview();
  const cid = "QmbLnVVK29LbUNic4XMeMKb1f8kACbKYfzTVfZAxFgN4s5";
  data.assets[0].image_url = `ipfs://${cid}/token.png`;
  const { container } = render(<Holdings overview={data} />);
  expect(container.querySelector("img")).toHaveAttribute("src", `https://gateway.pinata.cloud/ipfs/${cid}/token.png`);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toHaveAttribute("src", `https://ipfs.io/ipfs/${cid}/token.png`);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toHaveAttribute("src", `https://dweb.link/ipfs/${cid}/token.png`);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search observed holdings" }), { target: { value: "" } });
  expect(container.querySelector("img")).not.toBeInTheDocument();
});

it("collapses unpriced observations behind one line without changing the DTO or fetching", () => {
  const data = largeOverview();
  const original = structuredClone(data);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    render(<Holdings overview={data} />);
    // Zero and unpriced values are all collapsed, so no table row is listed.
    expect(screen.queryAllByRole("button", { name: /^Inspect .*holding$/ })).toHaveLength(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Holdings pages" })).not.toBeInTheDocument();
    showCollapsed();
    expect(holdingButtons()).toHaveLength(47);
    expect(holdingButtons().slice(0, 3).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Inspect TOKEN0 holding", "Inspect TOKEN1 holding", "Inspect SOL holding"]);
    fireEvent.click(holdingButtons()[0]);
    expect(screen.getByText("Raw atoms")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide 47 tokens with no price or tiny balances" }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    searchFor("TOKEN44");
    fireEvent.click(screen.getByRole("button", { name: "Inspect TOKEN44 holding" }));
    searchFor("no-such-observation");
    fireEvent.click(screen.getByRole("button", { name: "Clear holdings search" }));
    expect(screen.getByRole("heading", { name: "Wallet" })).toBeVisible();
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
    expect(screen.getByRole("status")).toHaveTextContent("1 of 47 observed holdings match");
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
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByRole("button", { name: "+47 tokens with no price or tiny balances · show" })).toBeVisible();
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
  expect(screen.getByText("$0.00", { selector: ".holdings-total" })).toBeVisible();
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
  const cells = within(row).getAllByRole("cell");
  expect(cells).toHaveLength(5);
  expect(cells[1]).toHaveTextContent("—");
  expect(cells[4]).toHaveTextContent("—");
  expect(screen.getByText("$7,200.00", { selector: ".holdings-total" })).toBeVisible();
  expect(screen.getByText(/Token snapshot observed/)).toHaveTextContent("43 unpriced");
});

it("resets expansion for search changes and distinguishes no matches from an empty source", () => {
  render(<Holdings overview={largeOverview()} />);
  showCollapsed();
  fireEvent.click(holdingButtons()[0]);
  expect(screen.getByText("Raw atoms")).toBeVisible();
  searchFor("TOKEN");
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("45 of 47 observed holdings match");
  expect(holdingButtons()).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: "Show all 45 matches" }));
  expect(holdingButtons()).toHaveLength(45);
  searchFor("TOKEN4");
  expect(holdingButtons()).toHaveLength(4);
  searchFor("no-such-observation");
  expect(screen.getByText("No observed holdings match this search.")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText("No token balances in the available snapshot")).not.toBeInTheDocument();
  expect(screen.queryByText("Token balances aren’t available yet")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear holdings search" }));
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" })).toHaveValue("");
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" })).toHaveFocus();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  // Clearing the search returns to the list as the reader left it.
  expect(screen.getByRole("button", { name: "Hide 47 tokens with no price or tiny balances" })).toBeVisible();
});

it("keeps refreshed data readable and resets search and expansion for a new wallet", () => {
  const data = largeOverview();
  const { rerender } = render(<Holdings overview={data} />);
  searchFor("TOKEN");
  fireEvent.click(screen.getByRole("button", { name: "Show all 45 matches" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspect TOKEN44 holding" }));
  const smaller = { ...data, assets: data.assets.slice(0, 22), unpriced_asset_count: 21 };
  expect(validResourcePayload("overview", smaller)).toBe(true);
  rerender(<Holdings overview={smaller} />);
  expect(screen.getByRole("status")).toHaveTextContent("22 of 24 observed holdings match");
  expect(screen.queryByRole("button", { name: "Inspect TOKEN44 holding" })).not.toBeInTheDocument();
  rerender(<Holdings overview={data} />);
  expect(screen.getByRole("status")).toHaveTextContent("45 of 47 observed holdings match");
  fireEvent.click(holdingButtons()[0]);
  expect(screen.getByText("Raw atoms")).toBeVisible();
  const other = { ...data, wallet: bs58.encode(new Uint8Array(32).fill(90)) };
  expect(validResourcePayload("overview", other)).toBe(true);
  rerender(<Holdings overview={other} />);
  expect(screen.getByRole("searchbox", { name: "Search observed holdings" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "+47 tokens with no price or tiny balances · show" })).toBeVisible();
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
  showCollapsed();
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

it("shows a generic failed-refresh notice while preserving available holdings and unknown native balances", () => {
  const data = overview();
  data.native_sol_lamports = null;
  data.wrapped_sol_lamports = null;
  data.coverage.snapshot_status = "failed";
  data.coverage.complete = false;
  const original = structuredClone(data);
  render(<Holdings overview={data} />);
  expect(screen.getByText("Wallet refresh failed. Showing available holdings; some balances may be missing or out of date.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Inspect USDC holding" })).toBeVisible();
  expect(screen.getByText("$7,200.00", { selector: ".holdings-total" })).toBeVisible();
  expect(screen.getByText("Native SOL balance: Unknown")).toBeVisible();
  expect(screen.getByText("Wrapped SOL balance: Unknown")).toBeVisible();
  expect(data).toEqual(original);
});

it.each(["queued", "running", "done", "not_requested"])(
  "does not infer a failed refresh from the %s snapshot status",
  (status) => {
    const data = overview();
    data.coverage.snapshot_status = status;
    data.coverage.reason = "snapshot_failed";
    render(<Holdings overview={data} />);
    expect(screen.queryByText(/Wallet refresh failed/)).not.toBeInTheDocument();
  },
);

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
  showCollapsed();
  fireEvent.click(screen.getByRole("button", { name: "Inspect WSOL holding" }));
  expect(screen.getByText("10000000000000001", { exact: true })).toBeVisible();
  expect(screen.getByText("10000000.000000001 WSOL", { exact: true })).toBeVisible();
  const clock = screen.getByText("Balance observation slot").parentElement!;
  expect(within(clock).getByText("460400689", { exact: true })).toBeVisible();
  const coverage = screen.getByText(/Token coverage is incomplete/).closest("details")!;
  expect(coverage).toHaveTextContent("1 unpriced");
  expect(within(coverage).getByText(/Token slot: Unknown/)).toBeInTheDocument();
});

it("compacts token balances while preserving exact expanded quantities and highlighted known values", () => {
  const data = overview();
  const original = structuredClone(data);
  render(<Holdings overview={data} />);
  const row = holdingRow("BONK");
  const cells = within(row).getAllByRole("cell");
  expect(cells[2]).toHaveTextContent("10M");
  expect(cells[2].querySelector("span")).toHaveAttribute("title", "10000000 BONK");
  expect(row.querySelector(".holding-balance-mobile")).toHaveTextContent("Balance 10M");
  expect(row.querySelector(".holdings-value")).toHaveTextContent("$200.00");
  expect(within(holdingRow("USDC")).getAllByRole("cell")[2]).toHaveTextContent("1.8K");
  fireEvent.click(screen.getByRole("button", { name: "Inspect BONK holding" }));
  expect(screen.getByText("10000000 BONK", { exact: true })).toBeVisible();
  expect(screen.getByText("100000000000000", { exact: true })).toBeVisible();
  expect(screen.getByText("Raw atoms").closest("td")).toHaveAttribute("colspan", "5");
  expect(data).toEqual(original);
});

it("keeps estimated and missing holdings values distinct from highlighted known values", () => {
  const data = overview();
  data.assets[0].value_usd = null;
  data.assets[0].estimated_value_usd = "12.34";
  data.assets[1].value_usd = null;
  render(<Holdings overview={data} />);
  // An estimate of at least a cent counts as priced: listed without expanding.
  const estimated = holdingRow("USDC");
  expect(estimated.querySelector(".holdings-value")).not.toBeInTheDocument();
  expect(within(estimated).getByText("estimate")).toBeVisible();
  expect(within(estimated).getByText("$12.34")).toBeVisible();
  showCollapsed();
  const unknown = holdingRow("JitoSOL");
  expect(unknown.querySelector(".holdings-value")).not.toBeInTheDocument();
  expect(within(unknown).getAllByRole("cell")[4]).toHaveTextContent("—");
});

it("joins indexed trading details by mint while preserving holdings valuations and explicit estimate basis", () => {
  const data = overview();
  const positive = indexedPosition({ pnl_percent: "999" });
  const negative = indexedPosition({
    mint: data.assets[0].mint,
    symbol: "WRONG SOURCE LABEL",
    value_usd: "999999",
    total_pnl_usd: "-25",
  });
  render(<Holdings overview={data} trading={tradingDetails([positive, negative])} />);
  expect(screen.getByRole("columnheader", { name: /^P&L/ })).toBeVisible();
  expect(screen.queryByRole("columnheader", { name: "Buys" })).not.toBeInTheDocument();
  // The partial-history caveat lives in the card's details, not above the table.
  const note = screen.getByText(/Trading history is partial/);
  expect(note.closest("details")).toHaveClass("coverage-note");
  expect(note).toHaveTextContent("opening balances, transfers or fees");
  expect(screen.getByText(/Buy\/sell USD totals include priced indexed fills/)).toHaveTextContent("counts include all indexed trades");
  openDetails();
  expect(note).toBeVisible();
  const jup = holdingRow("JUP");
  expect(within(jup).getByText("+$150.00")).toHaveClass("positive");
  // Buys, sells and the last trade moved from the row into its details.
  expect(within(jup).getAllByRole("cell")).toHaveLength(5);
  expect(within(jup).queryByText("4 trades")).not.toBeInTheDocument();
  expect(jup.querySelector("time")).not.toBeInTheDocument();
  const usdc = holdingRow("USDC");
  expect(within(usdc).getByText("-$25.00")).toHaveClass("negative");
  expect(usdc.querySelector(".holdings-value")).toHaveTextContent("$1,800.00");
  expect(screen.queryByText("WRONG SOURCE LABEL")).not.toBeInTheDocument();
  expect(screen.queryByText("999%")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Inspect JUP holding" }));
  const detail = screen.getByText("Indexed realized P&L estimate").closest("dl")!;
  expect(within(screen.getByText("Indexed realized P&L estimate").parentElement!).getByText("+$50.00")).toBeVisible();
  expect(within(screen.getByText("Indexed unrealized P&L estimate").parentElement!).getByText("+$100.00")).toBeVisible();
  expect(within(detail).getByText("1000.000000001 JUP")).toBeVisible();
  expect(within(detail).getByText("100 JUP")).toBeVisible();
  const recordedBuys = screen.getByText("Recorded buys").parentElement!;
  expect(within(recordedBuys).getByText("$400.00")).toBeVisible();
  expect(within(recordedBuys).getByText("4 trades")).toBeVisible();
  expect(within(recordedBuys).getByText("$400.00", { selector: ".holding-trade-buy" })).toBeVisible();
  const recordedSells = screen.getByText("Recorded sells").parentElement!;
  expect(within(recordedSells).getByText("$90.00")).toBeVisible();
  expect(within(recordedSells).getByText("2 trades")).toBeVisible();
  expect(within(screen.getByText("Average indexed buy price").parentElement!).getByText("$0.40")).toBeVisible();
  expect(screen.getByText("P&L estimate basis").parentElement!).toHaveTextContent("partial history");
  expect(within(screen.getByText("Last indexed trade").parentElement!).getByText(new Date(positive.last_trade_at).toLocaleString())).toBeVisible();
});

it("leaves missing mint details unknown and never lends WSOL trading results to native SOL", () => {
  const data = overview();
  data.wrapped_sol_lamports = "1000000000";
  data.wrapped_sol_value_usd = "150";
  const wsol = indexedPosition({ mint: "So11111111111111111111111111111111111111112" });
  render(<Holdings overview={data} trading={tradingDetails([wsol])} />);
  for (const symbol of ["SOL", "USDC"]) {
    const cells = within(holdingRow(symbol)).getAllByRole("cell");
    expect(cells).toHaveLength(5);
    expect(cells[3]).toHaveTextContent("—");
    expect(within(holdingRow(symbol)).queryByText("0 trades")).not.toBeInTheDocument();
    expect(within(holdingRow(symbol)).queryByText("$0.00")).not.toBeInTheDocument();
  }
  expect(within(holdingRow("WSOL")).getByText("+$150.00")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Inspect SOL holding" }));
  expect(screen.getByText("Native SOL has no per-token trading position in this feed.")).toBeVisible();
});

it("withholds P&L without a priced buy basis or with unpriced fills while retaining recorded counts and known subtotals", () => {
  const data = overview();
  const partial = indexedPosition({
    unpriced_trades: 1,
    total_pnl_usd: "999",
    bought: { amount: "1000", sol: "2", usd: "400", count: 4 },
    sold: { amount: "1", sol: "0", usd: "0", count: 3 },
  });
  const { rerender } = render(<Holdings overview={data} trading={tradingDetails([partial])} />);
  const cells = within(holdingRow("JUP")).getAllByRole("cell");
  expect(cells[3]).toHaveTextContent("—");
  expect(cells[3]).toHaveAttribute("title", "Some indexed trades have missing prices.");
  fireEvent.click(screen.getByRole("button", { name: "Inspect JUP holding" }));
  const buys = () => screen.getByText("Recorded buys").parentElement!;
  const sells = screen.getByText("Recorded sells").parentElement!;
  expect(buys()).toHaveTextContent("$400.00");
  expect(buys()).toHaveTextContent("4 trades");
  expect(sells).toHaveTextContent("$0.00");
  expect(sells).toHaveTextContent("3 trades");
  openDetails();
  expect(screen.getByText(/Buy\/sell USD totals include priced indexed fills/)).toBeVisible();
  expect(screen.queryByText("+$999.00")).not.toBeInTheDocument();
  const noBasis = indexedPosition({
    total_pnl_usd: "0",
    avg_buy_price_usd: null,
    bought: { amount: "0", sol: "0", usd: "0", count: 0 },
  });
  rerender(<Holdings overview={data} trading={tradingDetails([noBasis])} />);
  const nextCells = within(holdingRow("JUP")).getAllByRole("cell");
  expect(nextCells[3]).toHaveTextContent("—");
  expect(nextCells[3]).toHaveAttribute("title", "A priced indexed buy basis is unavailable.");
  expect(buys()).toHaveTextContent("$0.00");
  expect(buys()).toHaveTextContent("0 trades");
});

it("keeps a missing current P&L estimate separate from a recorded realized estimate", () => {
  const position = indexedPosition({ total_pnl_usd: null, unrealized_pnl_usd: null });
  render(<Holdings overview={overview()} trading={tradingDetails([position])} />);
  expect(within(holdingRow("JUP")).getAllByRole("cell")[3]).toHaveTextContent("—");
  fireEvent.click(screen.getByRole("button", { name: "Inspect JUP holding" }));
  expect(within(screen.getByText("Indexed realized P&L estimate").parentElement!).getByText("+$50.00")).toBeVisible();
  expect(within(screen.getByText("Indexed unrealized P&L estimate").parentElement!).getByText("—")).toBeVisible();
});

it("keeps holdings available through trading errors and exposes only explicit paging/reload actions", () => {
  const trading = tradingDetails([indexedPosition()], { hasMore: true, positionCount: 201 });
  const { rerender } = render(<Holdings overview={overview()} trading={trading} />);
  const footer = screen.getByLabelText("Trading data coverage");
  expect(footer).toHaveTextContent("1 of 201 tokens loaded");
  expect(footer.querySelector("time")).toHaveAttribute("datetime", trading.positionsSince);
  fireEvent.click(screen.getByRole("button", { name: "Load more trading details" }));
  expect(trading.loadMore).toHaveBeenCalledOnce();
  rerender(<Holdings overview={overview()} trading={{ ...trading, loading: true }} />);
  expect(screen.getByRole("button", { name: "Load more trading details" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Inspect JUP holding" })).toBeVisible();
  rerender(<Holdings overview={overview()} trading={{ ...trading, loading: false, error: { ok: false, kind: "upstream" }, hasMore: false, positionsTracked: false, continuationUnavailable: true }} />);
  expect(screen.getByText("Trading details couldn’t load. Available holdings remain visible.")).toBeVisible();
  expect(screen.getByText(/Trade tracking is unavailable/)).toBeVisible();
  expect(screen.getByText(/More indexed tokens exist, but continuation is unavailable/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reload trading details" }));
  expect(trading.reload).toHaveBeenCalledOnce();
  expect(holdingRow("JUP")).toHaveTextContent("+$150.00");
});

// Synthetic wallets for the card layout: priced tokens, unpriced tokens and
// LP position receipts built from the same fixture asset.
function tokenAsset(index: number, overrides: Partial<Schemas["WalletAsset"]> = {}): Schemas["WalletAsset"] {
  return {
    ...overview().assets[0],
    mint: bs58.encode(new Uint8Array(32).fill(index + 60)),
    symbol: "SYN" + index,
    name: "Synthetic token " + index,
    amount: "1000000",
    decimals: 6,
    ui_amount: "1",
    price_usd: "1",
    value_usd: String(1000 - index),
    estimated_value_usd: null,
    price_updated_at: null,
    last_slot: index,
    ...overrides,
  };
}
function cardOverview(assets: Schemas["WalletAsset"][]) {
  const data = overview();
  data.assets = assets;
  // No SOL rows: every row on the card comes from the assets under test.
  data.native_sol_lamports = null;
  data.native_sol_value_usd = null;
  data.wrapped_sol_lamports = null;
  data.wrapped_sol_value_usd = null;
  return data;
}
function receiptAsset(index: number, protocol = "meteora_damm_v2"): Schemas["WalletAsset"] {
  return tokenAsset(index, {
    symbol: "RCPT" + index,
    name: "Receipt token " + index,
    price_usd: null,
    value_usd: null,
    position: { protocol, position: null, pool: null },
  });
}
function bodyRows() {
  return Array.from(document.querySelectorAll("tr.data-row"));
}
function row(id: string, value: string | null | undefined, extra: Partial<Row> = {}): Row {
  return { id, symbol: id, name: id, amount: "1", raw: "1", value, ...extra };
}

it("splitRows separates receipts and unpriced", () => {
  const receipt = row("receipt", null, {
    receipt: { label: "Meteora DAMM v2", position: null, pool: null, tokenSymbol: null, tokenName: null },
  });
  const rows = [
    row("tiny", "0.0099"),
    row("small", "0.01"),
    row("big", "250.5"),
    row("none", null),
    row("missing", undefined),
    row("zero", "0"),
    receipt,
    row("mid", "12"),
  ];
  const { shown, collapsed, receipts } = splitRows(rows);
  expect(shown.map((r) => r.id)).toEqual(["big", "mid", "small"]);
  expect(collapsed.map((r) => r.id)).toEqual(["tiny", "zero", "none", "missing"]);
  expect(receipts).toEqual([receipt]);
  expect(splitRows([])).toEqual({ shown: [], collapsed: [], receipts: [] });
});

it("shows 10 priced tokens then a show line", () => {
  const priced = Array.from({ length: 12 }, (_, index) => tokenAsset(index));
  const unpriced = [13, 14, 15].map((index) =>
    tokenAsset(index, { price_usd: null, value_usd: null }),
  );
  render(<Holdings overview={cardOverview([...unpriced, ...priced])} />);
  expect(bodyRows()).toHaveLength(10);
  expect(holdingButtons()[0]).toHaveAccessibleName("Inspect SYN0 holding");
  expect(screen.queryByRole("button", { name: "Inspect SYN10 holding" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Inspect SYN13 holding" })).toBeNull();
  const collapsedLine = screen.getByRole("button", { name: "+3 tokens with no price or tiny balances · show" });
  fireEvent.click(collapsedLine);
  expect(bodyRows()).toHaveLength(13);
  expect(screen.getByRole("button", { name: "Inspect SYN13 holding" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show all 12 tokens" }));
  expect(bodyRows()).toHaveLength(15);
  expect(screen.getByRole("button", { name: "Inspect SYN11 holding" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Show all 12 tokens" })).toBeNull();
});

it("names a single collapsed token in the singular", () => {
  render(
    <Holdings
      overview={cardOverview([tokenAsset(1), tokenAsset(2, { price_usd: null, value_usd: null })])}
    />,
  );
  expect(screen.getByRole("button", { name: "+1 token with no price or tiny balances · show" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
});

it("receipts collapse to one line linking to the protocol", () => {
  const showProtocol = vi.fn();
  render(
    <Holdings
      overview={cardOverview([tokenAsset(1), receiptAsset(2), receiptAsset(3)])}
      showProtocol={showProtocol}
    />,
  );
  expect(screen.queryByRole("button", { name: /^Inspect RCPT/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Inspect Meteora DAMM v2 position holding/ })).toBeNull();
  const line = screen.getByText(/2 LP position NFTs/).closest("p")!;
  expect(line).toHaveTextContent("2 LP position NFTs — shown in Meteora DAMM v2 below");
  const link = within(line).getByRole("link", { name: "Meteora DAMM v2" });
  expect(link).toHaveAttribute("href", "#protocol-meteora-damm-v2");
  fireEvent.click(link);
  expect(showProtocol).toHaveBeenCalledWith("meteora-damm-v2");
});

it("words a single receipt in the singular and does not link without a target", () => {
  const { unmount } = render(
    <Holdings overview={cardOverview([receiptAsset(2)])} showProtocol={vi.fn()} />,
  );
  expect(screen.getByText(/1 LP position NFT/).closest("p")).toHaveTextContent(
    "1 LP position NFT — shown in Meteora DAMM v2 below",
  );
  unmount();
  render(<Holdings overview={cardOverview([receiptAsset(2)])} />);
  const line = screen.getByText(/1 LP position NFT/).closest("p")!;
  expect(within(line).queryByRole("link")).toBeNull();
  expect(line).not.toHaveTextContent("below");
  expect(line).toHaveTextContent("Meteora DAMM v2");
});

it("only receipts and unpriced", () => {
  render(
    <Holdings
      overview={cardOverview([
        receiptAsset(1),
        tokenAsset(2, { price_usd: null, value_usd: null }),
      ])}
      showProtocol={vi.fn()}
    />,
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("button", { name: "+1 token with no price or tiny balances · show" })).toBeVisible();
  expect(screen.getByText(/1 LP position NFT/)).toBeVisible();
  expect(screen.queryByText("No token balances in the available snapshot")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "+1 token with no price or tiny balances · show" }));
  expect(bodyRows()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Inspect SYN2 holding" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Hide 1 token with no price or tiny balances" })).toBeVisible();
});

it("copycat symbol keeps mint", () => {
  const real = tokenAsset(1, { symbol: "USDC", name: "USD Coin" });
  const copycat = tokenAsset(2, { symbol: "USDC", name: "USD Coin" });
  render(<Holdings overview={cardOverview([real, copycat])} />);
  const buttons = screen.getAllByRole("button", { name: "Inspect USDC holding" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]);
  expect(screen.getByRole("link", { name: copycat.mint })).toBeVisible();
  expect(screen.queryByRole("link", { name: real.mint })).toBeNull();
});

it("search still finds collapsed tokens and receipts", () => {
  const unpriced = tokenAsset(3, { symbol: "HIDDEN", price_usd: null, value_usd: null });
  render(
    <Holdings
      overview={cardOverview([tokenAsset(1), unpriced, receiptAsset(2)])}
      showProtocol={vi.fn()}
    />,
  );
  expect(bodyRows()).toHaveLength(1);
  searchFor("hidden");
  expect(screen.getByRole("button", { name: "Inspect HIDDEN holding" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("1 of 3 observed holdings match");
  // Matching rows replace the collapsed summary lines while a search is active.
  expect(screen.queryByText(/LP position NFT/)).toBeNull();
  expect(screen.queryByRole("button", { name: /tokens? with no price/ })).toBeNull();
  searchFor("RCPT2");
  expect(screen.getByRole("button", { name: "Inspect Meteora DAMM v2 position holding" })).toBeVisible();
  searchFor(unpriced.mint);
  expect(bodyRows()).toHaveLength(1);
  searchFor("");
  expect(bodyRows()).toHaveLength(1);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByText(/1 LP position NFT/)).toBeVisible();
});

it("splitRows lists an estimate of at least a cent as priced and ranks by it", () => {
  const { shown, collapsed } = splitRows([
    row("known", "50"),
    row("est-big", null, { estimate: "120.5" }),
    row("est-edge", undefined, { estimate: "0.01" }),
    row("est-tiny", null, { estimate: "0.009" }),
    row("known-wins", "0.001", { estimate: "999" }),
    row("nothing", null),
  ]);
  expect(shown.map((r) => r.id)).toEqual(["est-big", "known", "est-edge"]);
  expect(collapsed.map((r) => r.id)).toEqual(["est-tiny", "known-wins", "nothing"]);
});

it("makes the P&L estimate note reachable by keyboard and screen readers", () => {
  render(<Holdings overview={overview()} trading={tradingDetails()} />);
  const header = screen.getByRole("columnheader", { name: /^P&L/ });
  const button = within(header).getByRole("button", { name: "estimate" });
  button.focus();
  expect(button).toHaveFocus();
  const note = document.getElementById(button.getAttribute("aria-describedby")!)!;
  expect(note).toHaveAttribute("role", "tooltip");
  expect(note).toHaveTextContent("Indexed average-cost estimate");
  expect(note).toHaveTextContent("opening balances, transfers and fees");
});

it("closes an open row when show lines hide it", () => {
  const priced = Array.from({ length: 12 }, (_, index) => tokenAsset(index));
  const unpriced = tokenAsset(13, { price_usd: null, value_usd: null });
  render(<Holdings overview={cardOverview([unpriced, ...priced])} />);
  showCollapsed();
  fireEvent.click(screen.getByRole("button", { name: "Inspect SYN13 holding" }));
  expect(screen.getByText("Raw atoms")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hide 1 token with no price or tiny balances" }));
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show all 12 tokens" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspect SYN11 holding" }));
  expect(screen.getByText("Raw atoms")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "+1 token with no price or tiny balances · show" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspect SYN13 holding" }));
  fireEvent.click(screen.getByRole("button", { name: "Show all 12 tokens" }));
  expect(screen.queryByText("Raw atoms")).not.toBeInTheDocument();
});

it("restores the list, including Show all, after a search is cleared", () => {
  const priced = Array.from({ length: 12 }, (_, index) => tokenAsset(index));
  render(<Holdings overview={cardOverview(priced)} />);
  fireEvent.click(screen.getByRole("button", { name: "Show all 12 tokens" }));
  expect(bodyRows()).toHaveLength(12);
  searchFor("SYN");
  expect(bodyRows()).toHaveLength(10);
  expect(screen.getByRole("button", { name: "Show all 12 matches" })).toBeVisible();
  searchFor("");
  expect(bodyRows()).toHaveLength(12);
  expect(screen.getByRole("button", { name: "Show fewer" })).toBeVisible();
});

it("keeps the search status live region mounted and announces matches in it", () => {
  render(<Holdings overview={cardOverview([tokenAsset(1), tokenAsset(2)])} />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  searchFor("SYN1");
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("1 of 2 observed holdings match");
  searchFor("");
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
});
