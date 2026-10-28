import { LIVE_MODE, type WalletDataMode } from "../dmnd/contracts";
import { parseResourceQuery } from "../dmnd/query";
import { walletHref } from "../address";
export type ActivityWindow = { from?: string; to?: string };
export function parseActivityWindow(
  params: URLSearchParams,
): ActivityWindow | null {
  const selected = new URLSearchParams();
  for (const key of ["from", "to"])
    for (const value of params.getAll(key)) selected.append(key, value);
  const query = parseResourceQuery("transactions", selected);
  if (!query) return null;
  return {
    ...(query.from ? { from: new Date(query.from).toISOString() } : {}),
    ...(query.to ? { to: new Date(query.to).toISOString() } : {}),
  };
}
export function activityHref(
  wallet: string,
  window: ActivityWindow,
  cursor?: string,
  mode: WalletDataMode = LIVE_MODE,
  source: "transactions" | "activity" = "transactions",
): string {
  const params = new URLSearchParams();
  if (mode.kind === "demo") {
    params.set("tab", "activity");
    if (mode.scenario !== "complete") params.set("scenario", mode.scenario);
  }
  if (window.from) params.set("from", window.from);
  if (window.to) params.set("to", window.to);
  if (cursor) params.set("cursor", cursor);
  if (source === "activity") params.set("source", "activity");
  const path = mode.kind === "demo" ? "/demo" : walletHref(wallet, "activity");
  return path + (params.size ? "?" + params.toString() : "");
}
export function activityPageInput(
  input: Record<string, string | string[] | undefined>,
): {
  window: ActivityWindow;
  cursor?: string;
  source: "transactions" | "activity";
} | null {
  const selected = new URLSearchParams();
  for (const key of ["from", "to", "cursor"]) {
    const value = input[key];
    if (Array.isArray(value)) return null;
    if (value !== undefined) selected.set(key, value);
  }
  const source = input.source ?? "transactions";
  if (source !== "transactions" && source !== "activity") return null;
  const query = parseResourceQuery(source, selected),
    window = parseActivityWindow(selected);
  if (!query || !window) return null;
  return { window, source, ...(query.cursor ? { cursor: query.cursor } : {}) };
}
