import type { Schemas } from "../../dmnd/contracts";
import type { PositionView } from "../model";
import { position, leg, legLabel, sourceDetail, sourceClockNote } from "./shared";
function reserveLeg(row: Schemas["WalletDefiLeg"] | Schemas["WalletSolendLeg"]) {
  return {
    ...leg(row),
    sourceDetails: [
      sourceDetail("Reserve", row.reserve),
      sourceDetail("Reserve snapshot slot", row.reserve_snapshot_slot),
      sourceDetail("Reserve update slot", row.reserve_update_slot),
      sourceDetail("Reserve update stale", row.reserve_update_stale),
    ],
  };
}
export function lendingRows(
  raw: Schemas["WalletDefiPositions"] | Schemas["WalletSolendPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.position_account, "Lending position"),
    assets: row.deposits.map(reserveLeg),
    debts: row.debts.map(reserveLeg),
    details: [
      { label: "Position account", value: row.position_account },
      { label: "Market", value: row.market },
      sourceDetail("Position snapshot slot", row.snapshot_slot),
      sourceClockNote,
      {
        label: "Valuation",
        value:
          "Assets and debts are separate observations. Unknown debt is not zero.",
      },
    ],
  }));
}
export function marginfiRows(
  raw: Schemas["WalletMarginfiPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.position_account, "MarginFi account"),
    assets: row.legs
      .filter((l) => l.asset_shares !== "0")
      .map((l) => ({
        label: legLabel({ mint: l.mint }),
        mint: l.mint,
        amount: l.deposit_ui_amount ?? null,
        valueUsd: l.known_deposit_value_usd ?? null,
        qualifier: l.quantity_status,
        sourceDetails: marginfiSourceDetails(l),
      })),
    debts: row.legs
      .filter((l) => l.liability_shares !== "0")
      .map((l) => ({
        label: legLabel({ mint: l.mint }),
        mint: l.mint,
        amount: l.debt_ui_amount ?? null,
        valueUsd: l.known_debt_value_usd ?? null,
        qualifier: l.quantity_status,
        sourceDetails: marginfiSourceDetails(l),
      })),
    details: [
      { label: "Position account", value: row.position_account },
      { label: "Group", value: row.group },
      sourceDetail("Position snapshot slot", row.snapshot_slot),
      sourceClockNote,
      {
        label: "Quantity basis",
        value: "Raw shares and bank amounts are separate from underlying token quantities.",
      },
    ],
  }));
}

function marginfiSourceDetails(leg: Schemas["WalletMarginfiLeg"]) {
  return [
    sourceDetail("Bank", leg.bank),
    sourceDetail("Bank snapshot slot", leg.bank_snapshot_slot),
    sourceDetail("Mint", leg.mint),
    sourceDetail("Mint decimals", leg.mint_decimals),
    sourceDetail("Asset shares (raw)", leg.asset_shares),
    sourceDetail("Liability shares (raw)", leg.liability_shares),
    sourceDetail("Bank asset atoms", leg.bank_asset_atoms),
    sourceDetail("Bank liability atoms", leg.bank_liability_atoms),
    sourceDetail("Underlying deposit atoms", leg.underlying_deposit_atoms),
    sourceDetail("Underlying debt atoms", leg.underlying_debt_atoms),
    sourceDetail("Source deposit unit amount", leg.deposit_ui_amount),
    sourceDetail("Source debt unit amount", leg.debt_ui_amount),
    sourceDetail("Source price (USD)", leg.price_usd),
    sourceDetail("Price source", leg.price_source),
    sourceDetail("Price observation (source)", leg.price_updated_at),
  ];
}
