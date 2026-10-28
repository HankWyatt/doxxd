import generated from "./validation.generated.json";
import type { ResourceName, Schemas } from "./contracts";
import { validTimestamp } from "./query";

const schemaNames = {
  summary: "WalletPortfolioSummary",
  overview: "WalletOverview",
  stake: "WalletStakeAccounts",
  "liquid-staking": "WalletLiquidStaking",
  kamino: "WalletDefiPositions",
  solend: "WalletSolendPositions",
  marginfi: "WalletMarginfiPositions",
  orca: "WalletLiquidityPositions",
  "raydium-clmm": "WalletLiquidityPositions",
  meteora: "WalletMeteoraPositions",
  "meteora-damm-v2": "WalletMeteoraDammV2Positions",
  "raydium-cpmm": "WalletFungibleLiquidityPositions",
  "raydium-amm-v4": "WalletFungibleLiquidityPositions",
  "raydium-farms": "WalletFarmPositions",
  drift: "WalletDriftPositions",
  velocity: "WalletVelocityPositions",
  transactions: "WalletTransactions",
  activity: "WalletActivity",
} as const satisfies Record<ResourceName, keyof Schemas>;
type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  allOf?: Schema[];
  minimum?: number;
  format?: string;
  additionalProperties?: boolean | Schema;
};
const schemas: Record<string, Schema> = generated;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Static OpenAPI structural validation: no runtime compilation or eval. */
function matches(schema: Schema, value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (schema.$ref) {
    const target = schemas[schema.$ref.slice("#/components/schemas/".length)];
    if (!target || !matches(target, value, depth + 1)) return false;
  }
  if (
    schema.oneOf &&
    schema.oneOf.filter((child) => matches(child, value, depth + 1)).length !==
      1
  )
    return false;
  if (
    schema.allOf &&
    !schema.allOf.every((child) => matches(child, value, depth + 1))
  )
    return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      !types.some((type) =>
        type === "null"
          ? value === null
          : type === "object"
            ? object(value)
            : type === "array"
              ? Array.isArray(value)
              : type === "integer"
                ? Number.isSafeInteger(value)
                : type === "number"
                  ? typeof value === "number" && Number.isFinite(value)
                  : typeof value === type,
      )
    )
      return false;
  }
  if (
    typeof value === "number" &&
    schema.minimum !== undefined &&
    value < schema.minimum
  )
    return false;
  if (typeof value === "string") {
    if (schema.format === "date-time" && !validTimestamp(value)) return false;
    if (
      schema.format === "decimal" &&
      !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
    )
      return false;
  }
  if (
    Array.isArray(value) &&
    schema.items &&
    !value.every((item) => matches(schema.items!, item, depth + 1))
  )
    return false;
  if (object(value)) {
    if (schema.required?.some((key) => !Object.hasOwn(value, key)))
      return false;
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(value, key) && !matches(child, value[key], depth + 1))
        return false;
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) continue;
      if (schema.additionalProperties === false) return false;
      if (
        object(schema.additionalProperties) &&
        !matches(schema.additionalProperties, value[key], depth + 1)
      )
        return false;
    }
  }
  return true;
}
export function validResourcePayload(
  resource: ResourceName,
  value: unknown,
): boolean {
  return matches(schemas[schemaNames[resource]], value);
}
