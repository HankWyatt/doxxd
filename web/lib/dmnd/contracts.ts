import type { components } from "./generated";
export type Schemas = components["schemas"];
export type ResourceData = {
  summary: Schemas["WalletPortfolioSummary"];
  overview: Schemas["WalletOverview"];
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
  "summary" | "overview" | "transactions" | "activity"
>;
export type ResourceQuery = {
  cursor?: string;
  limit?: number;
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
    | "rate_limited"
    | "timeout"
    | "upstream";
  retryAfterSeconds?: number;
  upstreamStatus?: 401 | 403;
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
export type WalletDataMode =
  | { kind: "live" }
  | { kind: "demo"; scenario: FixtureScenario };
export const LIVE_MODE: WalletDataMode = { kind: "live" };
