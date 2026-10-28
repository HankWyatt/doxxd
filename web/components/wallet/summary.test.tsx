import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ResourceData } from "@/lib/dmnd/contracts";
import { readFixture } from "@/lib/fixtures/wallet";
import { WalletSummary } from "./summary";

const SUBTOTAL = "Wallet balances unavailable · showing protocols only";

function summary(): ResourceData["summary"] {
  const result = readFixture("summary", "complete");
  if (!result.ok) throw new Error("Summary fixture unavailable");
  return { ...result.data, whole_wallet_complete: false };
}

function show(data: ResourceData["summary"]) {
  return render(
    <WalletSummary result={{ ok: true, data }} loading={false} retry={vi.fn()} />,
  );
}

it("keeps a current known total partial when an excluded source is missing", () => {
  const data = summary();
  Object.assign(data.components[1], {
    included_in_known_total: false,
    known_net_value_usd: null,
    coverage_fresh: false,
    coverage_complete: false,
    coverage_status: "not_requested",
  });
  show(data);
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.getByText("Some values unavailable")).toBeVisible();
  expect(screen.queryByText(/^Saved data from/)).not.toBeInTheDocument();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("does not let an excluded retained value stale the contributing total", () => {
  const data = summary();
  Object.assign(data.components[1], {
    included_in_known_total: false,
    known_net_value_usd: "999999.99",
    coverage_fresh: false,
    coverage_complete: false,
    coverage_status: "stale",
    reason: "direct_receipt_overlap",
  });
  show(data);
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.getByText("Some values unavailable")).toBeVisible();
  expect(screen.queryByText(/^Saved data from/)).not.toBeInTheDocument();
  expect(screen.getByText("$12,345.67")).toBeVisible();
  expect(screen.queryByText("$999,999.99")).not.toBeInTheDocument();
});

it("keeps an included stale value labeled as saved", () => {
  const data = summary();
  data.components[0].coverage_fresh = false;
  show(data);
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.getByText("Saved data from an earlier update")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("keeps a stale authoritative zero as a saved value", () => {
  const data = summary();
  data.known_component_net_value_usd = "0";
  data.components[0].known_net_value_usd = "0";
  data.components[0].coverage_fresh = false;
  show(data);
  expect(screen.getByText("Saved data from an earlier update")).toBeVisible();
  expect(screen.getByText("$0.00")).toBeVisible();
});

it.each([undefined, null])("preserves unknown freshness %s without asserting staleness", (fresh) => {
  const data = summary();
  data.components[0].coverage_fresh = fresh;
  show(data);
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.getByText("Some values unavailable")).toBeVisible();
  expect(screen.queryByText(/^Saved data from/)).not.toBeInTheDocument();
  expect(screen.queryByText("Updated just now")).not.toBeInTheDocument();
});

it("explains a queued excluded source while keeping the current known total", () => {
  const data = summary();
  Object.assign(data.components[1], {
    included_in_known_total: false,
    coverage_fresh: false,
    coverage_complete: false,
    coverage_status: "queued",
  });
  show(data);
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.getByText("1 source still updating")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("explains a running refresh while preserving an included saved value", () => {
  const data = summary();
  Object.assign(data.components[0], { coverage_fresh: false, coverage_status: "snapshot_running" });
  show(data);
  expect(screen.getByText("1 source still updating")).toBeVisible();
  expect(screen.queryByText(/^Saved data from/)).not.toBeInTheDocument();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("keeps an unknown pending headline unknown", () => {
  const data = summary();
  data.known_component_net_value_usd = null;
  data.components[0].coverage_status = "snapshot_queued";
  show(data);
  expect(screen.getByText("1 source still updating")).toBeVisible();
  expect(screen.getByText("—")).toBeVisible();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
});

it.each(["queued", "pending", "running", "snapshot_queued"])(
  "qualifies the unchanged zero subtotal while wallet balances are %s and excluded",
  (status) => {
    const data = summary();
    data.known_component_net_value_usd = "0";
    Object.assign(data.components[0], {
      included_in_known_total: false,
      known_net_value_usd: null,
      coverage_status: status,
      coverage_complete: false,
      coverage_fresh: false,
    });
    show(data);
    expect(screen.getByText("Known value")).toBeVisible();
    expect(screen.getByText(SUBTOTAL)).toBeVisible();
    expect(screen.getByText(SUBTOTAL)).toHaveAttribute("data-tone", "pending");
    expect(screen.getByText("$0.00")).toBeVisible();
    expect(screen.queryByText("Some values unavailable")).not.toBeInTheDocument();
  },
);

it("qualifies a nonzero subtotal when native balances are unavailable and another source is running", () => {
  const data = summary();
  Object.assign(data.components[0], {
    included_in_known_total: false,
    coverage_status: "native_balance_stale_or_unavailable",
    coverage_complete: false,
    coverage_fresh: false,
  });
  data.components[1].coverage_status = "running";
  show(data);
  expect(screen.getByText(SUBTOTAL)).toHaveAttribute("data-tone", "pending");
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("keeps a terminal zero unchanged when the wallet source is included", () => {
  const data = summary();
  data.known_component_net_value_usd = "0";
  data.components[0].known_net_value_usd = "0";
  show(data);
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.getByText("Some values unavailable")).toBeVisible();
  expect(screen.getByText("$0.00")).toBeVisible();
  expect(screen.queryByText(SUBTOTAL)).not.toBeInTheDocument();
});

it("does not infer pending native balances from a terminal unavailable source", () => {
  const data = summary();
  Object.assign(data.components[0], {
    included_in_known_total: false,
    coverage_status: "native_balance_stale_or_unavailable",
    coverage_complete: false,
    coverage_fresh: false,
  });
  show(data);
  expect(screen.getByText(SUBTOTAL)).toHaveAttribute("data-tone", "partial");
  expect(screen.queryByText(/sources? still updating/)).not.toBeInTheDocument();
  expect(screen.queryByText(/refresh failed/i)).not.toBeInTheDocument();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it.each(["failed", "disabled", "not_requested"])(
  "keeps an excluded %s wallet's zero labeled as a subtotal without claiming an active refresh",
  (status) => {
    const data = summary();
    data.known_component_net_value_usd = "0";
    Object.assign(data.components[0], {
      included_in_known_total: false,
      known_net_value_usd: null,
      coverage_status: status,
      coverage_complete: false,
      coverage_fresh: false,
    });
    show(data);
    expect(screen.getByText("Known value")).toBeVisible();
    expect(screen.getByText(SUBTOTAL)).toHaveAttribute("data-tone", "partial");
    expect(screen.getByText("$0.00")).toBeVisible();
    expect(screen.queryByText(/sources? still updating/)).not.toBeInTheDocument();
  },
);

it("keeps an excluded terminal wallet's null value unknown", () => {
  const data = summary();
  data.known_component_net_value_usd = null;
  Object.assign(data.components[0], {
    included_in_known_total: false,
    known_net_value_usd: null,
    coverage_status: "native_balance_stale_or_unavailable",
  });
  show(data);
  expect(screen.getByText("—")).toBeVisible();
  expect(screen.getByText("Value unavailable")).toBeVisible();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(screen.queryByText(SUBTOTAL)).not.toBeInTheDocument();
});

it("does not describe disabled or failed sources as a running refresh", () => {
  const data = summary();
  data.components[0].coverage_status = "disabled";
  data.components[1].coverage_status = "failed";
  show(data);
  expect(screen.queryByText(/still updating/)).not.toBeInTheDocument();
  expect(screen.getByText("Some values unavailable")).toBeVisible();
});

it("preserves authoritative complete coverage when all sources are ready", () => {
  const data = summary();
  data.whole_wallet_complete = true;
  data.unsupported_scopes = [];
  show(data);
  expect(screen.getByText("Updated just now")).toBeVisible();
  expect(screen.getByText("Net worth")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("keeps the coverage explanation behind the info button", async () => {
  const data = summary();
  show(data);
  const details = document.getElementById("coverage") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "About this value" }));
  expect(details.open).toBe(true);
  expect(within(details).getByText(/not a complete net-worth figure/)).toBeVisible();
  expect(within(details).getByText(/Outside current coverage:/)).toBeVisible();
  expect(within(details).getByText("Asset, debt, and price observations can come from different snapshots.")).toBeVisible();
  expect(screen.queryByText("Included sources")).not.toBeInTheDocument();
});

it("renders an unavailable value as a dash with its reason, never zero", () => {
  render(
    <WalletSummary
      result={{ ok: false, kind: "unavailable" }}
      loading={false}
      retry={vi.fn()}
      actions={<div data-testid="actions" />}
    />,
  );
  expect(screen.getByText("—")).toBeVisible();
  expect(screen.getByText("Value unavailable")).toBeVisible();
  expect(screen.getByText("Wallet data is unavailable")).toBeVisible();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(screen.getByTestId("actions")).toBeVisible();
});

it("announces loading with a known-value label until completeness is known", () => {
  render(<WalletSummary result={null} loading retry={vi.fn()} />);
  expect(screen.getByRole("status", { name: "Loading portfolio value" })).toBeVisible();
  expect(screen.getByText("Known value")).toBeVisible();
  expect(screen.queryByText("Net worth")).not.toBeInTheDocument();
});
