import type {
  Schemas,
  ProtocolResource,
  ResourceData,
} from "../dmnd/contracts";
import { coverageView, type CoverageView } from "../coverage";
import { stakeRows, liquidRows } from "./adapters/staking";
import { lendingRows, marginfiRows } from "./adapters/lending";
import {
  liquidityRows,
  meteoraRows,
  dammV2Rows,
  fungibleRows,
} from "./adapters/liquidity";
import { farmRows } from "./adapters/farms";
import { tradingRows } from "./adapters/trading";
import { sourceDetail } from "./adapters/shared";
export type SummaryView = {
  label: string;
  valueUsd: string | null;
  complete: boolean;
  components: Schemas["WalletPortfolioComponent"][];
  unsupportedScopes: string[];
};
export type AmountView = {
  label: string;
  amount: string | null;
  mint?: string;
  valueUsd?: string | null;
  qualifier?: string;
  sourceDetails?: { label: string; value: string }[];
};
export type PositionView = {
  id: string;
  label: string;
  assets: AmountView[];
  debts: AmountView[];
  rewards: AmountView[];
  valueUsd: string | null;
  details: { label: string; value: string }[];
  links?: { pool?: string; position?: string; positionMint?: string };
  /** DMND's claimable LP fees, when it reports them (Meteora DAMM v2). */
  fees?: AmountView[];
  /** Some liquidity is permanently locked or vesting (Meteora DAMM v2). */
  locked?: boolean;
  /** Native stake: the validator vote account, when delegated. */
  validator?: string | null;
};
export type ProtocolPayload = {
  [K in ProtocolResource]: { resource: K; data: ResourceData[K] };
}[ProtocolResource];
export type ProtocolView = {
  positions: PositionView[];
  coverage: CoverageView;
  coverageClocks: { label: string; value: string }[];
  pageValueUsd: string | null;
  cursor: string | null;
  hasMore: boolean;
  continuationUnavailable: boolean;
  totalPositions: number | null;
};
export function toSummary(raw: Schemas["WalletPortfolioSummary"]): SummaryView {
  return {
    label: raw.whole_wallet_complete
      ? "Portfolio value"
      : "Known portfolio value",
    valueUsd: raw.known_component_net_value_usd ?? null,
    complete: raw.whole_wallet_complete,
    components: raw.components,
    unsupportedScopes: raw.unsupported_scopes,
  };
}
export function toProtocolView(
  input: ProtocolPayload,
  { isContinuation = false }: { isContinuation?: boolean } = {},
): ProtocolView {
  let positions: PositionView[] = [];
  switch (input.resource) {
    case "stake":
      positions = stakeRows(input.data);
      break;
    case "liquid-staking":
      positions = liquidRows(input.data);
      break;
    case "kamino":
    case "solend":
      positions = lendingRows(input.data);
      break;
    case "marginfi":
      positions = marginfiRows(input.data);
      break;
    case "orca":
    case "raydium-clmm":
      positions = liquidityRows(input.data);
      break;
    case "meteora":
      positions = meteoraRows(input.data);
      break;
    case "meteora-damm-v2":
      positions = dammV2Rows(input.data);
      break;
    case "raydium-cpmm":
    case "raydium-amm-v4":
      positions = fungibleRows(input.data);
      break;
    case "raydium-farms":
      positions = farmRows(input.data);
      break;
    case "drift":
    case "velocity":
      positions = tradingRows(input.data);
      break;
  }
  const raw = input.data,
    c = raw.coverage;
  // Liquid receipts are unpaged; same-name extensions are not pagination data.
  const page = input.resource === "liquid-staking" ? null : input.data;
  const cursor = page && typeof page.cursor === "string" ? page.cursor : null,
    hasMore = page?.has_more === true;
  const usableCursor = typeof cursor === "string" && cursor.trim().length > 0;
  const hasPositionInventory =
    input.resource === "orca" ||
    input.resource === "raydium-clmm" ||
    input.resource === "meteora" ||
    input.resource === "meteora-damm-v2";
  const rawTotalPositions =
    hasPositionInventory && "total_positions" in c ? c.total_positions : null;
  const totalPositions =
    typeof rawTotalPositions === "number" &&
    Number.isSafeInteger(rawTotalPositions) &&
    rawTotalPositions >= 0
      ? rawTotalPositions
      : null;
  let coverage = coverageView({
    complete: c.complete && !hasMore && !cursor,
    fresh: "fresh" in c ? c.fresh : undefined,
    status: "status" in c ? c.status : c.snapshot_status,
    reason: c.reason,
    rowCount: positions.length,
    scope: "scope" in c ? c.scope : "direct liquid-staking receipts",
    observedAt: "fetched_at" in c ? (c.fetched_at ?? undefined) : undefined,
    snapshotSlot:
      "snapshot_slot" in c ? (c.snapshot_slot ?? undefined) : undefined,
  });
  // A complete source snapshot can still return an empty page. Only the seed
  // page, without a contradictory inventory count, can establish scope emptiness.
  if (
    coverage.state === "empty" &&
    (isContinuation || (hasPositionInventory && totalPositions !== 0))
  ) {
    coverage = {
      ...coverage,
      state: "ready",
      label: "Current snapshot",
      detail:
        "The source reports a fresh, complete snapshot for this supported scope. An empty page does not establish an empty scope. Account and price observations may have independent timestamps." +
        ("scope" in c ? " Scope: " + c.scope.replaceAll("_", " ") + "." : ""),
    };
  }
  return {
    positions,
    coverage,
    coverageClocks: [
      sourceDetail("Source coverage complete", c.complete),
      sourceDetail("Coverage reason", c.reason),
      ...("inventory_slot" in c
        ? [sourceDetail("Inventory slot", c.inventory_slot)]
        : []),
      ...("captured_through_slot" in c
        ? [sourceDetail("Captured through slot", c.captured_through_slot)]
        : []),
    ],
    pageValueUsd:
      "page_known_principal_value_usd" in raw
        ? (raw.page_known_principal_value_usd ?? null)
        : null,
    cursor,
    hasMore,
    continuationUnavailable: hasMore && !usableCursor,
    totalPositions,
  };
}
