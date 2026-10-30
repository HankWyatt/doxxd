import { orUnknown } from "@/components/unknown-value";
import { formatUsd } from "@/lib/decimal";
import type { ClaimableView } from "@/lib/portfolio/model";

/** A USD value rests on DMND's pool-implied price: marked, not recoloured. */
export function Estimate() {
  return (
    <span className="muted small" title="Estimated from this pool's own reserves">
      {" "}
      est.
    </span>
  );
}

/** One fee's USD value, only when DMND values it. */
export function FeeUsd({
  value,
  estimated,
}: {
  value: string | null | undefined;
  estimated?: boolean;
}) {
  if (value == null) return null;
  return (
    <>
      <span className="faint"> ({orUnknown(formatUsd(value))})</span>
      {estimated && <Estimate />}
    </>
  );
}

/**
 * DMND's claimable total for a row (fees and rewards it values; unvalued ones
 * are left out); nothing when unknown. Settled counters make it a lower bound.
 */
export function ClaimableTotal({ claimable }: { claimable?: ClaimableView }) {
  if (!claimable?.valueUsd) return null;
  return (
    <div title="Fees and rewards DMND values; unvalued ones are left out">
      <span className="numeric">
        {claimable.basis !== "accrued" ? "at least " : ""}
        {orUnknown(formatUsd(claimable.valueUsd))}
      </span>{" "}
      <span className="faint small">claimable</span>
      {claimable.estimated && <Estimate />}
    </div>
  );
}
