import { describe, expect, it } from "vitest";
import type { Schemas } from "../dmnd/contracts";
import { dammV2Rows, liquidityRows, meteoraRows } from "./adapters/liquidity";
import { toProtocolView } from "./model";

const feeLeg = (symbol: string, ui: string, value: string | null, source: string | null = "dmnd_pool_trade_sol") => ({
  mint: "Mint" + symbol,
  symbol,
  decimals: 6,
  amount_atoms: "1",
  ui_amount: ui,
  value_usd: value,
  price_source: source,
});
const principal = (symbol: string) => ({ ...feeLeg(symbol, "2", "10"), price_source: "dmnd_sol_reference" });

const clmm = (extra: Record<string, unknown> = {}) =>
  ({
    data: [
      {
        position: "Pos",
        pool: "Pool",
        principal_a: principal("SYNA"),
        principal_b: principal("SYNB"),
        fee_owed_a: "1500000",
        fee_owed_b: "0",
        rewards: [],
        ...extra,
      },
    ],
  }) as unknown as Schemas["WalletLiquidityPositions"];

describe("claimable fee values", () => {
  it("takes the row's claimable USD from DMND and leaves an unvalued row unknown, never $0", () => {
    const valued = liquidityRows(clmm({ claimable_basis: "accrued", claimable_value_usd: "12.5" }))[0];
    expect(valued.claimable?.valueUsd).toBe("12.5");
    // DMND reports 0 when nothing is valued: that is unknown here.
    expect(liquidityRows(clmm({ claimable_value_usd: "0" }))[0].claimable?.valueUsd).toBeNull();
    expect(liquidityRows(clmm())[0].claimable?.valueUsd).toBeNull();
  });

  it("lists the fee legs with DMND's amounts and USD values", () => {
    const row = liquidityRows(
      clmm({ claimable_basis: "accrued", fee_a: feeLeg("SYNA", "1.5", "7"), fee_b: feeLeg("SYNB", "0", null) }),
    )[0];
    expect(row.fees?.map((f) => [f.label, f.amount, f.valueUsd ?? null])).toEqual([
      ["SYNA", "1.5", "7"],
      ["SYNB", "0", null],
    ]);
  });

  it("lists no fee amounts when DMND sends no fee legs", () => {
    const row = liquidityRows(clmm({ claimable_basis: "accrued" }))[0];
    expect(row.fees).toEqual([]);
    // The raw owed counters stay in the details.
    expect(row.details).toContainEqual({ label: "Owed fee counters (raw atoms)", value: "1500000 / 0" });
  });

  it("words settled fees as a lower bound and accrued fees plainly", () => {
    const lower = (basis?: string | null) =>
      liquidityRows(clmm({ claimable_basis: basis, fee_a: feeLeg("SYNA", "1", "1"), fee_b: feeLeg("SYNB", "0", null) }))[0].fees?.map(
        (f) => f.lowerBound === true,
      );
    expect(lower("settled")).toEqual([true, true]);
    // No basis from DMND: stay conservative.
    expect(lower(undefined)).toEqual([true, true]);
    expect(lower("accrued")).toEqual([false, false]);
    expect(liquidityRows(clmm({ claimable_basis: "accrued", claimable_at: "2026-10-01T00:00:00Z" }))[0].claimable).toMatchObject({
      basis: "accrued",
      at: "2026-10-01T00:00:00Z",
    });
  });

  it("qualifies reward counters by basis, not as always settled", () => {
    const rewards = [{ mint: "MintR", symbol: "SYNR", owed_atoms: "5" }];
    const qualifier = (basis: string) => liquidityRows(clmm({ claimable_basis: basis, rewards }))[0].rewards[0].qualifier;
    expect(qualifier("settled")).toMatch(/lower bound/);
    expect(qualifier("settled")).not.toMatch(/pending/);
    expect(qualifier("accrued")).not.toMatch(/lower bound|settled/);
  });

  it("marks pool-implied fee values as an estimate", () => {
    const row = liquidityRows(
      clmm({
        claimable_value_usd: "7",
        fee_a: feeLeg("SYNA", "1.5", "7", "dmnd_pool_implied"),
        fee_b: feeLeg("SYNB", "0", null, null),
      }),
    )[0];
    expect(row.fees?.map((f) => f.estimated === true)).toEqual([true, false]);
    expect(row.claimable?.estimated).toBe(true);
    expect(liquidityRows(clmm({ claimable_value_usd: "7", fee_a: feeLeg("SYNA", "1", "7") }))[0].claimable?.estimated).toBe(false);
  });

  it("marks pool-implied principal legs as an estimate", () => {
    const row = liquidityRows(
      clmm({ principal_a: { ...principal("SYNA"), price_source: "dmnd_pool_implied" } }),
    )[0];
    expect(row.assets.map((a) => a.estimated === true)).toEqual([true, false]);
  });

  it("covers DLMM fees by their own basis", () => {
    const raw = (extra: Record<string, unknown>) =>
      ({
        data: [
          {
            pair: "Pair",
            position: "Pos",
            principal_x: principal("SYNX"),
            principal_y: principal("SYNY"),
            fee_pending_x_atoms: "2000000",
            fee_pending_y_atoms: "0",
            rewards: [],
            fee_x: feeLeg("SYNX", "2", "3"),
            claimable_value_usd: "3",
            ...extra,
          },
        ],
      }) as unknown as Schemas["WalletMeteoraPositions"];
    const settled = meteoraRows(raw({ claimable_basis: "settled" }))[0];
    expect(settled.fees?.[0]).toMatchObject({ amount: "2", valueUsd: "3", lowerBound: true });
    expect(settled.claimable?.valueUsd).toBe("3");
    expect(meteoraRows(raw({ claimable_basis: "accrued" }))[0].fees?.[0].lowerBound).toBe(false);
  });

  it("treats DAMM v2 claimables as accrued, with DMND's values", () => {
    const raw = {
      data: [
        {
          position: "Pos",
          pool: "Pool",
          program: "Other",
          token_a: principal("SYNA"),
          token_b: principal("SYNB"),
          liquidity: { unlocked: "1", vested: "0", permanent_locked: "0", total: "1" },
          collect_fee_mode: "both_token",
          fee_a_claimable_atoms: "1500000",
          fee_b_claimable_atoms: "0",
          fee_a: feeLeg("SYNA", "1.5", "9"),
          claimable_value_usd: "9",
          rewards: [],
        },
      ],
    } as unknown as Schemas["WalletMeteoraDammV2Positions"];
    const row = dammV2Rows(raw)[0];
    expect(row.claimable).toMatchObject({ valueUsd: "9", basis: "accrued" });
    expect(row.fees?.[0]).toMatchObject({ amount: "1.5", valueUsd: "9" });
    expect(row.fees?.[0].lowerBound).toBeFalsy();
  });

  it("exposes the page's known claimable total only when positive", () => {
    const view = (value?: string | null) =>
      toProtocolView({
        resource: "orca",
        data: {
          ...clmm(),
          page_known_claimable_value_usd: value,
          cursor: null,
          has_more: false,
          coverage: { complete: true, reason: "ok", status: "complete", fresh: true, scope: "s" },
        } as unknown as Schemas["WalletLiquidityPositions"],
      });
    expect(view("42.5").pageClaimableUsd).toBe("42.5");
    expect(view("0").pageClaimableUsd).toBeNull();
    expect(view(null).pageClaimableUsd).toBeNull();
    expect(view().pageClaimableUsd).toBeNull();
  });
});
