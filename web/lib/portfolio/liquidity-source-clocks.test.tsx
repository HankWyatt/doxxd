import { render, screen, within, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PositionDetail } from "@/components/wallet/position-detail";
import { ProtocolSection } from "@/components/wallet/protocol-section";
import { useWalletResource } from "@/lib/use-wallet-resource";
import type { ResourceData, Schemas, ProtocolResource } from "../dmnd/contracts";
import { LIVE_MODE } from "../dmnd/contracts";
import { validResourcePayload } from "../dmnd/validation.server";
import { DEMO_ADDRESS, MINTS, readFixture } from "../fixtures/wallet";
import { toProtocolView as adaptProtocol, type ProtocolPayload } from "./model";

vi.mock("@/lib/use-wallet-resource", () => ({ useWalletResource: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function toProtocolView(input: ProtocolPayload) {
  expect(validResourcePayload(input.resource, input.data)).toBe(true);
  return adaptProtocol(input);
}
function fixture<K extends ProtocolResource>(resource: K): ResourceData[K] {
  const result = readFixture(resource, "complete");
  if (!result.ok) throw Error("Fixture must succeed");
  // These pinned coverage types have inventory clocks, without snapshot_slot.
  if (["raydium-cpmm", "raydium-amm-v4", "raydium-farms"].includes(resource))
    Reflect.deleteProperty(result.data.coverage, "snapshot_slot");
  return result.data;
}
function expectDetail(label: string, value: string, scope = document.body) {
  const field = within(scope).getByText(label, { exact: true }).parentElement!;
  expect(within(field).getByText(value, { exact: true })).toBeVisible();
}
const source = (account: string, context_slot: number): Schemas["WalletFungibleLiquiditySource"] => ({
  account, program: "synthetic-program", context_slot, account_sha256: "synthetic-hash",
});
const principal: Schemas["WalletFungibleLiquidityLeg"] = {
  mint: MINTS.usdc, decimals: 6, available_vault_atoms: "0", gross_atoms: "0",
  transfer_fee_atoms: "0", net_atoms: "0", ui_amount: "0", value_usd: null,
};
function farm(): Schemas["WalletFarmPosition"] {
  return {
    ledger: "farm-ledger", version: 6, status: "observed", context_slot: 101,
    principal_value_reason: "unqualified_backing", withdrawal_verified: false,
    rewards: [], principal: [principal],
    sources: [source("farm-source-a", 0), source("farm-source-b", 202)],
    principal_sources: [source("principal-source-a", 303)],
  };
}

it.each(["orca", "raydium-clmm"] as const)(
  "preserves distinct %s ownership, position, pool and snapshot clocks",
  (resource) => {
    const data = fixture(resource);
    data.data = [{ ...fixture("orca").data[0], owner_token_slot: 0,
      position_slot: 101, pool_slot: 202, snapshot_slot: 303 }];
    data.coverage.snapshot_slot = 404;
    const view = toProtocolView({ resource, data });
    expect(view.coverage.snapshotSlot).toBe(404);
    expect(view.coverageClocks.filter(({ label }) => /slot/.test(label))).toEqual([]);
    render(<PositionDetail position={view.positions[0]} />);
    expectDetail("Owner token slot", "0");
    expectDetail("Position account slot", "101");
    expectDetail("Pool slot", "202");
    expectDetail("Snapshot slot", "303");
  },
);

it("preserves independent Meteora owner, position, pair and bin-array clocks", () => {
  const data = fixture("meteora");
  const lp = fixture("orca").data[0];
  data.data = [{
    position: lp.position, pair: lp.pool, program: lp.program,
    lower_bin_id: 0, upper_bin_id: 1, principal_x: lp.principal_a,
    principal_y: lp.principal_b, fee_pending_x_atoms: "0", fee_pending_y_atoms: "0",
    rewards: [], owner_slot: 0, position_slot: 101, pair_slot: 202,
    bin_arrays_slot: 303, snapshot_slot: 404,
  }];
  data.coverage.snapshot_slot = 505;
  const view = toProtocolView({ resource: "meteora", data });
  expect(view.coverage.snapshotSlot).toBe(505);
  render(<PositionDetail position={view.positions[0]} />);
  expectDetail("Owner slot", "0");
  expectDetail("Position account slot", "101");
  expectDetail("Pair slot", "202");
  expectDetail("Bin arrays slot", "303");
  expectDetail("Snapshot slot", "404");
});

it.each(["raydium-cpmm", "raydium-amm-v4"] as const)(
  "retains %s position and individual source context slots",
  (resource) => {
    const data = fixture(resource);
    data.data = [{
      owner_token_account: "owner-token", lp_mint: "lp-mint", lp_atoms: "0",
      lp_decimals: 6, status: "observed", context_slot: 101, principal: [principal],
      sources: [source("pool-source", 0), source("vault-source", 202)],
    }];
    data.coverage.inventory_slot = 303;
    const view = toProtocolView({ resource, data });
    expect(view.coverage.snapshotSlot).toBeUndefined();
    expect(view.coverageClocks.filter(({ label }) => /slot/.test(label))).toEqual([{ label: "Inventory slot", value: "303" }]);
    expect(view.positions[0].assets[0].amount).toBe("0");
    render(<PositionDetail position={view.positions[0]} />);
    expectDetail("Position context slot", "101");
    expectDetail("Source 1 account", "pool-source");
    expectDetail("Source 1 context slot", "0");
    expectDetail("Source 2 account", "vault-source");
    expectDetail("Source 2 context slot", "202");
  },
);

it("retains farm context and individual farm/backing principal source clocks", () => {
  const data = fixture("raydium-farms");
  data.data = [farm()];
  data.coverage.inventory_slot = 404;
  data.coverage.captured_through_slot = 505;
  const view = toProtocolView({ resource: "raydium-farms", data });
  expect(view.coverage.snapshotSlot).toBeUndefined();
  expect(view.coverageClocks.filter(({ label }) => /slot/.test(label))).toEqual([
    { label: "Inventory slot", value: "404" },
    { label: "Captured through slot", value: "505" },
  ]);
  render(<PositionDetail position={view.positions[0]} />);
  expectDetail("Farm context slot", "101");
  expectDetail("Farm source 1 account", "farm-source-a");
  expectDetail("Farm source 1 context slot", "0");
  expectDetail("Farm source 2 account", "farm-source-b");
  expectDetail("Farm source 2 context slot", "202");
  expectDetail("Principal source 1 account", "principal-source-a");
  expectDetail("Principal source 1 context slot", "303");
});

it("does not invent principal source clocks when optional farm backing fields are absent", () => {
  const data = fixture("raydium-farms");
  const row = farm();
  delete row.principal_sources;
  delete row.principal;
  row.sources = [];
  row.context_slot = 0;
  data.data = [row];
  const view = toProtocolView({ resource: "raydium-farms", data });
  render(<PositionDetail position={view.positions[0]} />);
  expectDetail("Farm context slot", "0");
  expect(screen.queryByText(/Principal source/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Farm source/)).not.toBeInTheDocument();
});

it.each([
  { inventory_slot: 0, captured_through_slot: 202 },
  { inventory_slot: null, captured_through_slot: 0 },
  { inventory_slot: 101, captured_through_slot: null },
  { inventory_slot: 101 },
  {},
] satisfies Partial<Schemas["WalletFarmCoverage"]>[])(
  "renders farm coverage clocks independently, preserving null/zero/missing: %j",
  (clocks) => {
    const data = fixture("raydium-farms");
    delete data.coverage.inventory_slot;
    delete data.coverage.captured_through_slot;
    Object.assign(data.coverage, clocks);
    const view = toProtocolView({ resource: "raydium-farms", data });
    const expected = Object.entries(clocks).map(([field, value]) => ({
      label: field === "inventory_slot" ? "Inventory slot" : "Captured through slot",
      value: value === null ? "Unknown" : String(value),
    }));
    expect(view.coverageClocks.filter(({ label }) => /slot/.test(label))).toEqual(expected);
    expect(view.coverage.snapshotSlot).toBeUndefined();
    vi.mocked(useWalletResource).mockReturnValue({
      loading: false, result: { ok: true, data }, refresh: vi.fn(),
      recovery: "idle", refreshError: null,
    });
    const { container } = render(<ProtocolSection address={DEMO_ADDRESS}
      resource="raydium-farms" mode={LIVE_MODE} labels={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Raydium farms" }));
    const note = container.querySelector<HTMLElement>(".coverage-note")!;
    fireEvent.click(note.querySelector("summary")!);
    for (const detail of expected) expectDetail(detail.label, detail.value, note);
    if (!("inventory_slot" in clocks))
      expect(within(note).queryByText("Inventory slot")).not.toBeInTheDocument();
    if (!("captured_through_slot" in clocks))
      expect(within(note).queryByText("Captured through slot")).not.toBeInTheDocument();
    expect(within(note).queryByText(/Source slot:/)).not.toBeInTheDocument();
  },
);

it.each([0, null, undefined])(
  "keeps fungible inventory slot %s independent without fabricating capture or snapshot slots",
  (slot) => {
    const data = fixture("raydium-cpmm");
    if (slot === undefined) delete data.coverage.inventory_slot;
    else data.coverage.inventory_slot = slot;
    const view = toProtocolView({ resource: "raydium-cpmm", data });
    expect(view.coverage.snapshotSlot).toBeUndefined();
    expect(view.coverageClocks.filter(({ label }) => /slot/.test(label))).toEqual(slot === undefined ? [] : [
      { label: "Inventory slot", value: slot === null ? "Unknown" : "0" },
    ]);
  },
);
