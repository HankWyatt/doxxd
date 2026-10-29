"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  LIVE_MODE,
  type ResourceName,
  type ResourceQuery,
  type ResourceData,
  type ResourceResult,
  type ResourceError,
  type WalletDataMode,
} from "./dmnd/contracts";
import { protocolResources } from "./dmnd/resources";
import {
  needsRecovery, recoverableResource, transientError,
  RECOVERY_INTERVAL_MS, RECOVERY_WINDOW_MS, RECOVERY_MAX_RETRIES,
  type RecoveryState,
} from "./wallet-recovery";
export const WalletRefreshContext = createContext(0);
let activeDetails = 0;
const queue: (() => void)[] = [];
function detailSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const i = queue.indexOf(start);
      if (i >= 0) queue.splice(i, 1);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const start = () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        abort();
        return;
      }
      activeDetails++;
      resolve(() => {
        activeDetails--;
        queue.shift()?.();
      });
    };
    if (signal.aborted) {
      abort();
      return;
    }
    if (activeDetails < 4) start();
    else {
      queue.push(start);
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
export function useWalletResource<K extends ResourceName>(
  wallet: string,
  resource: K,
  query: ResourceQuery = {},
  mode: WalletDataMode = LIVE_MODE,
): {
  loading: boolean;
  result: ResourceResult<ResourceData[K]> | null;
  refresh: () => void;
  recovery: RecoveryState;
  refreshError: ResourceError | null;
} {
  const epoch = useContext(WalletRefreshContext);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify([wallet, resource, query, mode]);
  const [saved, setSaved] = useState<{
    key: string;
    result: ResourceResult<ResourceData[K]>;
    refreshError: ResourceError | null;
  } | null>(null);
  const [recovery, setRecovery] = useState<{ key: string; state: RecoveryState }>({ key: "", state: "idle" });
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const cooldown = useRef({ key: "", until: 0 });
  useEffect(() => {
    let current = true;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline = 0;
    let retries = 0;
    let inFlight = false;
    let automaticRequest = false;
    let latest: ResourceResult<ResourceData[K]> | null = null;
    let lastSuccess = saved?.key === key && saved.result.ok ? saved.result : null;
    const eligible = mode.kind === "live" && recoverableResource(resource, query.cursor);
    const visible = () => document.visibilityState !== "hidden";
    const status = (state: RecoveryState) => {
      if (current) setRecovery({ key, state });
    };
    const stop = () => {
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      if (automaticRequest) controller?.abort();
      if (current) setLoadingKey(null);
      status("stopped");
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!current) return;
      if (!eligible || !latest || !needsRecovery(latest)) {
        clearTimeout(deadlineTimer);
        status("idle");
        return;
      }
      if (!deadline) {
        deadline = Date.now() + RECOVERY_WINDOW_MS;
        deadlineTimer = setTimeout(stop, RECOVERY_WINDOW_MS);
      }
      if (Date.now() >= deadline || retries >= RECOVERY_MAX_RETRIES) {
        stop();
        return;
      }
      if (!visible()) {
        status("paused");
        return;
      }
      const delay = Math.max(RECOVERY_INTERVAL_MS,
        cooldown.current.key === key ? cooldown.current.until - Date.now() : 0);
      status("waiting");
      if (Date.now() + delay < deadline)
        timer = setTimeout(() => void run(true), delay);
    };
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) params.set(k, String(v));
    const path = "/api/wallet/" + encodeURIComponent(wallet) + "/" + resource;
    const url = path + (params.size ? "?" + params.toString() : "");
    const run = async (automatic: boolean) => {
      if (!current || inFlight) return;
      if (automatic && (!visible() || Date.now() >= deadline || retries >= RECOVERY_MAX_RETRIES)) {
        schedule();
        return;
      }
      // Manual refresh also respects an existing Retry-After boundary.
      if (cooldown.current.key === key && Date.now() < cooldown.current.until) {
        latest = { ok: false, kind: "rate_limited" };
        schedule();
        return;
      }
      if (automatic) retries++;
      automaticRequest = automatic;
      inFlight = true;
      controller = new AbortController();
      const signal = controller.signal;
      setLoadingKey(key);
      status(automatic ? "refreshing" : "idle");
      let release: (() => void) | undefined;
      const save = (result: ResourceResult<ResourceData[K]>) => {
        if (!current || signal.aborted) return;
        latest = result;
        if (!result.ok && result.kind === "rate_limited")
          cooldown.current = {
            key,
            until: Date.now() + (result.retryAfterSeconds ?? 15) * 1000,
          };
        if (result.ok) lastSuccess = result;
        const retained = eligible && lastSuccess && transientError(result);
        setSaved({ key, result: retained ? lastSuccess! : result,
          refreshError: retained && !result.ok ? result : null });
      };
      try {
        if (protocolResources.includes(resource as never))
          release = await detailSlot(signal);
        const response = await fetch(url, {
          signal,
          cache: "no-store",
        });
        const body: unknown = await response.json();
        let result: ResourceResult<ResourceData[K]> = {
          ok: false,
          kind: "upstream",
        };
        if (body && typeof body === "object" && "ok" in body) {
          const raw = body as Record<string, unknown>;
          if (
            raw.ok === true &&
            raw.data &&
            typeof raw.data === "object" &&
            "wallet" in raw.data &&
            raw.data.wallet === wallet
          )
            result = { ok: true, data: raw.data as ResourceData[K] };
          else if (
            raw.ok === false &&
            typeof raw.kind === "string" &&
            [
              "configuration",
              "authentication",
              "refused",
              "invalid_input",
              "unsupported",
              "unavailable",
              "not_enabled",
              "rate_limited",
              "timeout",
              "upstream",
            ].includes(raw.kind)
          ) {
            result = {
              ok: false,
              kind: raw.kind as ResourceError["kind"],
              ...(typeof raw.retryAfterSeconds === "number" &&
              Number.isFinite(raw.retryAfterSeconds) &&
              raw.retryAfterSeconds >= 0
                ? { retryAfterSeconds: raw.retryAfterSeconds }
                : {}),
            };
          }
        }
        save(result);
      } catch {
        save({ ok: false, kind: "upstream" });
      } finally {
        release?.();
        inFlight = false;
        if (current) setLoadingKey(null);
        // A hidden-tab cancellation keeps the last response and resumes only
        // within the original window. It is never recorded as a server error.
        schedule();
      }
    };
    const visibilityChanged = () => {
      if (!visible()) {
        clearTimeout(timer);
        if (automaticRequest && inFlight) controller?.abort();
        if (latest && eligible && needsRecovery(latest) && recoveryStateActive()) status("paused");
      } else if (!inFlight && latest && recoveryStateActive()) schedule();
    };
    const recoveryStateActive = () => deadline > 0 && Date.now() < deadline && retries < RECOVERY_MAX_RETRIES;
    document.addEventListener("visibilitychange", visibilityChanged);
    void run(false);
    return () => {
      current = false;
      clearTimeout(timer);
      clearTimeout(deadlineTimer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
    // The serialized key contains all request inputs. Context epoch/local nonce are explicit refreshes.
  }, [key, nonce, epoch]);
  return {
    loading: loadingKey === key || saved?.key !== key,
    result: saved?.key === key ? saved.result : null,
    refresh: () => setNonce((n) => n + 1),
    recovery: recovery.key === key ? recovery.state : "idle",
    refreshError: saved?.key === key ? saved.refreshError : null,
  };
}
