"use client";
// The on-site action state for one LP card: who may act, each row's buttons
// and pending state, the selection, and the claim run with its progress.
//
// Everything that loads web3.js or the SDKs is reached only through
// `await import("@/lib/actions/build")` (ruling R-P4); the modules imported
// here statically are pure.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProtocolResource } from "@/lib/dmnd/contracts";
import type { PositionView } from "@/lib/portfolio/model";
import { useActionsEnabled } from "@/lib/actions/availability";
import { capabilities } from "@/lib/actions/capabilities";
import { headerWalletState } from "@/lib/actions/header-state";
import type { ActionKind } from "@/lib/actions/programs";
import type { ActionStep } from "@/lib/actions/run";
import { ACTION_PROGRAM_IDS, type ActionProtocol, type ActionTarget } from "@/lib/actions/types";
import { usePendingActions } from "@/lib/actions/use-pending-actions";
import { useConnectedWallet, useCurrentAddress } from "@/components/wallet-connect/provider";

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

export const RUN_ERRORS = {
  load: "Couldn't load every position · try again",
  build: "Couldn't load live pool data · try again",
  // The runner reports its own failures per step; this is a fault in it.
  unexpected: "Something went wrong · check your wallet before retrying",
} as const;

export type RowActionState = {
  target: ActionTarget;
  /** Offer Claim: the row may hold fees and nothing is pending for it. */
  claim: boolean;
  withdraw: "yes" | "locked" | "no";
  pending: { kind: ActionKind; stale: boolean } | null;
};

export type LpRun = {
  kind: "claim";
  /** Positions asked for; null while every page is still loading. */
  count: number | null;
  phase: "loading" | "building" | "running" | "done";
  targets: ActionTarget[];
  steps: ActionStep[];
  skipped: { positionId: string; reason: string }[];
  error: string | null;
  stopping: boolean;
  walletName: string;
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
  run: LpRun | null;
  /** A run is going; no other may start. */
  busy: boolean;
  start(kind: "claim", targets: ActionTarget[] | (() => Promise<ActionTarget[]>)): void;
  stop(): void;
  dismiss(): void;
  /** Re-read on the backoff schedule while these positions are pending. */
  refetchAfterAction(positionIds: string[]): void;
  refresh(): void;
};

export function useLpActions(
  resource: ProtocolResource,
  rows: PositionView[],
  { address, refresh }: { address: string; refresh: () => void },
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

  // The run.
  const [run, setRun] = useState<LpRun | null>(null);
  const running = useRef(false);
  const stopRequested = useRef(false);
  const update = (patch: Partial<LpRun>) => setRun((r) => (r ? { ...r, ...patch } : r));

  // Backoff refetch: positions still pending among the loaded rows.
  const refreshRef = useRef(refresh);
  const pendingIds = useRef(new Set<string>());
  useLayoutEffect(() => {
    refreshRef.current = refresh;
    pendingIds.current = new Set(
      [...states.values()].filter((s) => s.pending !== null).map((s) => s.target.id),
    );
  });
  const [refetch, setRefetch] = useState<{ epoch: number; ids: string[] }>({ epoch: 0, ids: [] });
  useEffect(() => {
    if (refetch.epoch === 0) return;
    const timers = refetchTimes().map((at) =>
      setTimeout(() => {
        if (!refetch.ids.some((id) => pendingIds.current.has(id))) {
          timers.forEach(clearTimeout);
          return;
        }
        refreshRef.current();
      }, at),
    );
    return () => timers.forEach(clearTimeout);
  }, [refetch]);
  const refetchAfterAction = useCallback(
    (ids: string[]) => setRefetch((r) => ({ epoch: r.epoch + 1, ids: [...ids] })),
    [],
  );

  const start = (kind: "claim", source: ActionTarget[] | (() => Promise<ActionTarget[]>)) => {
    if (running.current || !active || !wallet) return;
    const runWallet = wallet;
    running.current = true;
    stopRequested.current = false;
    setSelection((s) => ({ ...s, selecting: false, targets: new Map() }));
    const given = Array.isArray(source) ? source : null;
    setRun({
      kind,
      count: given ? given.length : null,
      phase: given ? "building" : "loading",
      targets: given ?? [],
      steps: [],
      skipped: [],
      error: null,
      stopping: false,
      walletName: runWallet.walletName,
    });
    void (async () => {
      let touched: string[] = [];
      try {
        let targets: ActionTarget[];
        try {
          targets = given ?? (await (source as () => Promise<ActionTarget[]>)());
        } catch {
          update({ phase: "done", error: RUN_ERRORS.load });
          return;
        }
        // Stopped while every page loaded: nothing is built or signed.
        if (stopRequested.current) {
          update({ count: targets.length, targets, phase: "done" });
          return;
        }
        update({ count: targets.length, targets, phase: "building" });
        let actions: typeof import("@/lib/actions/build");
        let rpc: ReturnType<(typeof actions)["createActionRpc"]>;
        let built: Awaited<ReturnType<(typeof actions)["buildClaimGroups"]>>;
        try {
          actions = await import("@/lib/actions/build");
          rpc = actions.createActionRpc(new URL("/api/rpc", window.location.origin).href);
          built = await actions.buildClaimGroups(rpc, runWallet.address, targets);
        } catch {
          update({ phase: "done", error: RUN_ERRORS.build });
          return;
        }
        update({ skipped: built.skipped, phase: "running" });
        const steps = await actions.runAction({
          groups: built.groups,
          expectation: built.expectation,
          intent: kind,
          wallet: runWallet,
          currentAddress,
          rpc,
          onUpdate: (next) => update({ steps: next }),
          shouldStop: () => stopRequested.current,
        });
        touched = steps.filter((s) => s.status === "confirmed").flatMap((s) => s.positionIds);
        update({ steps, phase: "done" });
      } catch {
        update({ phase: "done", error: RUN_ERRORS.unexpected });
      } finally {
        running.current = false;
        if (touched.length) refetchAfterAction(touched);
      }
    })();
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
    busy: run !== null && run.phase !== "done",
    start,
    stop: () => {
      stopRequested.current = true;
      update({ stopping: true });
    },
    dismiss: () => setRun((r) => (r && r.phase === "done" ? null : r)),
    refetchAfterAction,
    refresh: () => refreshRef.current(),
  };
}
