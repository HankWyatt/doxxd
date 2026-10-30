import { expect, it } from "vitest";
import type { Schemas } from "../dmnd/contracts";
import { fungibleRows, liquidityRows, meteoraRows } from "./adapters/liquidity";

const leg = (symbol: string, value: string | null, price_source = "dmnd_pool_trade_sol") => ({
  mint: "Mint" + symbol,
  symbol,
  ui_amount: "2",
  value_usd: value,
  price_source,
});
const [A, B] = [leg("SYNA", "10.5", "dmnd_sol_reference"), leg("SYNB", "20.25")];
const noValueB = leg("SYNB", null);

it("shows the CPMM/AMM receipt value DMND sets, and keeps unknown unknown", () => {
  const rows = (principal_value_usd?: string | null, legB = B) =>
    fungibleRows({
      data: [
        { owner_token_account: "Tok", pool: "Pool", principal: [A, legB], principal_value_usd, sources: [] },
      ],
    } as unknown as Schemas["WalletFungibleLiquidityPositions"])[0];
  const row = rows("30.75");
  expect(row.valueUsd).toBe("30.75");
  expect(row.assets.map((a) => a.valueUsd)).toEqual(["10.5", "20.25"]);
  expect(rows(undefined, noValueB).valueUsd).toBeNull();
  expect(rows(null, noValueB).assets.map((a) => a.valueUsd)).toEqual(["10.5", null]);
});

it("shows the Orca / Raydium CLMM principal value DMND sets", () => {
  const rows = (principal_value_usd?: string | null) =>
    liquidityRows({
      data: [
        { position: "Pos", pool: "Pool", principal_a: A, principal_b: B, principal_value_usd, rewards: [] },
      ],
    } as unknown as Schemas["WalletLiquidityPositions"]);
  expect(rows("30.75")[0].valueUsd).toBe("30.75");
  expect(rows("30.75")[0].assets.map((a) => a.valueUsd)).toEqual(["10.5", "20.25"]);
  expect(rows()[0].valueUsd).toBeNull();
});

it("shows the DLMM principal value DMND sets", () => {
  const rows = (principal_value_usd?: string | null) =>
    meteoraRows({
      data: [
        { pair: "Pair", position: "Pos", principal_x: A, principal_y: B, principal_value_usd, rewards: [] },
      ],
    } as unknown as Schemas["WalletMeteoraPositions"]);
  expect(rows("30.75")[0].valueUsd).toBe("30.75");
  expect(rows("30.75")[0].assets.map((a) => a.valueUsd)).toEqual(["10.5", "20.25"]);
  expect(rows()[0].valueUsd).toBeNull();
});
