// Every position of one LP resource, for "Claim all fees" while the card holds
// only some pages. Follows DMND's cursor through the wallet API and maps rows
// with the card's own adapters, so a target is exactly what the row would
// carry. Pure apart from fetch: no web3.js, so the UI imports it statically.
import type { ResourceData } from "../dmnd/contracts";
import { toProtocolView, type ProtocolPayload } from "../portfolio/model";
import type { ActionProtocol, ActionTarget } from "./types";

// 100 pages of 50 is far beyond any real wallet; a cursor that never ends is
// a source fault, not more positions.
const MAX_PAGES = 100;

export class LoadAllPagesError extends Error {}

async function fetchPage<K extends ActionProtocol>(
  wallet: string,
  resource: K,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ResourceData[K]> {
  // Stop promptly between pages, whatever the fetch does with the signal.
  signal?.throwIfAborted();
  const params = new URLSearchParams({ limit: "50" });
  if (cursor !== null) params.set("cursor", cursor);
  const url = "/api/wallet/" + encodeURIComponent(wallet) + "/" + resource + "?" + params.toString();
  const response = await fetch(url, { signal, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    data?: { wallet?: unknown };
  } | null;
  if (body?.ok !== true || !body.data || typeof body.data !== "object" || body.data.wallet !== wallet)
    throw new LoadAllPagesError("A positions page could not be loaded");
  return body.data as ResourceData[K];
}

/**
 * The action targets on every page of `resource`, starting from the loaded
 * `firstPage` (or fetching it when null). Throws rather than return part of
 * the positions.
 */
export async function loadAllPages<K extends ActionProtocol>(
  wallet: string,
  resource: K,
  firstPage: ResourceData[K] | null,
  signal?: AbortSignal,
): Promise<ActionTarget[]> {
  const targets = new Map<string, ActionTarget>();
  const seen = new Set<string>();
  let data = firstPage ?? (await fetchPage(wallet, resource, null, signal));
  for (let pages = 1; ; pages++) {
    const view = toProtocolView({ resource, data } as ProtocolPayload, { isContinuation: pages > 1 });
    signal?.throwIfAborted();
    for (const row of view.positions)
      if (row.action && !targets.has(row.action.id)) targets.set(row.action.id, row.action);
    if (!view.hasMore) return [...targets.values()];
    const cursor = view.cursor;
    if (view.continuationUnavailable || cursor === null || seen.has(cursor) || pages >= MAX_PAGES)
      throw new LoadAllPagesError("The positions could not all be loaded");
    seen.add(cursor);
    data = await fetchPage(wallet, resource, cursor, signal);
  }
}
