// Server-side switch for on-site LP actions. Everything stays off unless the
// server sets DOXXD_ACTIONS_ENABLED=1 and names an RPC provider in
// SOLANA_RPC_URL: the public endpoint (api.mainnet-beta.solana.com) answers
// 403 to every request that carries the CF-Worker header, which Workers add,
// so there is no usable default (ruling R-FW1). This file must not be
// "use client": pages and routes call it on the server.
export function actionsEnabledFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  return env.DOXXD_ACTIONS_ENABLED === "1" && (env.SOLANA_RPC_URL ?? "").trim() !== "";
}
