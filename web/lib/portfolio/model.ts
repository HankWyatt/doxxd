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
import { positiveUsd, sourceDetail } from "./adapters/shared";
import type { ActionTarget } from "../actions/types";
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
  /** DMND's creator-supplied token labels, when it has them (see tokenLabels). */
  symbol?: string;
  name?: string;
  image?: string;
  valueUsd?: string | null;
  /** The USD value rests on DMND's pool-implied price: an estimate. */
  estimated?: boolean;
  /** A settled counter: the amount is at least this much. */
  lowerBound?: boolean;
  qualifier?: string;
  sourceDetails?: { label: string; value: string }[];
};
/** DMND's claimable fee and reward totals for one LP position. */
export type ClaimableView = {
  /** DMND's sum of the valued fees and rewards; null when none is valued. */
  valueUsd: string | null;
  /** `accrued` includes accrual at `at`; `settled` counters are lower bounds. */
  basis: "accrued" | "settled" | null;
  at: string | null;
  estimated: boolean;
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
  /** DMND's claimable totals for LP rows that report them. */
  claimable?: ClaimableView;
  /** Some liquidity is permanently locked or vesting (Meteora DAMM v2). */
  locked?: boolean;
  /** Native stake: the validator vote account, when delegated. */
  validator?: string | null;
  /** What on-site actions need from DMND's row; absent when none apply. */
  action?: ActionTarget;
};
export type ProtocolPayload = {
  [K in ProtocolResource]: { resource: K; data: ResourceData[K] };
}[ProtocolResource];
export type ProtocolView = {
  positions: PositionView[];
  coverage: CoverageView;
  coverageClocks: { label: string; value: string }[];
  pageValueUsd: string | null;
  /** DMND's known claimable USD for this page; null unless positive. */
  pageClaimableUsd: string | null;
  /** Some row's claimables are settled (or unstated) counters: the total is a lower bound. */
  pageClaimableLowerBound: boolean;
  cursor: string | null;
  hasMore: boolean;
  continuationUnavailable: boolean;
  totalPositions: number | null;
  /** Page-boundary note for a source that has more pages; never a source state. */
  pageNote: string | null;
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
      positions = liquidityRows(input.data, input.resource);
      break;
    case "meteora":
      positions = meteoraRows(input.data);
      break;
    case "meteora-damm-v2":
      positions = dammV2Rows(input.data);
      break;
    case "raydium-cpmm":
    case "raydium-amm-v4":
      positions = fungibleRows(input.data, input.resource);
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
  // A page boundary is not a source state: a complete, fresh multi-page scan
  // keeps its own label. Only a boundary the client cannot follow (more pages
  // reported without a usable cursor, or a cursor on a last page) leaves
  // coverage unconfirmed.
  const boundaryUnclear = hasMore ? !usableCursor : Boolean(cursor);
  let coverage = coverageView({
    complete: c.complete && !boundaryUnclear,
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
    (isContinuation ||
      hasMore ||
      (hasPositionInventory && totalPositions !== 0))
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
    pageClaimableUsd:
      "page_known_claimable_value_usd" in raw
        ? positiveUsd(raw.page_known_claimable_value_usd)
        : null,
    pageClaimableLowerBound: positions.some(
      (p) => p.claimable && p.claimable.basis !== "accrued",
    ),
    cursor,
    hasMore,
    continuationUnavailable: hasMore && !usableCursor,
    totalPositions,
    pageNote:
      hasMore && usableCursor && coverage.state === "ready"
        ? "Showing " +
          (totalPositions === null
            ? positions.length + " positions"
            : positions.length + " of " + totalPositions + " positions") +
          ". More on the next page."
        : null,
  };
}
