import type { components } from "./generated";
export type Schemas = components["schemas"];
export type ResourceData = {
  summary: Schemas["WalletPortfolioSummary"];
  overview: Schemas["WalletOverview"];
  positions: Schemas["WalletPositions"];
  stake: Schemas["WalletStakeAccounts"];
  "liquid-staking": Schemas["WalletLiquidStaking"];
  kamino: Schemas["WalletDefiPositions"];
  solend: Schemas["WalletSolendPositions"];
  marginfi: Schemas["WalletMarginfiPositions"];
  orca: Schemas["WalletLiquidityPositions"];
  "raydium-clmm": Schemas["WalletLiquidityPositions"];
  meteora: Schemas["WalletMeteoraPositions"];
  "meteora-damm-v2": Schemas["WalletMeteoraDammV2Positions"];
  "raydium-cpmm": Schemas["WalletFungibleLiquidityPositions"];
  "raydium-amm-v4": Schemas["WalletFungibleLiquidityPositions"];
  "raydium-farms": Schemas["WalletFarmPositions"];
  drift: Schemas["WalletDriftPositions"];
  velocity: Schemas["WalletVelocityPositions"];
  transactions: Schemas["WalletTransactions"];
  activity: Schemas["WalletActivity"];
};
export type ResourceName = keyof ResourceData;
export type ProtocolResource = Exclude<
  ResourceName,
  "summary" | "overview" | "positions" | "transactions" | "activity"
>;
export type ResourceQuery = {
  cursor?: string;
  limit?: number;
  sort?: Schemas["WalletPositionSort"];
  from?: string;
  to?: string;
};
export type ResourceError = {
  ok: false;
  kind:
    | "configuration"
    | "authentication"
    | "refused"
    | "invalid_input"
    | "unsupported"
    | "unavailable"
    // This deployment has not enabled the wallet or source: not an outage.
    | "not_enabled"
    | "rate_limited"
    | "timeout"
    | "upstream";
  retryAfterSeconds?: number;
  upstreamStatus?: 401 | 403;
  // "not_enabled" only: the whole wallet is not enabled here, not one source.
  scope?: "wallet";
};
export type ResourceResult<T> = { ok: true; data: T } | ResourceError;
export const fixtureScenarios = [
  "complete",
  "pending",
  "partial",
  "stale",
  "unpriced",
  "empty",
  "protocol-error",
  "activity-continuation",
  "truncated",
] as const;
export type FixtureScenario = (typeof fixtureScenarios)[number];
// Wallet pages read live data only. Synthetic fixtures are a test transport:
// tests intercept /api/wallet requests and no fixture route or mode ships.
export type WalletDataMode = { kind: "live" };
export const LIVE_MODE: WalletDataMode = { kind: "live" };
