"use client";
// The on-site action state for one LP card: who may act, each row's buttons
// and pending state, the selection, and this card's view of the page's one
// claim run (./run-store.ts), which outlives the card.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProtocolResource } from "@/lib/dmnd/contracts";
import type { PositionView } from "@/lib/portfolio/model";
import { useActionsEnabled } from "@/lib/actions/availability";
import { capabilities } from "@/lib/actions/capabilities";
import { headerWalletState } from "@/lib/actions/header-state";
import type { ActionKind } from "@/lib/actions/programs";
import { ACTION_PROGRAM_IDS, type ActionProtocol, type ActionTarget } from "@/lib/actions/types";
import { usePendingActions } from "@/lib/actions/use-pending-actions";
import { useConnectedWallet, useCurrentAddress } from "@/components/wallet-connect/provider";
import {
  dismissRun,
  refetchKey,
  requestRefetch,
  startClaimRun,
  stopRun,
  useLpRunStore,
  type LpRun,
} from "./run-store";

export { RUN_ERRORS, type LpRun } from "./run-store";

export function isActionResource(resource: ProtocolResource): resource is ActionProtocol {
  return Object.hasOwn(ACTION_PROGRAM_IDS, resource);
}

/** After this long a pending row says DMND hasn't caught up yet. */
export const PENDING_STALE_MS = 10 * 60_000;
// Refetch backoff after an action (Global Constraints).
const REFETCH_FIRST_DELAYS_MS = [5_000, 10_000, 20_000, 40_000];
const REFETCH_EVERY_MS = 60_000;
const REFETCH_WINDOW_MS = 10 * 60_000;

/** When to re-read the resource after an action, in ms from the end of the run. */
export function refetchTimes(): number[] {
  const times: number[] = [];
  let at = 0;
  for (let i = 0; ; i++) {
    at += REFETCH_FIRST_DELAYS_MS[i] ?? REFETCH_EVERY_MS;
    if (at > REFETCH_WINDOW_MS) return times;
    times.push(at);
  }
}

export type RowActionState = {
  target: ActionTarget;
  /** Offer Claim: the row may hold fees and nothing is pending for it. */
  claim: boolean;
  withdraw: "yes" | "locked" | "no";
  /** Offer Close position: the row is empty but open, and nothing is pending for it. */
  close: boolean;
  pending: { kind: ActionKind; stale: boolean } | null;
};

export type LpActions = {
  /** Buttons, selection and claim-all show: actions on, own wallet, LP protocol. */
  active: boolean;
  /** Pending rows show their state: actions on and an LP protocol. */
  tracksPending: boolean;
  /** The protocol has a separate fee claim (not CPMM or AMM v4). */
  claimSupported: boolean;
  row(row: PositionView): RowActionState | null;
  /** Whether a target (possibly from an unloaded page) may be claimed now. */
  canClaim(target: ActionTarget): boolean;
  selecting: boolean;
  setSelecting(on: boolean): void;
  selected: ActionTarget[];
  isSelected(id: string): boolean;
  toggle(target: ActionTarget): void;
  clear(): void;
  /** The page's run when it belongs to this card (wallet and resource). */
  run: LpRun | null;
  /** True when this card started `run` in this mount: its panel takes focus. */
  focusRun: boolean;
  /** A run is going on any card; no other may start. */
  busy: boolean;
  start(kind: "claim", targets: ActionTarget[] | ((signal: AbortSignal) => Promise<ActionTarget[]>)): void;
  stop(): void;
  dismiss(): void;
  /** Re-read on the backoff schedule while these positions are pending. */
  refetchAfterAction(positionIds: string[]): void;
  refresh(): void;
};

export function useLpActions(
  resource: ProtocolResource,
  rows: PositionView[],
  {
    address,
    refresh,
    loaded,
  }: {
    address: string;
    refresh: () => void;
    /** The card's rows have loaded (false while a remounted card fetches). */
    loaded: boolean;
  },
): LpActions {
  const enabled = useActionsEnabled();
  const wallet = useConnectedWallet();
  const currentAddress = useCurrentAddress();
  const { pendingFor } = usePendingActions();
  const protocol = isActionResource(resource);
  const tracksPending = enabled && protocol;
  const active = tracksPending && wallet !== null && headerWalletState(address, wallet.address) === "own";
  const claimSupported = resource === "meteora-damm-v2" || resource === "raydium-clmm";

  // Re-renders when a pending row turns stale (see the effect below).
  const [now, setNow] = useState(() => Date.now());

  const pendingOf = useCallback(
    (target: ActionTarget, at: number) => {
      const record = pendingFor(address, target.id, target.snapshotSlot, at);
      return record ? { kind: record.kind, stale: at - record.at >= PENDING_STALE_MS, at: record.at } : null;
    },
    [pendingFor, address],
  );
  const canClaim = useCallback(
    (target: ActionTarget) => capabilities(target).claim !== "no" && pendingOf(target, Date.now()) === null,
    [pendingOf],
  );
  const states = useMemo(() => {
    const out = new Map<PositionView, RowActionState>();
    if (!tracksPending) return out;
    for (const row of rows) {
      if (!row.action) continue;
      const caps = capabilities(row.action);
      const pending = pendingOf(row.action, now);
      out.set(row, {
        target: row.action,
        claim: caps.claim !== "no" && pending === null,
        withdraw: caps.withdraw,
        close: caps.close === "yes" && pending === null,
        pending: pending && { kind: pending.kind, stale: pending.stale },
      });
    }
    return out;
  }, [rows, tracksPending, pendingOf, now]);
  const row = useCallback((r: PositionView) => states.get(r) ?? null, [states]);

  // The next moment a pending row turns stale, re-render.
  const nextStale = useMemo(() => {
    let next: number | null = null;
    for (const r of rows)
      if (r.action) {
        const pending = pendingOf(r.action, now);
        if (pending && !pending.stale) next = Math.min(next ?? Infinity, pending.at + PENDING_STALE_MS);
      }
    return next;
  }, [rows, pendingOf, now]);
  useEffect(() => {
    if (nextStale === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextStale - Date.now()));
    return () => clearTimeout(timer);
  }, [nextStale]);

  // Selection belongs to one connected account; it resets when that changes.
  const owner = active ? wallet!.address : null;
  const [selection, setSelection] = useState<{
    owner: string | null;
    selecting: boolean;
    targets: Map<string, ActionTarget>;
  }>({ owner, selecting: false, targets: new Map() });
  if (selection.owner !== owner) setSelection({ owner, selecting: false, targets: new Map() });
  const selected = useMemo(() => [...selection.targets.values()], [selection.targets]);

  // The page's run; this card shows it when it is for this wallet's resource.
  const store = useLpRunStore();
  const run = store.run && store.run.wallet === address && store.run.resource === resource ? store.run : null;
  const busy = store.run !== null && store.run.phase !== "done";
  const [startedHere, setStartedHere] = useState<number | null>(null);

  // Backoff refetch: positions still pending among the loaded rows. Until the
  // card's rows have loaded (a remount) that is unknown, never "none".
  const refreshRef = useRef(refresh);
  const pendingIds = useRef(new Set<string>());
  const rowsLoaded = useRef(loaded);
  useLayoutEffect(() => {
    refreshRef.current = refresh;
    rowsLoaded.current = loaded;
    pendingIds.current = new Set(
      [...states.values()].filter((s) => s.pending !== null).map((s) => s.target.id),
    );
  });
  // Kept in the store, so a card that remounts mid-window resumes it.
  const refetch = store.refetch[refetchKey(address, resource)] ?? null;
  useEffect(() => {
    if (!refetch) return;
    const elapsed = Date.now() - refetch.endedAt;
    const timers = refetchTimes()
      .filter((at) => at > elapsed)
      .map((at) =>
        setTimeout(() => {
          // Still loading: that read is fresh already.
          if (!rowsLoaded.current) return;
          if (!refetch.ids.some((id) => pendingIds.current.has(id))) {
            timers.forEach(clearTimeout);
            return;
          }
          refreshRef.current();
        }, at - elapsed),
      );
    return () => timers.forEach(clearTimeout);
  }, [refetch]);
  const refetchAfterAction = useCallback(
    (ids: string[]) => requestRefetch(address, resource, ids),
    [address, resource],
  );

  const start = (kind: "claim", source: ActionTarget[] | ((signal: AbortSignal) => Promise<ActionTarget[]>)) => {
    if (busy || !active || !wallet || kind !== "claim") return;
    const id = startClaimRun({ wallet, resource, source, currentAddress });
    if (id === null) return;
    setStartedHere(id);
    setSelection((s) => ({ ...s, selecting: false, targets: new Map() }));
  };

  return {
    active,
    tracksPending,
    claimSupported,
    row,
    canClaim,
    selecting: selection.selecting,
    setSelecting: (on) => setSelection((s) => ({ ...s, selecting: on, targets: on ? s.targets : new Map() })),
    selected,
    isSelected: (id) => selection.targets.has(id),
    toggle: (target) =>
      setSelection((s) => {
        const targets = new Map(s.targets);
        if (targets.has(target.id)) targets.delete(target.id);
        else targets.set(target.id, target);
        return { ...s, targets };
      }),
    clear: () => setSelection((s) => ({ ...s, targets: new Map() })),
    run,
    focusRun: run !== null && run.id === startedHere,
    busy,
    start,
    stop: stopRun,
    dismiss: () => {
      if (run) dismissRun(run.id);
    },
    refetchAfterAction,
    refresh: () => refreshRef.current(),
  };
}
