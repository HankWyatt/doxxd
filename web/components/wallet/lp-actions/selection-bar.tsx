"use client";
import type { ActionTarget } from "@/lib/actions/types";
import { exactFeeTotals, formatAmounts, type MintLookup } from "./amounts";

/** "{N} selected · fees ≈ {amounts} · Clear · Claim fees ({N})" */
export function SelectionBar({
  selected,
  lookup,
  busy,
  onClear,
  onClaim,
}: {
  selected: ActionTarget[];
  lookup: MintLookup;
  busy: boolean;
  onClear(): void;
  onClaim(): void;
}) {
  if (selected.length === 0) return null;
  // DMND's exact figures only; lower bounds would understate the sum.
  const fees = exactFeeTotals(selected);
  return (
    <div className="selection-bar" role="group" aria-label="Selected positions">
      <strong>{selected.length} selected</strong>
      {fees.length > 0 && <span className="muted small">fees ≈ {formatAmounts(fees, lookup)}</span>}
      <span className="inline selection-actions">
        <button type="button" className="action-pill" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="action-pill primary" disabled={busy} onClick={onClaim}>
          Claim fees ({selected.length})
        </button>
      </span>
    </div>
  );
}
