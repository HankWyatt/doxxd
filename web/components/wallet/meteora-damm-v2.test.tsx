import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolSection } from "./protocol-section";
import { Holdings } from "./holdings";
import { Portfolio } from "./portfolio";
import { readFixture } from "@/lib/fixtures/wallet";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import type { ResourceName, Schemas } from "@/lib/dmnd/contracts";
import type { HoldingsTradingDetails } from "@/lib/indexed-trading";
import { short } from "@/lib/portfolio/adapters/shared";
import {
  DAMM,
  dammV2Page,
  dammV2State,
  syntheticAddress,
} from "@/tests/fixtures/synthetic-meteora-damm-v2";

afterEach(() => vi.unstubAllGlobals());

function serve(...pages: Schemas["WalletMeteoraDammV2Positions"][]) {
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const page = url.searchParams.has("cursor") ? pages[1] : pages[0];
    expect(validResourcePayload("meteora-damm-v2", page)).toBe(true);
    return Response.json({ ok: true, data: page });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function openSection() {
  render(
    <ProtocolSection
      address={DAMM.wallet}
      resource="meteora-damm-v2"
      mode={{ kind: "live" }}
      labels={{}}
    />,
  );
  expect(screen.getByText("Liquidity positions")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expand Meteora DAMM v2" }));
}

it("loads lazily and shows a complete position with expandable detail", async () => {
  const fetch = serve(dammV2Page());
  render(
    <ProtocolSection
      address={DAMM.wallet}
      resource="meteora-damm-v2"
      mode={{ kind: "live" }}
      labels={{}}
    />,
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand Meteora DAMM v2" }));
  const label = "SYNA / " + short(DAMM.tokenB);
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(label) }));
  expect(String(fetch.mock.calls[0][0])).toBe(
    `/api/wallet/${DAMM.wallet}/meteora-damm-v2?limit=50`,
  );
  expect(screen.getByText("Current snapshot")).toBeInTheDocument();
  expect(screen.getByText("This page: $40.00")).toBeInTheDocument();
  expect(screen.getByText("Source snapshot positions: 1.")).toBeInTheDocument();
  expect(screen.getByText("Vesting liquidity")).toBeVisible();
  expect(screen.getByText("Permanently locked liquidity")).toBeVisible();
  expect(screen.getByText(DAMM.pool)).toBeVisible();
  expect(screen.getAllByText(/claimable fee/).length).toBe(2);
  expect(screen.getByText(/Position value: —/)).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ["pending", "Preparing wallet data", /fresh snapshot is being prepared/, null],
  ["empty", "No positions", /No positions were found in this supported scope/, "This page: $0.00"],
  ["disabled", "Data unavailable", /does not establish an empty wallet/, null],
] as const)("explains a %s page without inventing positions", async (state, title, body, page) => {
  serve(dammV2State(state));
  openSection();
  expect((await screen.findAllByText(body))[0]).toBeVisible();
  expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /\// })).toBeNull();
  // A page subtotal appears only when the source reports one.
  if (page) expect(screen.getByText(page)).toBeInTheDocument();
  else expect(screen.queryByText(/This page:/)).toBeNull();
});

it("pages manually with the opaque cursor and returns to the first page", async () => {
  const second = dammV2Page();
  second.data[0].position = syntheticAddress("damm-v2/position-2");
  second.data[0].token_a.symbol = "SYNC";
  const fetch = serve(dammV2State("partial"), second);
  openSection();
  expect(await screen.findByText("Partial coverage")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Next positions" }));
  expect(await screen.findByText(/^SYNC \//)).toBeVisible();
  expect(String(fetch.mock.calls[1][0])).toContain(
    "cursor=synthetic-damm-v2-cursor-2",
  );
  fireEvent.click(screen.getByRole("button", { name: "First page" }));
  expect(await screen.findByText(/^SYNA \//)).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(3);
});

function receiptOverview(position: Schemas["WalletAssetPosition"]) {
  const result = readFixture("overview", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  result.data.assets.push({
    ...result.data.assets[0],
    mint: DAMM.positionMint,
    symbol: "CLAIMED",
    name: "Creator-supplied name",
    amount: "1",
    decimals: 0,
    ui_amount: "1",
    // DMND never values these; a value here must still not be shown.
    price_usd: "999",
    value_usd: "999",
    estimated_value_usd: "999",
    position,
  });
  expect(validResourcePayload("overview", result.data)).toBe(true);
  return result.data;
}

it("labels an LP position NFT as an unvalued receipt overlapping the protocol section", () => {
  const showProtocol = vi.fn();
  render(
    <Holdings
      overview={receiptOverview({
        protocol: "meteora_damm_v2",
        position: DAMM.position,
        pool: DAMM.pool,
      })}
      showProtocol={showProtocol}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Inspect Meteora DAMM v2 position holding",
  });
  const row = button.closest("tr")!;
  expect(within(row).queryByText("Unknown token")).toBeNull();
  expect(within(row).getByText("LP position receipt")).toBeVisible();
  expect(within(row).queryByText(/\$999/)).toBeNull();
  expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  fireEvent.click(button);
  const detail = row.nextElementSibling as HTMLElement;
  expect(within(detail).getByText(DAMM.position)).toBeVisible();
  expect(within(detail).getByText(DAMM.pool)).toBeVisible();
  const link = within(detail).getByRole("link", { name: "Meteora DAMM v2" });
  expect(link).toHaveAttribute("href", "#protocol-meteora-damm-v2");
  fireEvent.click(link);
  expect(showProtocol).toHaveBeenCalledWith("meteora-damm-v2");
  expect(within(detail).getByText(/overlaps protocol positions/i)).toBeVisible();
  // The section has its own coverage; the receipt never asserts what it shows.
  expect(within(detail).getByText(/that section reports its own coverage/i)).toBeVisible();
  expect(within(detail).queryByText(/principal is reported/i)).toBeNull();
  expect(within(detail).getByText(/CLAIMED · Creator-supplied name/)).toBeVisible();
  expect(within(detail).getByText(/not verified/i)).toBeVisible();
  expect(within(detail).queryByText(/\$999/)).toBeNull();
  expect(screen.getByText(/1 LP position receipt overlaps/)).toBeInTheDocument();
});

it("never joins indexed trading results to an LP receipt's NFT mint", () => {
  const positions = readFixture("positions", "complete");
  if (!positions.ok) throw new Error("Fixture must succeed");
  const traded = {
    ...positions.data.data[0],
    mint: DAMM.positionMint,
    bought: { amount: "1", sol: "1", usd: "100", count: 2 },
    sold: { amount: "1", sol: "1", usd: "175", count: 1 },
    avg_buy_price_usd: "100",
    realized_pnl_usd: "75",
    unrealized_pnl_usd: "0",
    total_pnl_usd: "75",
  };
  const trading: HoldingsTradingDetails = {
    positions: new Map([[traded.mint, traded]]),
    loading: false,
    error: null,
    positionsTracked: true,
    positionsSince: positions.data.positions_since ?? null,
    loadedCount: 1,
    positionCount: 1,
    hasMore: false,
    continuationUnavailable: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
  };
  render(
    <Holdings
      overview={receiptOverview({
        protocol: "meteora_damm_v2",
        position: DAMM.position,
        pool: DAMM.pool,
      })}
      trading={trading}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Inspect Meteora DAMM v2 position holding",
  });
  const row = button.closest("tr")!;
  const cells = within(row).getAllByRole("cell");
  for (const index of [4, 5, 6, 7]) expect(cells[index]).toHaveTextContent("—");
  expect(within(row).queryByText("+$75.00")).toBeNull();
  expect(within(row).queryByText(/trades?$/)).toBeNull();
  fireEvent.click(button);
  const detail = row.nextElementSibling as HTMLElement;
  expect(within(detail).getByText("LP position receipts have no per-token trading position here.")).toBeVisible();
  expect(within(detail).queryByText("Indexed total P&L estimate")).toBeNull();
  expect(within(detail).queryByText("Recorded buys")).toBeNull();
  expect(within(detail).getByText(DAMM.position)).toBeVisible();
});

it("labels a receipt whose position and pool are not yet identified", () => {
  render(
    <Holdings
      overview={receiptOverview({
        protocol: "meteora_damm_v2",
        position: null,
        pool: null,
      })}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect Meteora DAMM v2 position holding" }),
  );
  expect(screen.getAllByText("Not reported")).toHaveLength(2);
  expect(screen.getByText(/first completed position scan/i)).toBeVisible();
  expect(screen.getByText(/scan is disabled/i)).toBeVisible();
  // Without a mounted section target there is no link, only the label.
  expect(screen.queryByRole("link", { name: "Meteora DAMM v2" })).toBeNull();
  expect(screen.getByText("Meteora DAMM v2")).toBeVisible();
});

it("does not point an unknown protocol receipt at a protocol section", () => {
  render(
    <Holdings
      overview={receiptOverview({ protocol: "future_amm", position: null, pool: null })}
      showProtocol={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect future amm position holding" }));
  expect(screen.getByText(/Doxxd has no protocol view for this receipt/)).toBeVisible();
  expect(screen.queryByText(/protocol section/i)).toBeNull();
  expect(screen.queryByRole("link", { name: "future amm" })).toBeNull();
});

it.each(["claimed", "creator-supplied"])(
  "finds a receipt by its own token metadata %s and keeps it labelled",
  (query) => {
    render(
      <Holdings
        overview={receiptOverview({ protocol: "meteora_damm_v2", position: null, pool: null })}
      />,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search observed holdings" }), {
      target: { value: query },
    });
    expect(screen.getAllByRole("button", { name: /^Inspect .*holding$/ })).toEqual([
      screen.getByRole("button", { name: "Inspect Meteora DAMM v2 position holding" }),
    ]);
    expect(screen.getByText("LP position receipt")).toBeVisible();
  },
);

it("reveals a hidden protocol view before following a receipt link", async () => {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    if (resource === "summary")
      return Response.json({ ok: false, kind: "configuration" });
    if (resource === "overview")
      return Response.json({
        ok: true,
        data: receiptOverview({
          protocol: "meteora_damm_v2",
          position: DAMM.position,
          pool: DAMM.pool,
        }),
      });
    return Response.json(readFixture(resource, "complete"));
  });
  vi.stubGlobal("fetch", fetcher);
  const { DEMO_ADDRESS } = await import("@/lib/fixtures/wallet");
  render(<Portfolio address={DEMO_ADDRESS} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Inspect Meteora DAMM v2 position holding" }),
  );
  expect(document.getElementById("protocol-meteora-damm-v2")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Meteora DAMM v2" }));
  expect(await screen.findByRole("button", { name: "Show fewer protocols" })).toBeVisible();
  expect(document.getElementById("protocol-meteora-damm-v2")).not.toBeNull();
  await waitFor(() => expect(window.location.hash).toBe("#protocol-meteora-damm-v2"));
  expect(
    fetcher.mock.calls.every(([input]) => !String(input).includes("meteora-damm-v2")),
  ).toBe(true);
});

it("labels Orca, Raydium and unknown LP receipts without valuing them", () => {
  const data = receiptOverview({ protocol: "orca_whirlpools", position: null, pool: null });
  data.assets.push(
    { ...data.assets.at(-1)!, mint: syntheticAddress("receipt/raydium"), position: { protocol: "raydium_clmm" } },
    { ...data.assets.at(-1)!, mint: syntheticAddress("receipt/future"), position: { protocol: "future_amm" } },
  );
  render(<Holdings overview={data} />);
  for (const name of ["Orca Whirlpools position", "Raydium CLMM position", "future amm position"])
    expect(screen.getByRole("button", { name: `Inspect ${name} holding` })).toBeVisible();
  expect(screen.queryByText(/\$999/)).toBeNull();
  expect(screen.getByText(/3 LP position receipts overlap/)).toBeInTheDocument();
});

it("finds a receipt by its protocol label in the holdings search", () => {
  render(
    <Holdings
      overview={receiptOverview({ protocol: "meteora_damm_v2", position: null, pool: null })}
    />,
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search observed holdings" }), {
    target: { value: "damm" },
  });
  expect(screen.getAllByRole("button", { name: /^Inspect .*holding$/ })).toHaveLength(1);
});

it.each([
  ["disabled", false, null],
  ["queued", false, null],
  ["stale", true, "75"],
] as const)(
  "links a %s DAMM v2 summary component to its protocol section",
  async (status, included, value) => {
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input, "http://doxxd.test");
      const resource = url.pathname.split("/").at(-1) as ResourceName;
      const result = readFixture(resource, "complete");
      if (resource === "summary" && result.ok && "components" in result.data) {
        result.data.components.push({
          id: "meteora_damm_v2",
          source_path: `/wallets/${result.data.wallet}/meteora-damm-v2-positions`,
          included_in_known_total: included,
          coverage_complete: false,
          coverage_fresh: false,
          coverage_status: status,
          reason: status,
          known_net_value_usd: value,
          snapshot_slot: null,
        });
        expect(validResourcePayload("summary", result.data)).toBe(true);
      }
      return Response.json(result);
    });
    vi.stubGlobal("fetch", fetcher);
    const { DEMO_ADDRESS } = await import("@/lib/fixtures/wallet");
    render(<Portfolio address={DEMO_ADDRESS} />);
    const link = await screen.findByRole("link", { name: /Meteora DAMM v2/ });
    expect(link).toHaveAttribute("href", "#protocol-meteora-damm-v2");
    expect(document.getElementById("protocol-meteora-damm-v2")).not.toBeNull();
    expect(screen.getByText("$12,345.67")).toBeVisible();
    expect(
      fetcher.mock.calls.every(([input]) => !String(input).includes("meteora-damm-v2")),
    ).toBe(true);
    if (status === "queued")
      expect(screen.getByText(/sources? still updating/)).toBeVisible();
    if (status === "stale") expect(screen.getByText(/^Saved data from/)).toBeVisible();
    if (status === "disabled") expect(screen.queryByText(/sources? still updating/)).toBeNull();
  },
);

function copycatPage(resource: "orca" | "raydium-clmm" | "meteora") {
  const copycat = syntheticAddress("copycat/usdc-symbol");
  const orca = readFixture("orca", "complete");
  if (!orca.ok) throw new Error("Fixture must succeed");
  const source = orca.data.data[0];
  const legB = { ...source.principal_b, mint: copycat, symbol: "USDC" };
  if (resource === "meteora") {
    const page = readFixture("meteora", "complete");
    if (!page.ok) throw new Error("Fixture must succeed");
    page.data.data = [
      {
        position: DAMM.position,
        pair: DAMM.pool,
        program: DAMM.program,
        lower_bin_id: -10,
        upper_bin_id: 10,
        principal_x: source.principal_a,
        principal_y: legB,
        fee_pending_x_atoms: "1",
        fee_pending_y_atoms: "2",
        rewards: [],
        owner_slot: 410000003,
        position_slot: 410000002,
        pair_slot: 410000001,
        bin_arrays_slot: 410000001,
        snapshot_slot: 410000004,
      },
    ];
    return { copycat, data: page.data };
  }
  orca.data.protocol = resource === "orca" ? "orca_whirlpools" : "raydium_clmm";
  orca.data.data[0].principal_b = legB;
  return { copycat, data: orca.data };
}

it.each([
  ["orca", "Orca Whirlpools"],
  ["raydium-clmm", "Raydium CLMM"],
  ["meteora", "Meteora DLMM"],
] as const)("keeps a copycat-symbol mint visible in an expanded %s row", async (resource, label) => {
  const { copycat, data } = copycatPage(resource);
  expect(validResourcePayload(resource, data)).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data })));
  const { DEMO_ADDRESS } = await import("@/lib/fixtures/wallet");
  render(
    <ProtocolSection address={DEMO_ADDRESS} resource={resource} mode={{ kind: "live" }} labels={{}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand " + label }));
  fireEvent.click(await screen.findByRole("button", { name: /WSOL \/ USDC/ }));
  const detail = document.querySelector(".detail-row") as HTMLElement;
  expect(within(detail).getByText(copycat)).toBeVisible();
});

it("moves focus to the protocol section each time a receipt link is followed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://doxxd.test");
      const resource = url.pathname.split("/").at(-1) as ResourceName;
      if (resource === "overview")
        return Response.json({
          ok: true,
          data: receiptOverview({ protocol: "meteora_damm_v2", position: DAMM.position, pool: DAMM.pool }),
        });
      return Response.json({ ok: false, kind: "configuration" });
    }),
  );
  window.location.hash = "";
  const { DEMO_ADDRESS } = await import("@/lib/fixtures/wallet");
  render(<Portfolio address={DEMO_ADDRESS} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Inspect Meteora DAMM v2 position holding" }),
  );
  const toggle = () => screen.getByRole("button", { name: "Expand Meteora DAMM v2" });
  for (let attempt = 0; attempt < 2; attempt++) {
    const link = screen.getByRole("link", { name: "Meteora DAMM v2" });
    link.focus();
    fireEvent.click(link);
    await waitFor(() => expect(document.activeElement).toBe(toggle()));
    expect(window.location.hash).toBe("#protocol-meteora-damm-v2");
  }
});
