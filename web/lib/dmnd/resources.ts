import type { ResourceName, ProtocolResource } from "./contracts";
export type ProtocolKind =
  | "lending"
  | "staking"
  | "liquidity"
  | "perps"
  | "yield";
export type ResourceDefinition = {
  kind?: ProtocolKind;
  path: string;
  label: string;
  field: "data" | "positions" | "assets" | "components";
  protocol?: string;
  componentId?: string;
};
export const resources: Record<ResourceName, ResourceDefinition> = {
  summary: {
    path: "portfolio-summary",
    label: "Portfolio",
    field: "components",
  },
  overview: {
    path: "overview",
    label: "Wallet",
    field: "assets",
    componentId: "tokens_native_sol",
  },
  positions: { path: "positions", label: "Trading", field: "data" },
  stake: {
    kind: "staking",
    path: "stake-accounts",
    label: "Native staking",
    field: "data",
    componentId: "native_stake",
  },
  "liquid-staking": {
    kind: "staking",
    path: "liquid-staking",
    label: "Liquid staking",
    field: "positions",
    componentId: "liquid_staking_receipts",
  },
  kamino: {
    kind: "lending",
    path: "defi-positions",
    protocol: "kamino_lend",
    label: "Kamino Lend",
    field: "data",
    componentId: "kamino_lend",
  },
  solend: {
    kind: "lending",
    path: "solend-positions",
    label: "Solend",
    field: "data",
    componentId: "solend",
  },
  marginfi: {
    kind: "lending",
    path: "marginfi-positions",
    label: "MarginFi",
    field: "data",
    componentId: "marginfi",
  },
  orca: {
    kind: "liquidity",
    path: "liquidity-positions",
    protocol: "orca_whirlpools",
    label: "Orca Whirlpools",
    field: "data",
    componentId: "orca_whirlpools",
  },
  "raydium-clmm": {
    kind: "liquidity",
    path: "liquidity-positions",
    protocol: "raydium_clmm",
    label: "Raydium CLMM",
    field: "data",
    componentId: "raydium_clmm",
  },
  meteora: {
    kind: "liquidity",
    path: "meteora-dlmm-positions",
    label: "Meteora DLMM",
    field: "data",
    componentId: "meteora_dlmm",
  },
  "meteora-damm-v2": {
    kind: "liquidity",
    path: "meteora-damm-v2-positions",
    label: "Meteora DAMM v2",
    field: "data",
    componentId: "meteora_damm_v2",
  },
  "raydium-cpmm": {
    kind: "liquidity",
    path: "fungible-liquidity-positions",
    protocol: "raydium_cpmm",
    label: "Raydium CPMM",
    field: "data",
    componentId: "raydium_cpmm",
  },
  "raydium-amm-v4": {
    kind: "liquidity",
    path: "fungible-liquidity-positions",
    protocol: "raydium_amm_v4",
    label: "Raydium AMM v4",
    field: "data",
    componentId: "raydium_amm_v4",
  },
  "raydium-farms": {
    kind: "yield",
    path: "farm-positions",
    label: "Raydium farms",
    field: "data",
    componentId: "raydium_farms",
  },
  drift: {
    kind: "perps",
    path: "drift-positions",
    label: "Drift",
    field: "data",
    componentId: "drift",
  },
  velocity: {
    kind: "perps",
    path: "velocity-positions",
    label: "Velocity",
    field: "data",
    componentId: "velocity",
  },
  transactions: { path: "transactions", label: "Transactions", field: "data" },
  activity: { path: "activity", label: "Balance activity", field: "data" },
};
export const protocolResources = (
  Object.keys(resources) as ResourceName[]
).filter(
  (key): key is ProtocolResource =>
    !["summary", "overview", "positions", "transactions", "activity"].includes(key),
);
export function isResource(value: string): value is ResourceName {
  return Object.hasOwn(resources, value);
}
