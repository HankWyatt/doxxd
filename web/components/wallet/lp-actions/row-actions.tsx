"use client";
import type { ReactNode } from "react";
import { claimableLabel } from "@/lib/actions/capabilities";
import type { ActionTarget } from "@/lib/actions/types";
import { UnknownValue } from "@/components/unknown-value";
import type { PositionView } from "@/lib/portfolio/model";
import { ClaimableTotal, FeeUsd } from "../claim-value";
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
 * a pending row shows an unknown marker, and exact fees keep the card's usual cell
 * (`children`). CLMM owed counters read "at least" only while DMND marks them
 * `settled` (or does not say); `accrued` ones are plain amounts.
 */
export function RowFees({
  state,
  lookup,
  position,
  children,
}: {
  state: RowActionState;
  lookup: MintLookup;
  position: PositionView;
  children: ReactNode;
}) {
  const { target } = state;
  if (state.pending) return <UnknownValue reason="Still loading" />;
  const label = claimableLabel(target);
  if (label === "included") return <span className="faint">Included in your LP tokens</span>;
  if (label === "lower-bound" && target.protocol === "raydium-clmm") {
    // Settled counters are lower bounds: "at least" when above 0. Accrued ones are plain.
    const lowerBound = position.claimable?.basis !== "accrued";
    const owed = [
      { mint: target.tokenA.mint, atoms: target.feeOwedAAtoms },
      { mint: target.tokenB.mint, atoms: target.feeOwedBAtoms },
    ].filter((fee) => /^\d+$/.test(fee.atoms) && /[1-9]/.test(fee.atoms));
    if (!owed.length) return <UnknownValue reason="No claimable fees recorded" />;
    return (
      <div className="stack">
        {owed.map((fee) => {
          const priced = position.fees?.find((f) => f.mint === fee.mint);
          return (
            <span key={fee.mint} className="numeric">
              {lowerBound ? "at least " : ""}
              {formatAtoms(fee.mint, fee.atoms, lookup)}
              <FeeUsd value={priced?.valueUsd} estimated={priced?.estimated} />
            </span>
          );
        })}
        <ClaimableTotal claimable={position.claimable} />
      </div>
    );
  }
  return children;
}
