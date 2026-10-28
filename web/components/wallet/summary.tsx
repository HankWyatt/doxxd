"use client";
import type { ResourceData, ResourceResult } from "@/lib/dmnd/contracts";
import { toSummary } from "@/lib/portfolio/model";
import { formatUsd } from "@/lib/decimal";
import { ResourceState } from "../resource-state";
export function WalletSummary({
  result,
  loading,
  retry,
}: {
  result: ResourceResult<ResourceData["summary"]> | null;
  loading: boolean;
  retry: () => void;
}) {
  if (!result)
    return (
      <section className="wallet-summary" aria-label="Loading portfolio value">
        <div>
          <div className="summary-label">Known portfolio value</div>
          <span className="skeleton big" />
        </div>
      </section>
    );
  if (!result.ok)
    return (
      <section className="wallet-summary">
        <div>
          <div className="summary-label">Known portfolio value</div>
          <div className="summary-value">—</div>
          <ResourceState error={result} retry={retry} />
        </div>
      </section>
    );
  const view = toSummary(result.data);
  const preparing = view.components.some((c) =>
    /queued|pending|running/.test(c.coverage_status),
  );
  const pending = view.valueUsd === null && preparing;
  const wallet = view.components.find((c) => c.id === "tokens_native_sol");
  const subtotal = !view.complete && view.valueUsd !== null &&
    wallet?.included_in_known_total === false;
  const subtotalUpdating = subtotal && (
      /^(snapshot_)?(queued|pending|running)$/.test(wallet.coverage_status) ||
      (wallet.coverage_status === "native_balance_stale_or_unavailable" && preparing)
    );
  const saved =
    view.components.some(
      (c) => c.included_in_known_total && c.coverage_fresh === false,
    ) &&
    view.valueUsd !== null;
  const label = subtotal
    ? subtotalUpdating ? "Portfolio still updating" : "Wallet balances unavailable"
    : pending
      ? "Preparing wallet data"
      : saved
        ? "Saved snapshots"
        : view.complete
          ? "Complete coverage"
          : "Partial coverage";
  return (
    <>
      <section className="wallet-summary" aria-busy={loading}>
        <div>
          <div className="summary-label inline">
            {subtotal ? "Subtotal from available sources" : view.label}
            <span
              className={
                "badge " +
                (pending || subtotalUpdating ? "pending" : view.complete ? "ready" : "partial")
              }
            >
              {label}
            </span>
          </div>
          <div className="summary-value numeric">
            {formatUsd(view.valueUsd)}
          </div>
          <div className="summary-note">
            {subtotal
              ? subtotalUpdating
                ? "Wallet balances are not included in this subtotal yet."
                : "Wallet balances are not included in this subtotal."
              : pending
                ? "Wallet data is being prepared. Available sources will appear as they finish."
                : preparing
                  ? "Some wallet data is still being prepared. Available sources will appear as they finish."
                  : "Known values from independent source snapshots. Some assets, debts, or prices may be missing."}
          </div>
        </div>
        <div className="summary-side">
          <div>
            <span className="eyebrow">Included sources</span>
            <strong>
              {view.components.filter((c) => c.included_in_known_total).length}
            </strong>
          </div>
          <div>
            <span className="eyebrow">Network</span>
            <strong>Solana</strong>
          </div>
        </div>
      </section>
      <details
        className="coverage-note"
        id="coverage"
        style={{ borderTop: 0, padding: "0 0 20px" }}
      >
        <summary>About this portfolio value</summary>
        <p>
          {view.complete
            ? "The service reports complete coverage for this wallet."
            : "This is the known portfolio value, not a complete net-worth figure or guaranteed minimum. Unknown debt can reduce the actual value."}
        </p>
        {view.unsupportedScopes.length > 0 && (
          <p>
            Outside current coverage:{" "}
            {view.unsupportedScopes.join(", ").replaceAll("_", " ")}.
          </p>
        )}
        <p>
          Asset, debt, and price observations can come from different snapshots.
        </p>
      </details>
    </>
  );
}
