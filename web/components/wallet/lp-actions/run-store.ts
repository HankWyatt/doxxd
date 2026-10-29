"use client";
// The page's one wallet run, kept outside the cards: a card can collapse,
// reopen or remount mid-run and still show the progress, Stop and the busy
// state, and no card can start a second run while one is going (two runs
// would mean overlapping wallet prompts for the same positions).
//
// The run reaches web3.js and the SDKs only through
// `await import("@/lib/actions/build")` (ruling R-P4).
import { useSyncExternalStore } from "react";
import type { ProtocolResource } from "@/lib/dmnd/contracts";
import type { ActionStep } from "@/lib/actions/run";
import type { ActionTarget } from "@/lib/actions/types";
import type { ConnectedWallet } from "@/lib/actions/wallet-session";

export const RUN_ERRORS = {
  load: "Couldn't load every position · try again",
  build: "Couldn't load live pool data · try again",
  // The runner reports its own failures per step; this is a fault in it.
  unexpected: "Something went wrong · check your wallet before retrying",
} as const;

export type LpRun = {
  id: number;
  /** The connected wallet the run signs with (your own wallet's page). */
  wallet: string;
  resource: ProtocolResource;
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

/** A backoff re-read after an action, per wallet and resource. */
export type Refetch = { ids: string[]; endedAt: number; epoch: number };

type State = { run: LpRun | null; refetch: Readonly<Record<string, Refetch>> };

const EMPTY: State = { run: null, refetch: {} };
let state: State = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();
const loads = new Map<number, AbortController>();

function set(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}
function patch(id: number, change: Partial<LpRun>) {
  if (state.run?.id === id) set({ ...state, run: { ...state.run, ...change } });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const refetchKey = (wallet: string, resource: ProtocolResource) => wallet + "|" + resource;

export function useLpRunStore(): State {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

/** True while any card's run has not finished. */
export function runActive(): boolean {
  return state.run !== null && state.run.phase !== "done";
}

/** Stop before the next signing prompt or send; abandons loading pages. */
export function stopRun(): void {
  const run = state.run;
  if (!run || run.phase === "done") return;
  patch(run.id, { stopping: true });
  loads.get(run.id)?.abort();
}

/** Removes a finished run's progress. */
export function dismissRun(id: number): void {
  if (state.run?.id === id && state.run.phase === "done") set({ ...state, run: null });
}

/** Starts (or restarts) the backoff re-read of one card's resource. */
export function requestRefetch(wallet: string, resource: ProtocolResource, ids: string[]): void {
  const key = refetchKey(wallet, resource);
  set({
    ...state,
    refetch: {
      ...state.refetch,
      [key]: { ids: [...ids], endedAt: Date.now(), epoch: (state.refetch[key]?.epoch ?? 0) + 1 },
    },
  });
}

/** Test seam: forget every run and refetch. */
export function resetLpRunStore(): void {
  for (const controller of loads.values()) controller.abort();
  loads.clear();
  set(EMPTY);
}

/**
 * Claims fees from `source` (targets, or a loader for every page) with the
 * connected wallet. Returns the run's id, or null when another run is going.
 */
export function startClaimRun({
  wallet,
  resource,
  source,
  currentAddress,
}: {
  wallet: ConnectedWallet;
  resource: ProtocolResource;
  source: ActionTarget[] | ((signal: AbortSignal) => Promise<ActionTarget[]>);
  /** The wallet's live account (useCurrentAddress). */
  currentAddress: () => string | null;
}): number | null {
  if (runActive()) return null;
  const id = nextId++;
  const given = Array.isArray(source) ? source : null;
  set({
    ...state,
    run: {
      id,
      wallet: wallet.address,
      resource,
      kind: "claim",
      count: given ? given.length : null,
      phase: given ? "building" : "loading",
      targets: given ?? [],
      steps: [],
      skipped: [],
      error: null,
      stopping: false,
      walletName: wallet.walletName,
    },
  });
  const stopping = () => state.run?.id !== id || state.run.stopping;
  void (async () => {
    let touched: string[] = [];
    try {
      let targets: ActionTarget[];
      if (given) targets = given;
      else {
        const controller = new AbortController();
        loads.set(id, controller);
        try {
          targets = await (source as (signal: AbortSignal) => Promise<ActionTarget[]>)(controller.signal);
        } catch {
          patch(id, { phase: "done", error: stopping() ? null : RUN_ERRORS.load });
          return;
        } finally {
          loads.delete(id);
        }
      }
      // Stopped while pages loaded, or nothing left to claim: nothing is
      // built or signed.
      if (stopping() || targets.length === 0) {
        patch(id, { count: targets.length, targets, phase: "done" });
        return;
      }
      patch(id, { count: targets.length, targets, phase: "building" });
      let actions: typeof import("@/lib/actions/build");
      let rpc: ReturnType<(typeof actions)["createActionRpc"]>;
      let built: Awaited<ReturnType<(typeof actions)["buildClaimGroups"]>>;
      try {
        actions = await import("@/lib/actions/build");
        rpc = actions.createActionRpc(new URL("/api/rpc", window.location.origin).href);
        built = await actions.buildClaimGroups(rpc, wallet.address, targets);
      } catch {
        patch(id, { phase: "done", error: RUN_ERRORS.build });
        return;
      }
      patch(id, { skipped: built.skipped, phase: "running" });
      const steps = await actions.runAction({
        groups: built.groups,
        expectation: built.expectation,
        intent: "claim",
        wallet,
        currentAddress,
        rpc,
        onUpdate: (next) => patch(id, { steps: next }),
        shouldStop: stopping,
      });
      touched = steps.filter((s) => s.status === "confirmed").flatMap((s) => s.positionIds);
      patch(id, { steps, phase: "done" });
    } catch {
      patch(id, { phase: "done", error: RUN_ERRORS.unexpected });
    } finally {
      if (touched.length) requestRefetch(wallet.address, resource, touched);
    }
  })();
  return id;
}
