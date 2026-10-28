import type { Schemas } from "../../dmnd/contracts";
import type { PositionView } from "../model";
import { position, mintName, sourceDetail } from "./shared";
import { atomsToUi } from "../../decimal";
export function stakeRows(raw: Schemas["WalletStakeAccounts"]): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.stake_account, "Native stake"),
    assets: [
      {
        label: "SOL",
        amount: atomsToUi(row.lamports, 9),
        valueUsd: row.value_usd ?? null,
      },
    ],
    valueUsd: row.value_usd ?? null,
    details: [
      { label: "Stake account", value: row.stake_account },
      sourceDetail("Account lamports", row.lamports),
      sourceDetail("Staker", row.staker),
      sourceDetail("Authorized withdrawer", row.withdrawer),
      sourceDetail("Lockup Unix timestamp (seconds)", row.lockup_unix_timestamp),
      sourceDetail("Lockup epoch", row.lockup_epoch),
      sourceDetail("Lockup custodian", row.lockup_custodian),
      { label: "Validator vote account", value: row.vote_account ?? "Unknown" },
      { label: "State", value: row.state },
      {
        label: "Delegated lamports",
        value: row.delegated_lamports ?? "Unknown",
      },
      sourceDetail("Activation epoch", row.activation_epoch),
      sourceDetail("Deactivation epoch", row.deactivation_epoch),
      { label: "Rent reserve (lamports)", value: row.rent_exempt_reserve },
      { label: "Snapshot slot", value: String(row.snapshot_slot) },
      {
        label: "Valuation / delegation basis",
        value:
          "Total account lamports include rent reserve and undelegated excess. Delegated lamports are raw delegation, not effective or withdrawable stake.",
      },
    ],
  }));
}
export function liquidRows(
  raw: Schemas["WalletLiquidStaking"],
): PositionView[] {
  return raw.positions.map((row) => ({
    ...position(row.receipt_mint, row.protocol.toUpperCase() + " receipt"),
    assets: [
      {
        label: mintName(row.receipt_mint),
        mint: row.receipt_mint,
        amount: row.receipt_ui_amount,
        qualifier: "Receipt held in wallet",
      },
    ],
    valueUsd: row.reference_value_usd ?? null,
    details: [
      {
        label: "Valuation basis",
        value:
          "SOL claim reference; receipt already included in wallet holdings. This is not an additional portfolio component.",
      },
      {
        label: "Underlying SOL claim",
        value: row.underlying_sol_amount ?? "Unknown",
      },
      { label: "Rate status", value: row.rate_status },
      { label: "Receipt mint", value: row.receipt_mint },
      {
        label: "Pool snapshot",
        value:
          row.pool_snapshot_slot == null
            ? "Unknown"
            : String(row.pool_snapshot_slot),
      },
    ],
  }));
}
