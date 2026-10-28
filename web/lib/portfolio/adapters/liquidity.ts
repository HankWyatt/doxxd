import type { Schemas } from "../../dmnd/contracts";
import type { PositionView } from "../model";
import { position, leg, mintName, sourceDetail, sourceClockNote } from "./shared";
export function sourceContextDetails(
  sources: Schemas["WalletFungibleLiquiditySource"][],
  prefix = "Source",
) {
  return sources.flatMap((source, i) => [
    sourceDetail(`${prefix} ${i + 1} account`, source.account),
    sourceDetail(`${prefix} ${i + 1} context slot`, source.context_slot),
  ]);
}
export function liquidityRows(
  raw: Schemas["WalletLiquidityPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(
      row.position,
      mintName(row.principal_a.mint) + " / " + mintName(row.principal_b.mint),
    ),
    assets: [leg(row.principal_a), leg(row.principal_b)],
    rewards: row.rewards.map((r) => ({
      label: r.mint ? mintName(r.mint) : "Reward",
      mint: r.mint ?? undefined,
      amount: r.owed_atoms,
      qualifier: "raw atoms; settled owed counter",
    })),
    details: [
      { label: "Pool", value: row.pool },
      { label: "Position", value: row.position },
      { label: "Tick range", value: row.tick_lower + " → " + row.tick_upper },
      {
        label: "Owed fee counters (raw atoms)",
        value: row.fee_owed_a + " / " + row.fee_owed_b,
      },
      sourceDetail("Owner token slot", row.owner_token_slot),
      sourceDetail("Position account slot", row.position_slot),
      sourceDetail("Pool slot", row.pool_slot),
      sourceDetail("Snapshot slot", row.snapshot_slot),
      sourceClockNote,
      {
        label: "Valuation",
        value: "Principal only. Fees and reward counters are shown separately.",
      },
    ],
  }));
}
export function meteoraRows(
  raw: Schemas["WalletMeteoraPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(
      row.position,
      mintName(row.principal_x.mint) + " / " + mintName(row.principal_y.mint),
    ),
    assets: [leg(row.principal_x), leg(row.principal_y)],
    rewards: row.rewards.map((r) => ({
      label: r.mint ? mintName(r.mint) : "Reward",
      mint: r.mint ?? undefined,
      amount: r.pending_atoms,
      qualifier: "raw atoms; pending counter",
    })),
    details: [
      { label: "Pair", value: row.pair },
      { label: "Position", value: row.position },
      {
        label: "Bin range",
        value: row.lower_bin_id + " → " + row.upper_bin_id,
      },
      {
        label: "Pending fee counters (raw atoms)",
        value: row.fee_pending_x_atoms + " / " + row.fee_pending_y_atoms,
      },
      sourceDetail("Owner slot", row.owner_slot),
      sourceDetail("Position account slot", row.position_slot),
      sourceDetail("Pair slot", row.pair_slot),
      sourceDetail("Bin arrays slot", row.bin_arrays_slot),
      sourceDetail("Snapshot slot", row.snapshot_slot),
      sourceClockNote,
    ],
  }));
}
export function fungibleRows(
  raw: Schemas["WalletFungibleLiquidityPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.owner_token_account, "Direct LP receipt"),
    assets: row.principal.map(leg),
    details: [
      { label: "LP mint", value: row.lp_mint },
      { label: "Receipt atoms", value: row.lp_atoms },
      { label: "Token account", value: row.owner_token_account },
      { label: "Pool", value: row.pool ?? "Unqualified" },
      { label: "Status", value: row.reason ?? row.status },
      {
        label: "Withdrawal availability",
        value:
          row.withdrawal_available == null
            ? "Unknown"
            : row.withdrawal_available
              ? "Observed available"
              : "Restricted",
      },
      sourceDetail("Position context slot", row.context_slot),
      ...sourceContextDetails(row.sources),
      sourceClockNote,
    ],
  }));
}
