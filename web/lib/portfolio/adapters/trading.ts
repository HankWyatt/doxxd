import type { Schemas } from "../../dmnd/contracts";
import type { PositionView } from "../model";
import { position, mintName, sourceDetail, sourceClockNote } from "./shared";
function spotAmount(s: Schemas["WalletDriftSpot"] | Schemas["WalletVelocitySpot"]) {
  return {
    label: s.amount ? mintName(s.amount.mint) : "Spot market " + s.market_index,
    mint: s.amount?.mint,
    amount: s.amount?.ui_amount ?? null,
    qualifier: s.amount_status,
    sourceDetails: [
      sourceDetail("Spot market", s.market_index),
      sourceDetail("Balance type", s.balance_type),
      sourceDetail("Scaled balance (raw)", s.scaled_balance),
      sourceDetail("Source token atoms", s.amount?.token_atoms),
      sourceDetail("Source spot unit amount", s.amount?.ui_amount),
      sourceDetail("Token decimals", s.amount?.decimals),
      sourceDetail("Spot market snapshot slot", s.amount?.market_snapshot_slot),
      sourceDetail("User / market snapshot relation", s.amount?.snapshot_relation),
      {
        label: "Quantity basis",
        value: "A scaled balance is not a token quantity. Market state is required for conversion.",
      },
    ],
  };
}
export function tradingRows(
  raw: Schemas["WalletDriftPositions"] | Schemas["WalletVelocityPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.position_account, "Trading account"),
    assets: [
      ...row.spots
        .filter((s) => s.balance_type !== "borrow")
        .map(spotAmount),
      ...row.perps.map((p) => ({
        label: "Perp market " + p.market_index,
        amount: p.base_ui_amount,
        qualifier: "Base quantity; not account equity",
        sourceDetails: [
          sourceDetail("Perp market", p.market_index),
          sourceDetail("Raw base amount", p.base_asset_amount),
          sourceDetail("Source base unit amount", p.base_ui_amount),
          sourceDetail("Raw quote amount", p.quote_asset_amount),
          sourceDetail("Source quote unit amount", p.quote_ui_amount),
          {
            label: "Quantity basis",
            value: "Source base and quote quantities are not USD, equity or profit.",
          },
        ],
      })),
    ],
    debts: row.spots
      .filter((s) => s.balance_type === "borrow")
      .map(spotAmount),
    details: [
      { label: "Account", value: row.position_account },
      sourceDetail("User account snapshot slot", row.snapshot_slot),
      ...("owner_inventory_slot" in row
        ? [sourceDetail("Owner inventory slot", row.owner_inventory_slot)]
        : []),
      sourceClockNote,
      { label: "Account valuation", value: raw.valuation_status },
      {
        label: "Scope",
        value:
          "Spot and perp quantities. Unknown collateral or valuation is not zero.",
      },
    ],
  }));
}
