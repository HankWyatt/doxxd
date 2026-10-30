import { render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolSection } from "./protocol-section";
import { HoldingsTokens, type TokenMetaMap } from "./token-meta";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import type { ProtocolResource, Schemas } from "@/lib/dmnd/contracts";
import { CLMM, clmmPage } from "@/tests/fixtures/synthetic-raydium-positions";
import { DAMM, dammV2Page } from "@/tests/fixtures/synthetic-meteora-damm-v2";

// Reserved example hosts only; no request leaves the test.
const IMAGE_LEG = "https://tokens.example.com/leg.png";
const IMAGE_HOLDINGS = "https://tokens.example.com/holdings.png";

afterEach(() => vi.unstubAllGlobals());

function serve(resource: ProtocolResource, data: unknown) {
  expect(validResourcePayload(resource, data)).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data })));
}
function card(resource: ProtocolResource, address: string, tokens: TokenMetaMap = {}) {
  return render(
    <HoldingsTokens.Provider value={tokens}>
      <ProtocolSection address={address} resource={resource} mode={{ kind: "live" }} labels={{}} defaultOpen />
    </HoldingsTokens.Provider>,
  );
}
const feeCell = async () => (await screen.findByRole("table")).querySelector("tbody tr td.hide-mobile") as HTMLElement;

function clmmWith(position: Partial<Schemas["WalletLiquidityPosition"]>, page: Partial<Schemas["WalletLiquidityPositions"]> = {}) {
  const data = clmmPage();
  Object.assign(data.data[0], position);
  Object.assign(data, page);
  return data;
}
const feeLeg = (symbol: string, ui: string, value: string | null, source: string | null = "dmnd_pool_trade_sol") => ({
  mint: symbol === "SYNA" ? CLMM.tokenA : CLMM.tokenB,
  symbol,
  decimals: 6,
  ui_amount: ui,
  value_usd: value,
  price_source: source,
});

it("shows each fee's USD, the row's claimable total and the card's fees to claim", async () => {
  serve(
    "raydium-clmm",
    clmmWith(
      {
        claimable_basis: "accrued",
        claimable_at: "2026-10-01T00:00:00Z",
        claimable_value_usd: "12.5",
        fee_a: feeLeg("SYNA", "1.5", "7.25"),
        fee_b: feeLeg("SYNB", "0.25", "5.25"),
      },
      { page_known_claimable_value_usd: "12.5" },
    ),
  );
  card("raydium-clmm", CLMM.wallet);
  const cell = await feeCell();
  expect(within(cell).getByText("($7.25)")).toBeInTheDocument();
  expect(within(cell).getByText("($5.25)")).toBeInTheDocument();
  expect(within(cell).getByText("$12.50")).toBeInTheDocument();
  expect(screen.getByText("1 position · claimable: $12.50")).toBeInTheDocument();
});

it("leaves unvalued fees blank, never $0", async () => {
  serve(
    "raydium-clmm",
    clmmWith(
      { claimable_basis: "accrued", claimable_value_usd: "0", fee_a: feeLeg("SYNA", "1.5", null), fee_b: feeLeg("SYNB", "0", null) },
      { page_known_claimable_value_usd: "0" },
    ),
  );
  card("raydium-clmm", CLMM.wallet);
  const cell = await feeCell();
  expect(cell.textContent).not.toMatch(/\$/);
  expect(within(cell).queryByText("claimable")).toBeNull();
  expect(screen.queryByText(/claimable:/)).toBeNull();
});

it("words settled fees as at least and accrued fees plainly", async () => {
  serve("raydium-clmm", clmmWith({ claimable_basis: "settled", claimable_at: null, fee_a: feeLeg("SYNA", "1.5", null) }));
  const { unmount } = card("raydium-clmm", CLMM.wallet);
  expect(within(await feeCell()).getByText("at least 1.5")).toBeInTheDocument();
  unmount();
  serve("raydium-clmm", clmmWith({ claimable_basis: "accrued", claimable_at: "2026-10-01T00:00:00Z", fee_a: feeLeg("SYNA", "1.5", null) }));
  card("raydium-clmm", CLMM.wallet);
  const cell = await feeCell();
  expect(within(cell).getByText("1.5")).toBeInTheDocument();
  expect(cell.textContent).not.toMatch(/at least/);
});

it("marks a pool-implied fee value as an estimate", async () => {
  serve(
    "raydium-clmm",
    clmmWith({
      claimable_basis: "accrued",
      claimable_value_usd: "7.25",
      fee_a: feeLeg("SYNA", "1.5", "7.25", "dmnd_pool_implied"),
      fee_b: feeLeg("SYNB", "0.25", null, null),
    }),
  );
  card("raydium-clmm", CLMM.wallet);
  const cell = await feeCell();
  const marks = within(cell).getAllByText("est.");
  // The fee and the row total; the unvalued fee carries none.
  expect(marks).toHaveLength(2);
  for (const mark of marks) expect(mark).toHaveAttribute("title", "Estimated from this pool's own reserves");
});

it("marks no estimate when every price is a market price", async () => {
  serve("raydium-clmm", clmmWith({ claimable_basis: "accrued", claimable_value_usd: "7.25", fee_a: feeLeg("SYNA", "1.5", "7.25") }));
  card("raydium-clmm", CLMM.wallet);
  expect(within(await feeCell()).queryByText("est.")).toBeNull();
});

it("shows DAMM v2 fee values as accrued amounts, never at least", async () => {
  const data = dammV2Page();
  Object.assign(data.data[0], {
    claimable_value_usd: "9",
    fee_a: { mint: DAMM.tokenA, symbol: "SYNA", decimals: 9, ui_amount: "1.5", value_usd: "9", price_source: "dmnd_pool_trade_sol" },
  });
  data.page_known_claimable_value_usd = "9";
  serve("meteora-damm-v2", data);
  card("meteora-damm-v2", DAMM.wallet);
  const cell = await feeCell();
  expect(within(cell).getByText("($9.00)")).toBeInTheDocument();
  expect(cell.textContent).not.toMatch(/at least/);
  expect(screen.getByText("1 position · claimable: $9.00")).toBeInTheDocument();
});

it("falls back to the holdings image when DMND's leg image is unsafe", async () => {
  const data = clmmWith({});
  data.data[0].principal_a.image_url = "http://tokens.example.com/unsafe.png";
  serve("raydium-clmm", data);
  card("raydium-clmm", CLMM.wallet, { [CLMM.tokenA]: { image: IMAGE_HOLDINGS } });
  const row = (await screen.findByRole("table")).querySelector("tbody tr.data-row")!;
  const a = row.querySelector(".pair-icons > .token-icon")!;
  expect(a.querySelector("img")).toHaveAttribute("src", IMAGE_HOLDINGS);
});

it("tries the leg image, then the holdings image, then initials", async () => {
  const data = clmmWith({});
  data.data[0].principal_a.image_url = IMAGE_LEG;
  serve("raydium-clmm", data);
  card("raydium-clmm", CLMM.wallet, { [CLMM.tokenA]: { image: IMAGE_HOLDINGS } });
  const row = (await screen.findByRole("table")).querySelector("tbody tr.data-row")!;
  const icon = () => row.querySelector(".pair-icons > .token-icon")!;
  expect(icon().querySelector("img")).toHaveAttribute("src", IMAGE_LEG);
  fireEvent.error(icon().querySelector("img")!);
  expect(icon().querySelector("img")).toHaveAttribute("src", IMAGE_HOLDINGS);
  fireEvent.error(icon().querySelector("img")!);
  expect(icon().querySelector("img")).toBeNull();
  expect(icon()).toHaveTextContent("S");
});

it("reads a settled claimable total as a lower bound, row and card", async () => {
  serve(
    "raydium-clmm",
    clmmWith(
      {
        claimable_basis: "settled",
        claimable_at: null,
        claimable_value_usd: "12.5",
        fee_a: feeLeg("SYNA", "1.5", "12.5"),
      },
      { page_known_claimable_value_usd: "12.5" },
    ),
  );
  card("raydium-clmm", CLMM.wallet);
  const cell = await feeCell();
  expect(within(cell).getByText("at least $12.50")).toBeInTheDocument();
  expect(screen.getByText("1 position · claimable: at least $12.50")).toBeInTheDocument();
});

it("reads a page total as a lower bound when any row is settled", async () => {
  const data = clmmWith({ claimable_basis: "accrued", claimable_value_usd: "5", fee_a: feeLeg("SYNA", "1", "5") }, { page_known_claimable_value_usd: "8" });
  const second = structuredClone(data.data[0]);
  Object.assign(second, {
    position: "SyntheticSecondPosition",
    claimable_basis: "settled",
    claimable_value_usd: "3",
    fee_a: feeLeg("SYNA", "1", "3"),
  });
  data.data.push(second);
  data.coverage.total_positions = 2;
  serve("raydium-clmm", data);
  card("raydium-clmm", CLMM.wallet);
  expect(await screen.findByText("2 positions · claimable: at least $8.00")).toBeInTheDocument();
});
