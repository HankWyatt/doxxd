import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolSection } from "./protocol-section";
import { DEMO_ADDRESS, readFixture } from "@/lib/fixtures/wallet";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import type { ProtocolResource, Schemas } from "@/lib/dmnd/contracts";
import { short } from "@/lib/portfolio/adapters/shared";
import {
  DAMM,
  dammV2Page,
  dammV2Position,
  syntheticAddress,
} from "@/tests/fixtures/synthetic-meteora-damm-v2";

afterEach(() => vi.unstubAllGlobals());

function serve(resource: ProtocolResource, data: unknown) {
  expect(validResourcePayload(resource, data)).toBe(true);
  const fetch = vi.fn(async () => Response.json({ ok: true, data }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function fixture<R extends ProtocolResource>(resource: R) {
  const result = readFixture(resource, "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  return result.data;
}
function card(
  resource: ProtocolResource,
  extra: Partial<Parameters<typeof ProtocolSection>[0]> = {},
) {
  return render(
    <ProtocolSection
      address={DEMO_ADDRESS}
      resource={resource}
      mode={{ kind: "live" }}
      labels={{}}
      defaultOpen
      {...extra}
    />,
  );
}
const component = (
  id: string,
  value: string | null,
): Schemas["WalletPortfolioComponent"] => ({
  id,
  source_path: "/wallets/x/" + id,
  known_asset_value_usd: value,
  known_debt_value_usd: "0",
  known_net_value_usd: value,
  unpriced_count: 0,
  included_in_known_total: true,
  coverage_complete: true,
  coverage_fresh: true,
  coverage_status: "complete",
  snapshot_slot: 1,
  reason: "synthetic",
});
const headers = (table: HTMLElement) =>
  Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent);

it("card shows kind tag and summary total", async () => {
  serve("kamino", fixture("kamino"));
  const { container } = card("kamino", {
    component: component("kamino_lend", "2000"),
  });
  const toggle = container.querySelector<HTMLElement>(".protocol-toggle")!;
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(toggle).getByText("Kamino Lend")).toBeVisible();
  expect(within(toggle).getByText("Lending")).toBeVisible();
  expect(within(toggle).getByText("Ka")).toBeInTheDocument();
  expect(toggle.querySelector(".protocol-value")).toHaveTextContent("$2,000.00");
  expect(await screen.findByRole("table")).toBeVisible();
});

it("does not fetch until a closed card is opened", async () => {
  const fetch = serve("kamino", fixture("kamino"));
  card("kamino", { defaultOpen: false });
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand Kamino Lend" }));
  expect(await screen.findByRole("table")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("lp table columns and manage link", async () => {
  const page = dammV2Page();
  const unlocked = dammV2Position();
  unlocked.position = syntheticAddress("damm-v2/position-unlocked");
  unlocked.token_a.symbol = "SYNU";
  unlocked.liquidity = {
    unlocked: "1500",
    vested: "0",
    permanent_locked: "0",
    total: "1500",
  };
  unlocked.principal_value_usd = "10";
  page.data.push(unlocked);
  page.coverage.total_positions = 2;
  serve("meteora-damm-v2", page);
  card("meteora-damm-v2", { address: DAMM.wallet });
  const table = await screen.findByRole("table");
  expect(headers(table)).toEqual([
    "Pool",
    "Balance",
    "Claimable fees",
    "USD Value",
  ]);
  expect(screen.getByText("2 positions")).toBeVisible();
  const locked = within(table)
    .getByText("SYNA + " + short(DAMM.tokenB))
    .closest("tr")!;
  expect(within(locked).getByText(/locked/)).toBeVisible();
  // Both legs, claimable fees as amounts without USD, and unknown value.
  expect(within(locked).getByText("2.5")).toBeVisible();
  expect(within(locked).getByText("1,234.5")).toBeVisible();
  expect(within(locked).getByText("1.5")).toBeVisible();
  expect(within(locked).getByText("0.25")).toBeVisible();
  expect(locked.lastElementChild).toHaveTextContent("—");
  const link = within(locked).getByRole("link", { name: /Manage on Meteora/ });
  expect(link).toHaveAttribute(
    "href",
    "https://app.meteora.ag/dammv2/" + DAMM.pool,
  );
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(link).toHaveAttribute("target", "_blank");
  const open = within(table)
    .getByText("SYNU + " + short(DAMM.tokenB))
    .closest("tr")!;
  expect(within(open).queryByText(/locked/)).toBeNull();
  expect(open.lastElementChild).toHaveTextContent("$10.00");
});

it("pluralizes a single LP position and links no protocol without a verified page", async () => {
  serve("orca", fixture("orca"));
  card("orca");
  const table = await screen.findByRole("table");
  expect(headers(table)).toEqual([
    "Pool",
    "Balance",
    "Claimable fees",
    "USD Value",
  ]);
  expect(screen.queryByRole("link", { name: /Manage on/ })).toBeNull();
});

it("lending splits supplied and borrowed", async () => {
  serve("kamino", fixture("kamino"));
  card("kamino");
  const table = await screen.findByRole("table");
  expect(headers(table)).toEqual(["Token", "Balance", "USD Value"]);
  expect(within(table).getByText("Lending position")).toBeVisible();
  const rows = within(table)
    .getAllByRole("row")
    .map((row) => row.textContent ?? "");
  const supplied = rows.findIndex((t) => t === "Supplied");
  const borrowed = rows.findIndex((t) => t === "Borrowed");
  expect(supplied).toBeGreaterThan(0);
  expect(borrowed).toBeGreaterThan(supplied);
  expect(rows[supplied + 1]).toMatch(/4,000.*\$4,000\.00/);
  expect(rows[borrowed + 1]).toMatch(/2,000.*\$2,000\.00/);
});

it("staking shows the validator vote account and amount", async () => {
  const data = fixture("stake");
  serve("stake", data);
  card("stake");
  const table = await screen.findByRole("table");
  expect(headers(table)).toEqual(["Validator", "Amount", "USD Value"]);
  const row = within(table).getByText(short(data.data[0].vote_account!)).closest("tr")!;
  expect(within(row).getByText("10")).toBeVisible();
  expect(within(row).getByText("$1,500.00")).toBeVisible();
});

it("perps show the market and base quantity", async () => {
  const data = fixture("drift");
  data.data = [
    {
      position_account: syntheticAddress("drift/account"),
      snapshot_slot: 7,
      spots: [],
      perps: [
        {
          market_index: 3,
          base_asset_amount: "2500000000",
          base_ui_amount: "2.5",
          quote_asset_amount: "-100000000",
          quote_ui_amount: "-100",
          quote_break_even_amount: "-100000000",
          quote_entry_amount: "-100000000",
          last_cumulative_funding_rate: "0",
          lp_shares: "0",
          open_asks: "0",
          open_bids: "0",
          open_orders: 0,
          settled_pnl: "0",
          opaque_layout_evidence: false,
          slot: 7,
        },
      ],
    },
  ];
  serve("drift", data);
  card("drift");
  const table = await screen.findByRole("table");
  expect(headers(table)).toEqual(["Market", "Size", "USD Value"]);
  expect(within(table).getByText("Perp market 3")).toBeVisible();
  expect(within(table).getByText("2.5")).toBeVisible();
});

it("shows 5 rows then Show all", async () => {
  const page = dammV2Page();
  page.data = [3, 7, 1, 6, 2, 5, 4].map((n) => {
    const row = dammV2Position();
    row.position = syntheticAddress("damm-v2/rank-" + n);
    row.token_a.symbol = "SY" + n;
    row.principal_value_usd = String(n * 10);
    return row;
  });
  page.coverage.total_positions = 9;
  page.has_more = true;
  page.cursor = "synthetic-damm-v2-cursor-2";
  serve("meteora-damm-v2", page);
  card("meteora-damm-v2", { address: DAMM.wallet });
  const table = await screen.findByRole("table");
  const values = () =>
    within(table)
      .getAllByRole("row")
      .filter((r) => r.classList.contains("data-row"))
      .map((r) => r.lastElementChild!.textContent);
  expect(values()).toEqual(["$70.00", "$60.00", "$50.00", "$40.00", "$30.00"]);
  expect(screen.getByText("9 positions")).toBeVisible();
  // Cursor paging stays below the in-page reveal.
  expect(screen.getByRole("button", { name: "Next positions" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show all 7" }));
  expect(values()).toEqual([
    "$70.00",
    "$60.00",
    "$50.00",
    "$40.00",
    "$30.00",
    "$20.00",
    "$10.00",
  ]);
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

it("failed card shows retry not zero", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: false, kind: "upstream" })),
  );
  const onStatus = vi.fn();
  const { container } = card("orca", {
    component: component("orca_whirlpools", "1645.67"),
    onStatus,
  });
  expect(await screen.findByText("Couldn’t load this section")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry section" })).toBeVisible();
  const value = container.querySelector(".protocol-value")!;
  expect(value).toHaveTextContent("—");
  expect(value).not.toHaveTextContent("$");
  expect(onStatus).toHaveBeenLastCalledWith("orca", expect.any(Function));
});

it("details keeps technical rows", async () => {
  serve("meteora-damm-v2", dammV2Page());
  const { container } = card("meteora-damm-v2", { address: DAMM.wallet });
  const table = await screen.findByRole("table");
  // Card-level coverage and source clocks sit under "ⓘ details".
  const note = container.querySelector<HTMLElement>(".coverage-note")!;
  const summary = note.querySelector("summary")!;
  expect(summary).toHaveTextContent("ⓘ details");
  fireEvent.click(summary);
  expect(within(note).getByText("Source snapshot positions: 1.")).toBeVisible();
  expect(within(note).getByText("Coverage reason")).toBeVisible();
  // Each row keeps its PositionDetail behind its own "ⓘ details".
  const toggle = within(table).getByRole("button", {
    name: "SYNA / " + short(DAMM.tokenB) + " details",
  });
  expect(toggle).toHaveTextContent("ⓘ details");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const detail = container.querySelector<HTMLElement>(".detail-row")!;
  expect(within(detail).getByText("Permanently locked liquidity")).toBeVisible();
  expect(within(detail).getByText("Position NFT mint")).toBeVisible();
  expect(within(detail).getByText(DAMM.pool)).toBeVisible();
});

it("claimable fees column shows only DMND claimable fees, never rewards", async () => {
  serve("orca", fixture("orca"));
  const { unmount } = card("orca");
  const table = await screen.findByRole("table");
  const row = table.querySelector<HTMLElement>("tbody tr.data-row")!;
  // Orca has reward counters and raw fee counters only: no claimable fee amount.
  expect(row.children[2]).toHaveTextContent(/^—$/);
  expect(within(row).queryByText(/raw atoms/)).toBeNull();
  unmount();
  serve("meteora-damm-v2", dammV2Page());
  card("meteora-damm-v2", { address: DAMM.wallet });
  const damm = (await screen.findByRole("table")).querySelector<HTMLElement>(
    "tbody tr.data-row",
  )!;
  const fees = damm.children[2] as HTMLElement;
  expect(within(fees).getByText("1.5")).toBeVisible();
  expect(within(fees).getByText("0.25")).toBeVisible();
  // The claimable reward (7 units) stays under details.
  expect(within(fees).queryByText("7")).toBeNull();
  expect(within(fees).queryByText(short(DAMM.reward))).toBeNull();
});

it.each(["configuration", "not_enabled", "unsupported"] as const)(
  "a %s protocol shows Not available yet and is not counted as a failure",
  async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, kind })));
    const onStatus = vi.fn();
    const { container } = card("orca", {
      component: component("orca_whirlpools", "1645.67"),
      onStatus,
    });
    expect(await screen.findByText("Not available yet")).toBeVisible();
    expect(container.querySelector(".protocol-value")).toHaveTextContent("$1,645.67");
    expect(onStatus.mock.calls.some(([, retry]) => retry !== null)).toBe(false);
  },
);

// "unavailable" is a DMND 503: temporary, so counted and retryable.
it.each(["upstream", "timeout", "rate_limited", "unavailable"] as const)(
  "a transient %s failure is counted and hides the total",
  async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, kind })));
    const onStatus = vi.fn();
    const { container } = card("orca", {
      component: component("orca_whirlpools", "1645.67"),
      onStatus,
    });
    await waitFor(() => expect(container.querySelector(".empty-state")).not.toBeNull());
    expect(container.querySelector(".protocol-value")).toHaveTextContent(/^—$/);
    expect(onStatus).toHaveBeenLastCalledWith("orca", expect.any(Function));
    expect(screen.queryByText("Not available yet")).toBeNull();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  },
);

it("an expired cursor is not a card failure and keeps the summary total", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (new URL(input, "http://test").searchParams.has("cursor"))
      return Response.json({ ok: false, kind: "invalid_input" }, { status: 400 });
    const data = fixture("orca");
    data.has_more = true;
    data.cursor = "expired";
    return Response.json({ ok: true, data });
  }));
  const onStatus = vi.fn();
  const { container } = card("orca", {
    component: component("orca_whirlpools", "1645.67"),
    onStatus,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Next positions" }));
  expect(await screen.findByText("This request couldn’t be completed")).toBeVisible();
  expect(screen.getByRole("button", { name: "First page" })).toBeVisible();
  expect(container.querySelector(".protocol-value")).toHaveTextContent("$1,645.67");
  expect(onStatus.mock.calls.some(([, retry]) => retry !== null)).toBe(false);
});

it("a lending position with no row value shows — in its group row", async () => {
  serve("kamino", fixture("kamino"));
  const { container } = card("kamino");
  await screen.findByRole("table");
  const group = container.querySelector<HTMLElement>("tr.group-row")!;
  expect(group.lastElementChild).toHaveTextContent(/^—$/);
});
