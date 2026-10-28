import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { PositionDetail, Amounts } from "@/components/wallet/position-detail";
import type { ResourceData, Schemas } from "../dmnd/contracts";
import { MINTS, readFixture } from "../fixtures/wallet";
import { toProtocolView, type PositionView } from "./model";

function fixture<K extends keyof ResourceData>(resource: K): ResourceData[K] {
  const result = readFixture(resource, "complete");
  if (!result.ok) throw Error("Fixture must succeed");
  return result.data;
}

function expectDetail(label: string, value: string, scope = document.body) {
  const field = within(scope).getByText(label, { exact: true }).parentElement!;
  expect(within(field).getByText(value, { exact: true })).toBeVisible();
}

function clockDetails(details: PositionView["assets"][number]["sourceDetails"]) {
  return details?.filter(({ label }) =>
    label === "Bank" || label === "Spot market" || /slot|snapshot relation/.test(label),
  );
}

it.each(["kamino", "solend"] as const)(
  "preserves independent %s reserve clocks for supplied assets and unknown debt",
  (resource) => {
    const data = fixture(resource);
    const row = fixture("kamino").data[0];
    row.snapshot_slot = 101;
    Object.assign(row.deposits[0], {
      reserve: "deposit-reserve",
      reserve_snapshot_slot: 0,
      reserve_update_slot: 0,
      reserve_update_stale: false,
      ui_amount: "0",
    });
    Object.assign(row.debts[0], {
      reserve: "debt-reserve",
      reserve_snapshot_slot: 202,
      reserve_update_slot: 201,
      reserve_update_stale: true,
      ui_amount: null,
      value_usd: null,
    });
    data.data = [row];
    data.coverage.snapshot_slot = 999;
    const view = toProtocolView(
      { resource, data } as
        | { resource: "kamino"; data: ResourceData["kamino"] }
        | { resource: "solend"; data: ResourceData["solend"] },
    );
    const position = view.positions[0];
    expect(position.assets[0].sourceDetails).toEqual([
      { label: "Reserve", value: "deposit-reserve" },
      { label: "Reserve snapshot slot", value: "0" },
      { label: "Reserve update slot", value: "0" },
      { label: "Reserve update stale", value: "false" },
    ]);
    expect(position.debts[0].sourceDetails).toEqual([
      { label: "Reserve", value: "debt-reserve" },
      { label: "Reserve snapshot slot", value: "202" },
      { label: "Reserve update slot", value: "201" },
      { label: "Reserve update stale", value: "true" },
    ]);
    expect(position.assets[0].amount).toBe("0");
    expect(position.debts[0].amount).toBeNull();
    expect(position.debts[0].valueUsd).toBeNull();
    expect(view.coverage.snapshotSlot).toBe(999);
    render(<PositionDetail position={position} />);
    expectDetail("Position snapshot slot", "101");
    const assets = screen.getByText("Supplied assets / principal").parentElement!;
    const debts = screen.getByText("Debt", { exact: true }).parentElement!;
    expectDetail("Reserve snapshot slot", "0", assets);
    expectDetail("Reserve update stale", "false", assets);
    expectDetail("Reserve snapshot slot", "202", debts);
    expectDetail("Reserve update stale", "true", debts);
  },
);

it("retains each MarginFi bank clock on both sides independently of the account", () => {
  const data = fixture("marginfi");
  const bank: Schemas["WalletMarginfiLeg"] = {
    bank: "bank-a",
    mint: MINTS.usdc,
    mint_decimals: 6,
    balance_asset_tag: 0,
    bank_asset_tag: 0,
    asset_shares: "1",
    liability_shares: "1",
    deposit_ui_amount: "0",
    debt_ui_amount: null,
    quantity_status: "unavailable",
    bank_snapshot_slot: 0,
  };
  data.data = [
    {
      position_account: "marginfi-account",
      group: "group",
      owner: "owner",
      snapshot_slot: 101,
      legs: [bank, { ...bank, bank: "bank-b", bank_snapshot_slot: 302 }],
    },
  ];
  data.coverage.snapshot_slot = 999;
  const view = toProtocolView({ resource: "marginfi", data });
  const position = view.positions[0];
  for (const side of [position.assets, position.debts]) {
    expect(side.map((amount) => clockDetails(amount.sourceDetails))).toEqual([
      [
        { label: "Bank", value: "bank-a" },
        { label: "Bank snapshot slot", value: "0" },
      ],
      [
        { label: "Bank", value: "bank-b" },
        { label: "Bank snapshot slot", value: "302" },
      ],
    ]);
  }
  expect(position.assets[0].amount).toBe("0");
  expect(position.debts[0].amount).toBeNull();
  expect(view.coverage.snapshotSlot).toBe(999);
  render(<PositionDetail position={position} />);
  expectDetail("Position snapshot slot", "101");
  expect(screen.getAllByText("Bank snapshot slot")).toHaveLength(4);
  expect(screen.getAllByText("bank-a", { exact: true })).toHaveLength(2);
  expect(screen.getAllByText("bank-b", { exact: true })).toHaveLength(2);
});

it.each(["drift", "velocity"] as const)(
  "preserves %s spot conversion slots and upstream relations without inferring clocks for null amounts",
  (resource) => {
    const data = fixture(resource);
    const spot: Schemas["WalletVelocitySpot"] = {
      slot: 0,
      market_index: 1,
      balance_type: "deposit",
      scaled_balance: "0",
      open_bids: "0",
      open_asks: "0",
      cumulative_deposits: "0",
      open_orders: 0,
      opaque_layout_evidence: false,
      amount_status: "observed",
      amount: {
        mint: MINTS.usdc,
        decimals: 6,
        token_atoms: "0",
        ui_amount: "0",
        market_snapshot_slot: 0,
        snapshot_relation: "independent_snapshots",
      },
      valuation: null,
      valuation_status: "unqualified",
    };
    const debt = {
      ...spot,
      slot: 1,
      market_index: 2,
      balance_type: "borrow",
      amount: {
        ...spot.amount!,
        market_snapshot_slot: 202,
        snapshot_relation: "same_slot",
      },
    };
    data.data = [
      {
        position_account: "trading-account",
        ...(resource === "velocity" ? { owner_inventory_slot: null } : {}),
        snapshot_slot: 101,
        spots: [
          spot,
          debt,
          {
            ...spot,
            slot: 2,
            market_index: 3,
            amount: null,
            amount_status: "unavailable",
          },
        ],
        perps: [],
      },
    ];
    data.coverage.snapshot_slot = 999;
    const view = toProtocolView(
      { resource, data } as
        | { resource: "drift"; data: ResourceData["drift"] }
        | { resource: "velocity"; data: ResourceData["velocity"] },
    );
    const position = view.positions[0];
    expect(clockDetails(position.assets[0].sourceDetails)).toEqual([
      { label: "Spot market", value: "1" },
      { label: "Spot market snapshot slot", value: "0" },
      {
        label: "User / market snapshot relation",
        value: "independent_snapshots",
      },
    ]);
    expect(clockDetails(position.debts[0].sourceDetails)).toEqual([
      { label: "Spot market", value: "2" },
      { label: "Spot market snapshot slot", value: "202" },
      { label: "User / market snapshot relation", value: "same_slot" },
    ]);
    expect(clockDetails(position.assets[1].sourceDetails)).toEqual([
      { label: "Spot market", value: "3" },
      { label: "Spot market snapshot slot", value: "Unknown" },
      { label: "User / market snapshot relation", value: "Unknown" },
    ]);
    expect(position.assets[0].amount).toBe("0");
    expect(position.assets[1].amount).toBeNull();
    expect(position.valueUsd).toBeNull();
    expect(view.coverage.snapshotSlot).toBe(999);
    render(<PositionDetail position={position} />);
    expectDetail("User account snapshot slot", "101");
    const debts = screen.getByText("Debt", { exact: true }).parentElement!;
    expectDetail("Spot market snapshot slot", "202", debts);
    expectDetail("User / market snapshot relation", "same_slot", debts);
    expect(
      screen.getByText("independent_snapshots", { exact: true }),
    ).toBeVisible();
    expect(screen.getAllByText("Spot market snapshot slot")).toHaveLength(3);
    if (resource === "velocity") expectDetail("Owner inventory slot", "Unknown");
  },
);

it("preserves a zero owner inventory clock separately from User and coverage slots", () => {
  const data = fixture("velocity");
  data.data = [
    {
      position_account: "user",
      owner_inventory_slot: 0,
      snapshot_slot: 101,
      spots: [],
      perps: [],
    },
  ];
  data.coverage.snapshot_slot = 999;
  const view = toProtocolView({ resource: "velocity", data });
  render(<PositionDetail position={view.positions[0]} />);
  expectDetail("Owner inventory slot", "0");
  expectDetail("User account snapshot slot", "101");
  expect(view.coverage.snapshotSlot).toBe(999);
});

it("keeps source metadata in expanded detail while compact amount rows stay compact", () => {
  const position: PositionView = {
    id: "position",
    label: "Position",
    assets: [
      {
        label: "USDC",
        amount: "0",
        sourceDetails: [{ label: "Bank snapshot slot", value: "0" }],
      },
    ],
    debts: [],
    rewards: [],
    valueUsd: null,
    details: [],
  };
  const { rerender } = render(<Amounts values={position.assets} />);
  expect(screen.queryByText("Bank snapshot slot")).not.toBeInTheDocument();
  rerender(<PositionDetail position={position} />);
  expectDetail("Bank snapshot slot", "0");
});
