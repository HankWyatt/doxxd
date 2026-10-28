import { normalizeAddress } from "../address";
import { isResource, protocolResources, resources } from "./resources";
import { parseResourceQuery } from "./query";
import { validResourcePayload } from "./validation.server";
import { bodyJson } from "./read-json.mjs";
import type {
  ResourceData,
  ResourceName,
  ResourceQuery,
  ResourceResult,
} from "./contracts";
export type DmndEnv = {
  DMND_API_BASE_URL?: string;
  DMND_API_KEY?: string;
  DMND_ENABLED_PROTOCOLS?: string;
  DMND_ALLOWED_WALLETS?: string;
  DMND_REQUEST_BUDGET?: string;
};
function apiBase(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    const local =
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      process.env.NODE_ENV !== "production";
    return url.protocol === "https:" || (url.protocol === "http:" && local)
      ? url
      : null;
  } catch {
    return null;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const decimal = (value: unknown) =>
  value == null ||
  (typeof value === "string" &&
    /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value));
const componentResources = new Map(
  Object.values(resources).flatMap((definition) =>
    definition.componentId ? [[definition.componentId, definition] as const] : [],
  ),
);
function validComponentSource(row: Record<string, unknown>, wallet: string) {
  const source = row.source_path;
  const prefix = `/wallets/${wallet}/`;
  if (typeof source !== "string" || !source.startsWith(prefix)) return false;
  const definition = componentResources.get(String(row.id));
  if (definition)
    return (
      source ===
      prefix + definition.path +
        (definition.protocol ? `?protocol=${definition.protocol}` : "")
    );
  // Preserve future components, but require canonical wallet-scoped provenance.
  // Source paths are metadata; the client never follows them to fetch data.
  try {
    const url = new URL(source, "https://source.invalid");
    return url.pathname.length > prefix.length &&
      url.pathname + url.search === source && !url.hash;
  } catch {
    return false;
  }
}
function validPayload(
  resource: ResourceName,
  value: unknown,
  wallet: string,
): boolean {
  if (!validResourcePayload(resource, value)) return false;
  if (
    !record(value) ||
    value.wallet !== wallet ||
    !Array.isArray(value[resources[resource].field])
  )
    return false;
  if (resource === "summary")
    return (
      typeof value.whole_wallet_complete === "boolean" &&
      decimal(value.known_component_net_value_usd) &&
      Array.isArray(value.unsupported_scopes) &&
      (value.components as unknown[]).every(
        (row) =>
          record(row) &&
          typeof row.id === "string" &&
          validComponentSource(row, wallet) &&
          decimal(row.known_net_value_usd),
      )
    );
  if (!record(value.coverage)) return false;
  const rows = value[resources[resource].field] as unknown[];
  if (!rows.every(record)) return false;
  if (resource === "overview")
    return (
      typeof value.known_value_usd === "string" &&
      rows.every(
        (row) =>
          record(row) &&
          typeof row.mint === "string" &&
          typeof row.amount === "string" &&
          decimal(row.value_usd),
      )
    );
  if (resource === "transactions")
    return rows.every(
      (row) =>
        record(row) &&
        typeof row.signature === "string" &&
        typeof row.block_time === "string" &&
        Array.isArray(row.changes) &&
        Array.isArray(row.observed_trades) &&
        Array.isArray(row.observed_transfers),
    );
  return true;
}
export function createDmndClient(
  env: DmndEnv,
  fetchImpl: typeof fetch = fetch,
) {
  const pending = new Map<string, Promise<ResourceResult<unknown>>>();
  let upstreamReads = 0;
  async function read<K extends ResourceName>(
    wallet: string,
    resource: K,
    query: ResourceQuery = {},
  ): Promise<ResourceResult<ResourceData[K]>> {
    if (normalizeAddress(wallet) !== wallet || !isResource(resource))
      return { ok: false, kind: "invalid_input" };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    const validQuery = parseResourceQuery(resource, params);
    if (validQuery === null) return { ok: false, kind: "invalid_input" };
    const allowed = env.DMND_ALLOWED_WALLETS?.split(",").map((value) =>
      value.trim(),
    );
    if (allowed?.some((value) => normalizeAddress(value) !== value))
      return { ok: false, kind: "configuration" };
    if (allowed && !allowed.includes(wallet))
      return { ok: false, kind: "unavailable" };
    const budget =
      env.DMND_REQUEST_BUDGET === undefined
        ? undefined
        : Number(env.DMND_REQUEST_BUDGET);
    if (
      budget !== undefined &&
      (!/^\d+$/.test(env.DMND_REQUEST_BUDGET!) ||
        !Number.isInteger(budget) ||
        budget < 1 ||
        budget > 34)
    )
      return { ok: false, kind: "configuration" };
    const base = apiBase(
      env.DMND_API_BASE_URL ?? "https://api.dmnd.dev/api/v1",
    );
    if (!base || !env.DMND_API_KEY) return { ok: false, kind: "configuration" };
    if (
      protocolResources.includes(resource as never) &&
      !env.DMND_ENABLED_PROTOCOLS?.split(",")
        .map((v) => v.trim())
        .includes(resource)
    )
      return { ok: false, kind: "unavailable" };
    const identity = JSON.stringify([wallet, resource, validQuery]);
    const existing = pending.get(identity);
    if (existing) return existing as Promise<ResourceResult<ResourceData[K]>>;
    const request = (async (): Promise<ResourceResult<ResourceData[K]>> => {
      if (budget !== undefined && upstreamReads >= budget)
        return { ok: false, kind: "refused" };
      upstreamReads++;
      const definition = resources[resource];
      const url = new URL(base.href);
      url.pathname =
        url.pathname.replace(/\/$/, "") +
        "/wallets/" +
        encodeURIComponent(wallet) +
        "/" +
        definition.path;
      for (const [key, value] of Object.entries(validQuery))
        url.searchParams.set(key, String(value));
      if (definition.protocol)
        url.searchParams.set("protocol", definition.protocol);
      url.searchParams.set("api_key", env.DMND_API_KEY!);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 8000);
      try {
        const response = await fetchImpl(url.toString(), {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 429) {
          const raw = response.headers.get("retry-after");
          let seconds =
            raw && /^\d+$/.test(raw)
              ? Number(raw)
              : raw
                ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
                : undefined;
          if (
            seconds !== undefined &&
            (!Number.isFinite(seconds) || seconds < 0)
          )
            seconds = undefined;
          return {
            ok: false,
            kind: "rate_limited",
            ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
          };
        }
        if (response.status === 501) return { ok: false, kind: "unsupported" };
        if (response.status === 401 || response.status === 403)
          return {
            ok: false,
            kind: "authentication",
            upstreamStatus: response.status,
          };
        if (response.status === 422) return { ok: false, kind: "refused" };
        if (response.status === 400)
          return { ok: false, kind: "invalid_input" };
        if (response.status === 503) return { ok: false, kind: "unavailable" };
        if (!response.ok || response.status >= 300)
          return { ok: false, kind: "upstream" };
        const body: unknown = await bodyJson(response);
        return validPayload(resource, body, wallet)
          ? { ok: true, data: body as ResourceData[K] }
          : { ok: false, kind: "upstream" };
      } catch (error) {
        return {
          ok: false,
          kind: timedOut
            ? "timeout"
            : error instanceof Error && error.message === "response_too_large"
              ? "refused"
              : "upstream",
        };
      } finally {
        clearTimeout(timer);
      }
    })();
    pending.set(identity, request);
    try {
      return await request;
    } finally {
      pending.delete(identity);
    }
  }
  return { read };
}
let cached:
  | { signature: string; client: ReturnType<typeof createDmndClient> }
  | undefined;
export function serverClient() {
  const env: DmndEnv = {
    DMND_API_BASE_URL: process.env.DMND_API_BASE_URL,
    DMND_API_KEY: process.env.DMND_API_KEY,
    DMND_ENABLED_PROTOCOLS: process.env.DMND_ENABLED_PROTOCOLS,
    DMND_ALLOWED_WALLETS: process.env.DMND_ALLOWED_WALLETS,
    DMND_REQUEST_BUDGET: process.env.DMND_REQUEST_BUDGET,
  };
  const signature = JSON.stringify(env);
  if (!cached || cached.signature !== signature)
    cached = { signature, client: createDmndClient(env) };
  return cached.client;
}
