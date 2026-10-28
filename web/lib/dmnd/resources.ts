import type { ResourceName, ProtocolResource } from "./contracts";
export type ResourceDefinition = {
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
  stake: {
    path: "stake-accounts",
    label: "Native staking",
    field: "data",
    componentId: "native_stake",
  },
  "liquid-staking": {
    path: "liquid-staking",
    label: "Liquid staking",
    field: "positions",
    componentId: "liquid_staking_receipts",
  },
  kamino: {
    path: "defi-positions",
    protocol: "kamino_lend",
    label: "Kamino Lend",
    field: "data",
    componentId: "kamino_lend",
  },
  solend: {
    path: "solend-positions",
    label: "Solend",
    field: "data",
    componentId: "solend",
  },
  marginfi: {
    path: "marginfi-positions",
    label: "MarginFi",
    field: "data",
    componentId: "marginfi",
  },
  orca: {
    path: "liquidity-positions",
    protocol: "orca_whirlpools",
    label: "Orca Whirlpools",
    field: "data",
    componentId: "orca_whirlpools",
  },
  "raydium-clmm": {
    path: "liquidity-positions",
    protocol: "raydium_clmm",
    label: "Raydium CLMM",
    field: "data",
    componentId: "raydium_clmm",
  },
  meteora: {
    path: "meteora-dlmm-positions",
    label: "Meteora DLMM",
    field: "data",
    componentId: "meteora_dlmm",
  },
  "raydium-cpmm": {
    path: "fungible-liquidity-positions",
    protocol: "raydium_cpmm",
    label: "Raydium CPMM",
    field: "data",
    componentId: "raydium_cpmm",
  },
  "raydium-amm-v4": {
    path: "fungible-liquidity-positions",
    protocol: "raydium_amm_v4",
    label: "Raydium AMM v4",
    field: "data",
    componentId: "raydium_amm_v4",
  },
  "raydium-farms": {
    path: "farm-positions",
    label: "Raydium farms",
    field: "data",
    componentId: "raydium_farms",
  },
  drift: {
    path: "drift-positions",
    label: "Drift",
    field: "data",
    componentId: "drift",
  },
  velocity: {
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
    !["summary", "overview", "transactions", "activity"].includes(key),
);
export function isResource(value: string): value is ResourceName {
  return Object.hasOwn(resources, value);
}
