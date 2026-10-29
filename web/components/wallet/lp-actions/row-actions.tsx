"use client";
import type { ReactNode } from "react";
import { claimableLabel } from "@/lib/actions/capabilities";
import type { ActionTarget } from "@/lib/actions/types";
import { formatAtoms, type MintLookup } from "./amounts";
import type { RowActionState } from "./use-lp-actions";

/**
 * A row's Claim / Withdraw / Locked buttons, or its pending state after an
 * action. Buttons show only when `interactive` (your own wallet).
 */
export function RowActions({
  state,
  interactive,
  busy,
  onClaim,
  onWithdraw,
  onRefresh,
}: {
  state: RowActionState;
  interactive: boolean;
  busy: boolean;
  onClaim(target: ActionTarget): void;
  onWithdraw(target: ActionTarget): void;
  onRefresh(): void;
}) {
  const { pending, target } = state;
  let status: ReactNode = null;
  if (pending)
    status = pending.stale ? (
      <span className="row-pending">
        updating · DMND hasn&apos;t caught up yet{" "}
        <button type="button" className="action-pill" onClick={onRefresh}>
          Refresh
        </button>
      </span>
    ) : (
      <span className="row-pending">{pending.kind === "claim" ? "Just claimed · updating" : "Withdrawn · updating"}</span>
    );
  const claim = interactive && state.claim;
  // A withdrawn row waits for DMND; a just-claimed one can still withdraw.
  const withdraw = interactive && pending?.kind !== "withdraw" ? state.withdraw : "no";
  if (!status && !claim && withdraw === "no") return null;
  return (
    <div className="row-actions">
      {status}
      {claim && (
        <button type="button" className="action-pill claim" disabled={busy} onClick={() => onClaim(target)}>
          Claim
        </button>
      )}
      {withdraw === "yes" && (
        <button type="button" className="action-pill" disabled={busy} onClick={() => onWithdraw(target)}>
          Withdraw
        </button>
      )}
      {withdraw === "locked" && (
        <button type="button" className="action-pill" disabled title="Locked liquidity can't be withdrawn">
          🔒 Locked
        </button>
      )}
    </div>
  );
}

/**
 * The claimable-fees cell for a row with on-site actions. Values are DMND's;
 * a pending row shows "—", and exact fees keep the card's usual cell
 * (`children`).
 */
export function RowFees({
  state,
  lookup,
  children,
}: {
  state: RowActionState;
  lookup: MintLookup;
  children: ReactNode;
}) {
  const { target } = state;
  if (state.pending) return <span className="faint">—</span>;
  const label = claimableLabel(target);
  if (label === "included") return <span className="faint">Included in your LP tokens</span>;
  if (label === "lower-bound" && target.protocol === "raydium-clmm") {
    // DMND's owed counters are settled lower bounds: "at least" when above 0.
    const owed = [
      { mint: target.tokenA.mint, atoms: target.feeOwedAAtoms },
      { mint: target.tokenB.mint, atoms: target.feeOwedBAtoms },
    ].filter((fee) => /^\d+$/.test(fee.atoms) && /[1-9]/.test(fee.atoms));
    if (!owed.length) return <span className="faint">—</span>;
    return (
      <div className="stack">
        {owed.map((fee) => (
          <span key={fee.mint} className="numeric">
            at least {formatAtoms(fee.mint, fee.atoms, lookup)}
          </span>
        ))}
      </div>
    );
  }
  return children;
}
