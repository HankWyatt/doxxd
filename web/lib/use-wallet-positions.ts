"use client";
import { useContext, useRef, useState } from "react";
import { WalletRefreshContext, useWalletResource } from "./use-wallet-resource";
import type { Schemas, WalletDataMode } from "./dmnd/contracts";
import type { HoldingsTradingDetails } from "./indexed-trading";

type Pages = {
  dataset: string;
  identity: string;
  cursor?: string;
  previousCursors: string[];
  pages: Schemas["WalletPositions"][];
};

/** One independent page at a time; additional pages require an explicit click. */
export function useWalletPositions(wallet: string, mode: WalletDataMode): HoldingsTradingDetails {
  const epoch = useContext(WalletRefreshContext);
  const dataset = JSON.stringify([wallet, mode]);
  const identity = JSON.stringify([wallet, mode, epoch]);
  const cooldown = useRef<{ dataset: string; until: number; error: unknown }>({
    dataset: "", until: 0, error: null,
  });
  const empty: Pages = { dataset, identity, pages: [], previousCursors: [] };
  const [saved, setSaved] = useState<Pages>(empty);
  // Wallet Refresh must not switch a rate-limited continuation to a different
  // query key and bypass the existing hook's Retry-After boundary.
  const preserveLimitedPage = saved.dataset === dataset && cooldown.current.dataset === dataset &&
    Date.now() < cooldown.current.until;
  const state = saved.identity === identity ? saved
    : preserveLimitedPage ? { ...saved, identity } : empty;
  if (saved.identity !== identity) setSaved(state);
  const resource = useWalletResource(wallet, "positions", {
    limit: 100,
    sort: "value",
    ...(state.cursor ? { cursor: state.cursor } : {}),
  }, mode);
  const current = resource.result?.ok ? resource.result.data : null;
  const error = resource.result && !resource.result.ok ? resource.result : null;
  if (error?.kind === "rate_limited" && cooldown.current.error !== error) {
    cooldown.current = {
      dataset,
      until: Date.now() + (error.retryAfterSeconds ?? 15) * 1000,
      error,
    };
  }
  const pages = current ? [...state.pages, current] : state.pages;
  const positions = new Map<string, Schemas["WalletPosition"]>();
  for (const page of pages)
    for (const position of page.data) positions.set(position.mint, position);
  const metadata = current ?? state.pages.at(-1) ?? null;
  const next = current?.cursor;
  const repeated = !!next && (next === state.cursor || state.previousCursors.includes(next));
  const continuationUnavailable = Boolean(current?.has_more && (!next || repeated));
  const hasMore = Boolean(current?.has_more && next && !repeated);

  return {
    positions,
    loading: resource.loading,
    error,
    positionsTracked: metadata?.positions_tracked ?? null,
    positionsSince: metadata?.positions_since ?? null,
    loadedCount: positions.size,
    positionCount: metadata?.position_count ?? null,
    hasMore,
    continuationUnavailable,
    loadMore() {
      if (!hasMore || !next || resource.loading || error) return;
      setSaved({
        dataset,
        identity,
        cursor: next,
        previousCursors: state.cursor
          ? [...state.previousCursors, state.cursor]
          : state.previousCursors,
        pages,
      });
    },
    reload() {
      // Keep the same query for 429 retries so its existing Retry-After boundary
      // cannot be bypassed by changing from a continuation to the first page.
      if (error?.kind !== "rate_limited") setSaved(empty);
      resource.refresh();
    },
  };
}
