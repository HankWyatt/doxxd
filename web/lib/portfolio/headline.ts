import { formatUsd } from "@/lib/decimal";
import type { SummaryView } from "./model";

export const VALUE_UNAVAILABLE = "Value unavailable";

export type StatusTone = "ready" | "pending" | "saved" | "partial";

const UPDATING = /queued|pending|running/;
const WALLET_UPDATING = /^(snapshot_)?(queued|pending|running)$/;

function flags(summary: SummaryView) {
  const { components, valueUsd, complete } = summary;
  const updating = components.filter((c) => UPDATING.test(c.coverage_status)).length;
  const wallet = components.find((c) => c.id === "tokens_native_sol");
  const subtotal =
    !complete && valueUsd !== null && wallet?.included_in_known_total === false;
  const subtotalUpdating =
    subtotal &&
    (WALLET_UPDATING.test(wallet.coverage_status) ||
      (wallet.coverage_status === "native_balance_stale_or_unavailable" &&
        updating > 0));
  // Only an explicit `false` is stale: unknown freshness asserts nothing.
  const saved =
    valueUsd !== null &&
    components.some((c) => c.included_in_known_total && c.coverage_fresh === false);
  return { updating, subtotal, subtotalUpdating, saved };
}

/** "Net worth" only for a complete wallet with no stale contributing source. */
export function headlineLabel(summary: SummaryView): "Net worth" | "Known value" {
  const stale = summary.components.some(
    (c) => c.included_in_known_total && c.coverage_fresh === false,
  );
  return summary.complete && !stale ? "Net worth" : "Known value";
}

export function formatHeadline(valueUsd: string | null): string | null {
  return valueUsd === null ? null : formatUsd(valueUsd);
}

/**
 * Component payloads carry no observation time, so the caller supplies one
 * only when it has a real timestamp. Without it the line names no time rather
 * than inventing one.
 */
export function statusLine(
  summary: SummaryView,
  now: Date,
  savedAt?: Date | null,
): { tone: StatusTone; text: string } {
  const f = flags(summary);
  if (summary.valueUsd === null && f.updating === 0)
    return { tone: "partial", text: VALUE_UNAVAILABLE };
  if (f.subtotal)
    return {
      tone: f.subtotalUpdating ? "pending" : "partial",
      text: "Wallet balances unavailable · showing protocols only",
    };
  if (f.updating > 0)
    return {
      tone: "pending",
      text: `${f.updating} ${f.updating === 1 ? "source" : "sources"} still updating`,
    };
  if (f.saved) {
    const usable =
      savedAt && !Number.isNaN(savedAt.getTime()) && savedAt <= now;
    return {
      tone: "saved",
      text: usable
        ? `Saved data from ${savedAt.toISOString().slice(11, 16)} UTC`
        : "Saved data from an earlier update",
    };
  }
  if (summary.complete) return { tone: "ready", text: "Updated just now" };
  return { tone: "partial", text: "Some values unavailable" };
}

/** A deterministic mint-and-violet gradient seeded by the address characters. */
export function avatarStyle(address: string): { background: string } {
  let hash = 2166136261;
  for (let i = 0; i < address.length; i++) {
    hash ^= address.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const angle = hash % 360;
  const split = 35 + ((hash >>> 9) % 31);
  return {
    background: `conic-gradient(from ${angle}deg, var(--accent), var(--violet) ${split}%, var(--accent))`,
  };
}
