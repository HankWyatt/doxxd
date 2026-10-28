import type { ProtocolResource } from "../dmnd/contracts";
import type { ProtocolKind } from "../dmnd/resources";
import type { PositionView } from "./model";

const TAGS: Record<ProtocolKind, string> = {
  lending: "Lending",
  staking: "Staking",
  liquidity: "Liquidity Pool",
  perps: "Perps",
  yield: "Yield",
};

export const kindTag = (kind: ProtocolKind): string => TAGS[kind];

// Public pool pages only. Each builder takes a pool, pair or position address,
// never a wallet address. A protocol without a verified, stable URL pattern has
// no entry, so manageLink returns null for it.
//
// Verified:
// - Meteora DAMM v2 pool page: https://app.meteora.ag/dammv2/<pool address>.
//   Source: Meteora docs, user-guides/how-to-use-damm-v2/damm-v2-pool-detail
//   (https://docs.meteora.ag/user-guides/how-to-use-damm-v2/damm-v2-pool-detail),
//   which links pools as app.meteora.ag/dammv2/<pool> (checked 2026-10-28).
//
// Not verified, so deliberately absent (no official doc states a pattern):
// - Meteora DLMM (app.meteora.ag/dlmm/<pair>): Meteora docs and llms.txt never
//   give the URL.
// - Orca Whirlpools (orca.so pool page): docs.orca.so and its llms.txt give no
//   pool or position URL.
// - Raydium CLMM, CPMM and AMM v4: docs.raydium.io shows only API endpoints
//   (dynamic-ipfs.raydium.io/clmm/position, api-v3.raydium.io) and
//   raydium.io/portfolio, not a pool page pattern.
const MANAGE: Partial<
  Record<
    ProtocolResource,
    { name: string; href: (links: NonNullable<PositionView["links"]>) => string | null }
  >
> = {
  "meteora-damm-v2": {
    name: "Meteora",
    href: (links) =>
      links.pool
        ? "https://app.meteora.ag/dammv2/" + encodeURIComponent(links.pool)
        : null,
  },
};

export function manageLink(
  resource: ProtocolResource,
  links: PositionView["links"],
): { label: string; href: string } | null {
  const target = MANAGE[resource];
  if (!target || !links) return null;
  const href = target.href(links);
  return href ? { label: "Manage on " + target.name, href } : null;
}
