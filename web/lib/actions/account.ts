// Pure helpers for the header account control. No React and no wallet
// libraries, so they load with the header at no cost.
import type { ProtocolResource, Schemas } from "@/lib/dmnd/contracts";
import { chipModel } from "@/lib/portfolio/chips";
import type { ActionProtocol } from "./types";

/** "J8…8n": the first two and last two characters. */
export function pillAddress(address: string): string {
  return address.length <= 5 ? address : `${address.slice(0, 2)}…${address.slice(-2)}`;
}

// The LP protocols whose cards can claim fees on site (see capabilities.ts:
// fungible LP tokens carry no separate fees).
const CLAIMABLE: readonly ActionProtocol[] = ["meteora-damm-v2", "raydium-clmm"];

/**
 * The first fee-claiming LP card the portfolio shows for this summary, or
 * null when the wallet has no positions there. Cards follow chip order.
 */
export function claimFeesTarget(
  components: Schemas["WalletPortfolioComponent"][] | null,
): ProtocolResource | null {
  if (!components) return null;
  for (const chip of chipModel(components).chips) {
    const resource = chip.resource;
    if (resource && (CLAIMABLE as readonly string[]).includes(resource))
      return resource as ProtocolResource;
  }
  return null;
}

export const HIDE_AMOUNTS_KEY = "doxxd.hide-amounts.v1";

export function readHideAmounts(): boolean {
  try {
    return window.localStorage.getItem(HIDE_AMOUNTS_KEY) === "1";
  } catch {
    return false;
  }
}
export function writeHideAmounts(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDE_AMOUNTS_KEY, "1");
    else window.localStorage.removeItem(HIDE_AMOUNTS_KEY);
  } catch {
    // Not remembered; the choice still applies on this page.
  }
}
