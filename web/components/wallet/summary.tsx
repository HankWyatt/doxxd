"use client";
import { useState, type ReactNode } from "react";
import type { ResourceData, ResourceResult } from "@/lib/dmnd/contracts";
import { toSummary } from "@/lib/portfolio/model";
import {
  formatHeadline,
  headlineLabel,
  statusLine,
  VALUE_UNAVAILABLE,
} from "@/lib/portfolio/headline";
import { ResourceState } from "../resource-state";
export function WalletSummary({
  result,
  loading,
  retry,
  identity,
  actions,
}: {
  result: ResourceResult<ResourceData["summary"]> | null;
  loading: boolean;
  retry: () => void;
  identity?: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hero = (total: ReactNode) => (
    <section className="wallet-hero" aria-busy={loading}>
      {identity}
      <div className="wallet-total">
        {total}
        {actions}
      </div>
    </section>
  );
  if (!result)
    return hero(
      <div role="status" aria-label="Loading portfolio value">
        <div className="label-mono">Known value</div>
        <span className="skeleton big" />
      </div>,
    );
  if (!result.ok)
    return hero(
      <div>
        <div className="label-mono">Known value</div>
        <div className="summary-value numeric">{formatHeadline(null)}</div>
        <div className="status-line" data-tone="partial">
          {VALUE_UNAVAILABLE}
        </div>
        <ResourceState error={result} retry={retry} />
      </div>,
    );
  const view = toSummary(result.data);
  const status = statusLine(view, new Date());
  return (
    <>
      {hero(
        <div>
          <div className="label-mono inline">
            {headlineLabel(view)}
            <button
              type="button"
              className="info-button"
              aria-label="About this value"
              aria-controls="coverage"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              ⓘ
            </button>
          </div>
          <div className="summary-value numeric">
            {formatHeadline(view.valueUsd)}
          </div>
          <div className="status-line" data-tone={status.tone}>
            {status.text}
          </div>
        </div>,
      )}
      <details
        className="coverage-note"
        id="coverage"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
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
