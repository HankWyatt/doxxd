import { pathToFileURL } from "node:url";
import { bodyJson } from "../lib/dmnd/read-json.mjs";

export const APPROVED_WALLETS = [
  "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa",
  "7ZcdCFE2eRM5VpNy2ETofVGizwPeXLWLDCceXt4NhqvF",
];
const RESOURCES = [
  "summary",
  "overview",
  "stake",
  "liquid-staking",
  "kamino",
  "solend",
  "marginfi",
  "orca",
  "raydium-clmm",
  "meteora",
  "raydium-cpmm",
  "raydium-amm-v4",
  "raydium-farms",
  "drift",
  "velocity",
  "transactions",
  "activity",
];
const UNPAGED = ["summary", "overview", "liquid-staking"];
function configuration(input) {
  const invalid = () => {
    throw new Error("Invalid acceptance configuration");
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "baseURL",
          "wallets",
          "resources",
          "maxRequests",
          "continuation",
          "from",
          "to",
        ].includes(key),
    )
  )
    invalid();
  let base;
  try {
    base = new URL(input.baseURL);
  } catch {
    invalid();
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    invalid();
  if (
    !Array.isArray(input.wallets) ||
    !input.wallets.length ||
    input.wallets.length > 2 ||
    new Set(input.wallets).size !== input.wallets.length ||
    input.wallets.some((wallet) => !APPROVED_WALLETS.includes(wallet))
  )
    invalid();
  const resources = input.resources ?? [
    "overview",
    "summary",
    "transactions",
    "activity",
  ];
  if (
    !Array.isArray(resources) ||
    !resources.length ||
    new Set(resources).size !== resources.length ||
    resources.some((resource) => !RESOURCES.includes(resource))
  )
    invalid();
  const maxRequests = input.maxRequests ?? 12;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 34)
    invalid();
  if (
    input.continuation !== undefined &&
    typeof input.continuation !== "boolean"
  )
    invalid();
  for (const key of ["from", "to"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(
          input[key],
        ) ||
        !Number.isFinite(Date.parse(input[key])))
    )
      invalid();
  if (input.from && input.to && Date.parse(input.from) >= Date.parse(input.to))
    invalid();
  return { ...input, baseURL: base.origin, resources, maxRequests };
}
function safeCoverage(source) {
  if (!source || typeof source !== "object") return {};
  const result = {};
  for (const key of [
    "complete",
    "fresh",
    "complete_since_slot",
    "native_sol_complete_since_slot",
  ])
    if (typeof source[key] === "boolean") result[key] = source[key];
  for (const key of [
    "snapshot_slot",
    "inventory_slot",
    "token_snapshot_slot",
    "native_sol_slot",
    "wrapped_sol_slot",
    "live_slot",
    "balance_live_slot",
    "since_slot",
    "native_sol_since_slot",
  ])
    if (
      source[key] === null ||
      (Number.isSafeInteger(source[key]) && source[key] >= 0)
    )
      result[key] = source[key];
  for (const key of ["status", "snapshot_status"])
    if (
      [
        "queued",
        "pending",
        "running",
        "complete",
        "partial",
        "stale",
        "failed",
        "unknown",
        "unavailable",
        "not_requested",
        "disabled",
        "budget_wait",
        "too_large",
        "done",
      ].includes(source[key])
    )
      result[key] = source[key];
  if (
    [
      "token_accounts_complete",
      "snapshot_changed_during_read",
      "wallet_snapshot_not_available",
      "balance_stream_not_ready",
      "snapshot_queue_full",
      "snapshot_queued",
      "snapshot_running",
      "snapshot_budget_wait",
      "snapshot_failed",
      "snapshot_too_large",
      "snapshot_outside_balance_window",
      "snapshot_not_queued",
    ].includes(source.reason)
  )
    result.reason = source.reason;
  return result;
}
/** Calls the local Doxxd proxy only. Credentials never enter this runner. */
/** @param {any} input @param {(input:string, init:RequestInit)=>Promise<Response>} [network] */
export async function runAcceptance(input, network = fetch) {
  const config = configuration(input);
  /** @type {Array<Record<string, any>>} */
  const results = [];
  const report = {
    requests: 0,
    maxRequests: config.maxRequests,
    results,
    exhausted: false,
  };
  let followed = false;
  for (const wallet of config.wallets)
    for (const resource of config.resources) {
      let cursor;
      for (let page = 0; page < 2; page++) {
        if (report.requests >= config.maxRequests) {
          report.exhausted = true;
          return report;
        }
        const url = new URL(
          "/api/wallet/" + wallet + "/" + resource,
          config.baseURL,
        );
        if (!UNPAGED.includes(resource)) url.searchParams.set("limit", "10");
        if (["transactions", "activity"].includes(resource)) {
          if (config.from) url.searchParams.set("from", config.from);
          if (config.to) url.searchParams.set("to", config.to);
        }
        if (cursor) url.searchParams.set("cursor", cursor);
        const row = {
          wallet,
          resource,
          page: cursor ? "continuation" : "seed",
          ok: false,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        report.requests++;
        let next;
        try {
          const response = await network(url.toString(), {
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal,
          });
          row.status = response.status;
          const body = await bodyJson(response);
          if (
            response.ok &&
            body?.ok === true &&
            body.data?.wallet === wallet
          ) {
            const data = body.data;
            const entries =
              resource === "overview"
                ? data.assets
                : resource === "summary"
                  ? data.components
                  : resource === "liquid-staking"
                    ? data.positions
                    : data.data;
            if (!Array.isArray(entries)) throw new Error("invalid_response");
            row.ok = true;
            row.observations = entries.length;
            row.coverage = safeCoverage(data.coverage);
            if (resource === "overview") {
              for (const [field, label] of [
                ["native_sol_lamports", "nativeSolLamports"],
                ["wrapped_sol_lamports", "wrappedSolLamports"],
              ])
                if (
                  data[field] === null ||
                  (typeof data[field] === "string" && /^\d+$/.test(data[field]))
                )
                  row[label] = data[field];
            }
            if (typeof data.whole_wallet_complete === "boolean")
              row.wholeWalletComplete = data.whole_wallet_complete;
            if (Number.isSafeInteger(data.unpriced_asset_count))
              row.unpricedAssetCount = data.unpriced_asset_count;
            if (
              data.known_component_net_value_usd === null ||
              (typeof data.known_component_net_value_usd === "string" &&
                /^-?\d+(?:\.\d+)?$/.test(data.known_component_net_value_usd))
            )
              row.knownNetValueUsd = data.known_component_net_value_usd;
            row.hasMore = data.has_more === true;
            if (
              row.hasMore &&
              typeof data.cursor === "string" &&
              data.cursor.length &&
              data.cursor.length <= 8192
            )
              next = data.cursor;
          } else {
            row.error = [
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
            ].includes(body?.kind)
              ? body.kind
              : "http_error";
          }
        } catch (error) {
          row.error = controller.signal.aborted
            ? "timeout"
            : ["response_too_large", "invalid_response"].includes(
                  error?.message,
                )
              ? error.message
              : "request_failed";
        } finally {
          clearTimeout(timer);
        }
        report.results.push(row);
        if (!config.continuation || followed || !next) break;
        cursor = next;
        followed = true;
      }
    }
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 16384)
        throw new Error("Invalid acceptance configuration");
    }
    const report = await runAcceptance(JSON.parse(text));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch {
    process.stderr.write(
      "Acceptance configuration or runtime failed. No credentials are accepted on this command.\n",
    );
    process.exitCode = 1;
  }
}
