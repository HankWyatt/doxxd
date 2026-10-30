import type { Schemas } from "../../dmnd/contracts";
import type { PositionView } from "../model";
import { position, leg, legLabel, sourceDetail, sourceClockNote } from "./shared";
import { sourceContextDetails } from "./liquidity";
export function farmRows(raw: Schemas["WalletFarmPositions"]): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.ledger, "Farm deposit"),
    assets: row.principal?.length
      ? row.principal.map(leg)
      : [
          {
            label: row.deposited_mint
              ? legLabel({ mint: row.deposited_mint })
              : "Deposit",
            mint: row.deposited_mint ?? undefined,
            amount: row.deposited_ui_amount ?? null,
          },
        ],
    rewards: row.rewards.map((r) => ({
      label: r.mint ? legLabel({ mint: r.mint }) : "Reward",
      mint: r.mint ?? undefined,
      amount: r.estimated_pending_atoms ?? null,
      valueUsd: r.value_usd ?? null,
      qualifier:
        "raw atoms; SDK estimate; " +
        (r.funding_verified ? "funding verified" : "funding unverified"),
    })),
    valueUsd: row.principal_value_usd ?? null,
    details: [
      { label: "Farm", value: row.farm ?? "Unknown" },
      { label: "Ledger", value: row.ledger },
      { label: "Principal valuation", value: row.principal_value_reason },
      {
        label: "Withdrawal",
        value: row.withdrawal_verified ? "Verified by source" : "Not verified",
      },
      {
        label: "Voting lock atoms (subset of deposit)",
        value: row.voting_locked_atoms ?? "Unknown",
      },
      sourceDetail("Farm context slot", row.context_slot),
      ...sourceContextDetails(row.sources, "Farm source"),
      ...sourceContextDetails(row.principal_sources ?? [], "Principal source"),
      sourceClockNote,
    ],
  }));
}
