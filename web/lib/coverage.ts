export type CoverageInput = {
  complete: boolean;
  fresh?: boolean;
  status: string;
  reason?: string;
  rowCount: number;
  scope: string;
  observedAt?: string;
  snapshotSlot?: number;
};
export type CoverageView = {
  state: "ready" | "partial" | "pending" | "stale" | "unavailable" | "empty";
  label: string;
  detail: string;
  observedAt?: string;
  snapshotSlot?: number;
};
export function coverageView(input: CoverageInput): CoverageView {
  let state: CoverageView["state"] = "partial";
  const status = (input.status + " " + (input.reason ?? "")).toLowerCase();
  if (/queued|running|pending|preparing/.test(status)) state = "pending";
  else if (
    /disabled|unavailable|not_requested|missing|failed/.test(status) &&
    input.rowCount === 0
  )
    state = "unavailable";
  else if (
    input.fresh === false &&
    (/stale/.test(status) || input.rowCount > 0)
  )
    state = "stale";
  else if (input.complete && input.fresh === true)
    state = input.rowCount === 0 ? "empty" : "ready";
  const labels = {
    ready: "Current snapshot",
    partial: "Partial coverage",
    pending: "Preparing wallet data",
    stale: "Saved snapshot",
    unavailable: "Data unavailable",
    empty: "No positions",
  };
  const details = {
    ready:
      "Positions are current for the supported scope. Account and price observations may have independent timestamps.",
    partial:
      "Coverage is incomplete or freshness is unconfirmed. Unknown assets, debts, or prices may be missing from known values.",
    pending:
      "A fresh snapshot is being prepared. Refresh in a moment to check its progress.",
    stale:
      "Saved positions are shown. This source has not been refreshed recently.",
    unavailable:
      "Current data for this source is unavailable. An empty response does not establish an empty wallet.",
    empty: "A fresh, complete scan found no positions in this supported scope.",
  };
  return {
    state,
    label: labels[state],
    detail:
      details[state] +
      (input.scope ? " Scope: " + input.scope.replaceAll("_", " ") + "." : ""),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    ...(input.snapshotSlot == null ? {} : { snapshotSlot: input.snapshotSlot }),
  };
}
