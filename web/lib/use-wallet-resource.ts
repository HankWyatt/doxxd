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
} {
  const epoch = useContext(WalletRefreshContext);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify([wallet, resource, query, mode]);
  const [saved, setSaved] = useState<{
    key: string;
    result: ResourceResult<ResourceData[K]>;
  } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const cooldown = useRef({ key: "", until: 0 });
  useEffect(() => {
    if (cooldown.current.key === key && Date.now() < cooldown.current.until)
      return;
    const controller = new AbortController();
    let current = true;
    setLoadingKey(key);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) params.set(k, String(v));
    if (mode.kind === "demo") params.set("scenario", mode.scenario);
    const path =
      mode.kind === "demo"
        ? "/api/demo/" + resource
        : "/api/wallet/" + encodeURIComponent(wallet) + "/" + resource;
    const url = path + (params.size ? "?" + params.toString() : "");
    void (async () => {
      let release: (() => void) | undefined;
      try {
        if (protocolResources.includes(resource as never))
          release = await detailSlot(controller.signal);
        const response = await fetch(url, {
          signal: controller.signal,
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
        if (current) {
          if (!result.ok && result.kind === "rate_limited")
            cooldown.current = {
              key,
              until: Date.now() + (result.retryAfterSeconds ?? 15) * 1000,
            };
          setSaved({ key, result });
        }
      } catch {
        if (current) setSaved({ key, result: { ok: false, kind: "upstream" } });
      } finally {
        release?.();
        if (current) setLoadingKey(null);
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
    // The serialized key contains all request inputs. Context epoch/local nonce are explicit refreshes.
  }, [key, nonce, epoch]);
  return {
    loading: loadingKey === key || saved?.key !== key,
    result: saved?.key === key ? saved.result : null,
    refresh: () => setNonce((n) => n + 1),
  };
}
