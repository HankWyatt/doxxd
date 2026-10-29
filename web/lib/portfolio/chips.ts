import type { ProtocolResource, Schemas } from "../dmnd/contracts";
import { compareDecimalDesc, formatUsd } from "../decimal";
import { resources } from "../dmnd/resources";

type Component = Schemas["WalletPortfolioComponent"];

export type Chip = {
  id: string;
  resource?: ProtocolResource | "overview";
  label: string;
  initials: string;
  valueUsd: string | null;
  href: string;
};

const WALLET = "tokens_native_sol";
// Same vocabulary as the header status line: these sources are still loading.
const PENDING = /queued|pending|running/;
const UNAVAILABLE = /disabled|unavailable|not_requested|missing/;

/** 1 positive, -1 negative, 0 zero, unknown or unparseable. */
const sign = (value: string | null | undefined): -1 | 0 | 1 =>
  value == null || formatUsd(value) === "—"
    ? 0
    : (-compareDecimalDesc(value, "0") as -1 | 0 | 1);

/** The value a chip or card shows: an unpriced source with no net value says nothing, so it is unknown. */
export function chipValue(
  c: Pick<Component, "known_net_value_usd" | "unpriced_count">,
): string | null {
  return (c.unpriced_count ?? 0) > 0 && sign(c.known_net_value_usd) === 0
    ? null
    : (c.known_net_value_usd ?? null);
}

function chipFor(c: Component): Chip {
  const resource = (Object.keys(resources) as (keyof typeof resources)[]).find(
    (r) => resources[r].componentId === c.id,
  );
  return {
    id: c.id,
    resource: resource as Chip["resource"],
    label: resource ? resources[resource].label : c.id.replaceAll("_", " "),
    initials: resource ? resources[resource].label.slice(0, 2) : "·",
    valueUsd: chipValue(c),
    href:
      resource === "overview"
        ? "#holdings"
        : resource
          ? "#protocol-" + resource
          : "#coverage",
  };
}

/**
 * How a summary component shows: a chip, still updating, not available, or
 * complete and empty. The wallet, when it has no chip, is none of these.
 */
export type ComponentState = "chip" | "pending" | "unavailable" | "empty";
export function componentState(c: Component): ComponentState | null {
  const value = c.known_net_value_usd ?? null;
  if (
    sign(value) !== 0 ||
    sign(c.known_asset_value_usd) > 0 ||
    sign(c.known_debt_value_usd) > 0 ||
    (c.unpriced_count ?? 0) > 0 ||
    (c.id === WALLET && value !== null)
  )
    return "chip";
  // The wallet is not a protocol, so it is never "checked" or "unavailable".
  if (c.id === WALLET) return null;
  if (PENDING.test(c.coverage_status)) return "pending";
  if (
    UNAVAILABLE.test(c.coverage_status) ||
    UNAVAILABLE.test(c.reason) ||
    !c.coverage_complete
  )
    return "unavailable";
  return "empty";
}

/**
 * Chips only for sources with something to show. The rest are summarised as
 * counts; sources still updating are counted by the header status line.
 */
export function chipModel(components: Component[]): {
  chips: Chip[];
  nothingFound: number;
  notAvailable: number;
} {
  const chips: Chip[] = [];
  let nothingFound = 0;
  let notAvailable = 0;
  for (const c of components) {
    const state = componentState(c);
    if (state === "chip") chips.push(chipFor(c));
    else if (state === "unavailable") notAvailable++;
    else if (state === "empty") nothingFound++;
  }
  // Array.prototype.sort is stable, so equal values keep summary order.
  chips.sort((a, b) => compareDecimalDesc(a.valueUsd, b.valueUsd));
  return { chips, nothingFound, notAvailable };
}
