import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ResourceData } from "@/lib/dmnd/contracts";
import { readFixture } from "@/lib/fixtures/wallet";
import { WalletSummary } from "./summary";

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
  expect(screen.getByText("Partial coverage")).toBeVisible();
  expect(screen.queryByText("Saved snapshots")).not.toBeInTheDocument();
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
  expect(screen.getByText("Partial coverage")).toBeVisible();
  expect(screen.queryByText("Saved snapshots")).not.toBeInTheDocument();
  expect(screen.getByText("$12,345.67")).toBeVisible();
  expect(screen.queryByText("$999,999.99")).not.toBeInTheDocument();
});

it("keeps an included stale value labeled as saved", () => {
  const data = summary();
  data.components[0].coverage_fresh = false;
  show(data);
  expect(screen.getByText("Saved snapshots")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("keeps a stale authoritative zero as a saved value", () => {
  const data = summary();
  data.known_component_net_value_usd = "0";
  data.components[0].known_net_value_usd = "0";
  data.components[0].coverage_fresh = false;
  show(data);
  expect(screen.getByText("Saved snapshots")).toBeVisible();
  expect(screen.getByText("$0.00")).toBeVisible();
});

it.each([undefined, null])("preserves unknown freshness %s without asserting staleness", (fresh) => {
  const data = summary();
  data.components[0].coverage_fresh = fresh;
  show(data);
  expect(screen.getByText("Partial coverage")).toBeVisible();
  expect(screen.queryByText("Saved snapshots")).not.toBeInTheDocument();
  expect(screen.queryByText("Complete coverage")).not.toBeInTheDocument();
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
  expect(screen.getByText("Partial coverage")).toBeVisible();
  expect(screen.getByText("Some wallet data is still being prepared. Refresh to check progress."))
    .toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("explains a running refresh while preserving an included saved value", () => {
  const data = summary();
  Object.assign(data.components[0], { coverage_fresh: false, coverage_status: "snapshot_running" });
  show(data);
  expect(screen.getByText("Saved snapshots")).toBeVisible();
  expect(screen.getByText("Some wallet data is still being prepared. Refresh to check progress."))
    .toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});

it("keeps an unknown pending headline unknown", () => {
  const data = summary();
  data.known_component_net_value_usd = null;
  data.components[0].coverage_status = "snapshot_queued";
  show(data);
  expect(screen.getByText("Preparing wallet data")).toBeVisible();
  expect(screen.getByText("Wallet data is being prepared. Refresh to check progress.")).toBeVisible();
  expect(screen.getByText("—")).toBeVisible();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
});

it("does not describe disabled or failed sources as a running refresh", () => {
  const data = summary();
  data.components[0].coverage_status = "disabled";
  data.components[1].coverage_status = "failed";
  show(data);
  expect(screen.queryByText(/being prepared/)).not.toBeInTheDocument();
  expect(screen.getByText("Partial coverage")).toBeVisible();
});

it("preserves authoritative complete coverage when all sources are ready", () => {
  const data = summary();
  data.whole_wallet_complete = true;
  data.unsupported_scopes = [];
  show(data);
  expect(screen.getByText("Complete coverage")).toBeVisible();
  expect(screen.getByText("Portfolio value")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});
