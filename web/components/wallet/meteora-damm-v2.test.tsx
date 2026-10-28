import { render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolSection } from "./protocol-section";
import { Holdings } from "./holdings";
import { Portfolio } from "./portfolio";
import { readFixture } from "@/lib/fixtures/wallet";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import type { ResourceName, Schemas } from "@/lib/dmnd/contracts";
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
  render(
    <Holdings
      overview={receiptOverview({
        protocol: "meteora_damm_v2",
        position: DAMM.position,
        pool: DAMM.pool,
      })}
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
  expect(within(detail).getByRole("link", { name: "Meteora DAMM v2" }))
    .toHaveAttribute("href", "#protocol-meteora-damm-v2");
  expect(within(detail).getByText(/overlaps protocol positions/i)).toBeVisible();
  expect(within(detail).getByText(/CLAIMED · Creator-supplied name/)).toBeVisible();
  expect(within(detail).getByText(/not verified/i)).toBeVisible();
  expect(within(detail).queryByText(/\$999/)).toBeNull();
  expect(screen.getByText(/1 LP position receipt overlaps/)).toBeInTheDocument();
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
      expect(screen.getByText(/still being prepared/)).toBeVisible();
    if (status === "stale") expect(screen.getByText("Saved snapshots")).toBeVisible();
    if (status === "disabled") expect(screen.queryByText(/being prepared/)).toBeNull();
  },
);
