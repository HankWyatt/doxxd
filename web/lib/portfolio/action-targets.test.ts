import { describe, expect, it } from "vitest";
import { toProtocolView } from "./model";
import { validResourcePayload } from "../dmnd/validation.server";
import type { Schemas } from "../dmnd/contracts";
import {
  DAMM,
  dammV2Page,
} from "../../tests/fixtures/synthetic-meteora-damm-v2";
import {
  AMM_V4,
  CLMM,
  CPMM,
  ammV4Page,
  clmmPage,
  cpmmPage,
} from "../../tests/fixtures/synthetic-raydium-positions";

const CP_AMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

const dammView = (mutate?: (row: Schemas["WalletMeteoraDammV2Position"]) => void) => {
  const data = dammV2Page();
  data.data[0].program = CP_AMM;
  mutate?.(data.data[0]);
  expect(validResourcePayload("meteora-damm-v2", data)).toBe(true);
  return toProtocolView({ resource: "meteora-damm-v2", data }).positions[0];
};

describe("DAMM v2 action target", () => {
  it("maps every field from the DMND row", () => {
    const row = dammView();
    expect(row.action).toEqual({
      protocol: "meteora-damm-v2",
      id: DAMM.position,
      pool: DAMM.pool,
      position: DAMM.position,
      positionMint: DAMM.positionMint,
      positionNftAccount: DAMM.ownerTokenAccount,
      nftTokenProgram: DAMM.tokenProgram,
      program: CP_AMM,
      liquidity: {
        unlocked: "1000",
        vested: "200",
        permanentLocked: "300",
        total: "1500",
      },
      feeAAtoms: "1500000000",
      feeBAtoms: "250000",
      rewards: [{ index: 0, mint: DAMM.reward, atoms: "7000000" }],
      tokenA: { mint: DAMM.tokenA, decimals: 9, symbol: "SYNA" },
      tokenB: { mint: DAMM.tokenB, decimals: 6, symbol: null },
      snapshotSlot: 410000002,
    });
    expect(row.action?.id).toBe(row.id);
  });

  it("gives no action to a row from a different program", () => {
    expect(dammView((r) => (r.program = DAMM.program)).action).toBeUndefined();
  });

  it("leaves the rest of the view unchanged", () => {
    const { action, ...rest } = dammView();
    expect(action).toBeDefined();
    expect(rest.label).toBe("SYNA / " + rest.assets[1].label);
    expect(rest).not.toHaveProperty("action");
  });
});

describe("CLMM action target", () => {
  const view = (mutate?: (row: Schemas["WalletLiquidityPosition"]) => void) => {
    const data = clmmPage();
    mutate?.(data.data[0]);
    expect(validResourcePayload("raydium-clmm", data)).toBe(true);
    return toProtocolView({ resource: "raydium-clmm", data }).positions[0];
  };

  it("maps every field from the DMND row", () => {
    const row = view();
    expect(row.action).toEqual({
      protocol: "raydium-clmm",
      id: CLMM.position,
      pool: CLMM.pool,
      position: CLMM.position,
      positionMint: CLMM.positionMint,
      positionNftAccount: CLMM.ownerTokenAccount,
      nftTokenProgram: CLMM.tokenProgram,
      program: CLMM.program,
      liquidity: "5000000",
      tickLower: -1200,
      tickUpper: 3600,
      feeOwedAAtoms: "1500000",
      feeOwedBAtoms: "250000",
      rewards: [{ mint: CLMM.reward, atoms: "7000000" }],
      tokenA: { mint: CLMM.tokenA, decimals: 9, symbol: "SYNA" },
      tokenB: { mint: CLMM.tokenB, decimals: 6, symbol: null },
      snapshotSlot: 420000002,
    });
    expect(row.action?.id).toBe(row.id);
  });

  it("drops a reward row without a mint", () => {
    const row = view((r) => r.rewards.push({ mint: null, owed_atoms: "1" }));
    expect(row.action).toMatchObject({
      rewards: [{ mint: CLMM.reward, atoms: "7000000" }],
    });
  });

  it("gives no action to a row with the wrong program", () => {
    expect(view((r) => (r.program = DAMM.program)).action).toBeUndefined();
  });

  it("gives Orca rows no action, even with the CLMM program", () => {
    const data = clmmPage();
    const row = toProtocolView({ resource: "orca", data }).positions[0];
    expect(row.action).toBeUndefined();
    expect(row).not.toHaveProperty("action");
  });

  it("keeps the rest of the view identical to Orca's", () => {
    const orca = toProtocolView({ resource: "orca", data: clmmPage() }).positions[0];
    const { action, ...rest } = view();
    expect(action).toBeDefined();
    expect(rest).toEqual(orca);
  });
});

describe("fungible action target", () => {
  it("maps a CPMM row", () => {
    const data = cpmmPage();
    expect(validResourcePayload("raydium-cpmm", data)).toBe(true);
    const row = toProtocolView({ resource: "raydium-cpmm", data }).positions[0];
    expect(row.action).toEqual({
      protocol: "raydium-cpmm",
      id: CPMM.ownerTokenAccount,
      pool: CPMM.pool,
      lpMint: CPMM.lpMint,
      lpAccount: CPMM.ownerTokenAccount,
      lpAtoms: "4000000",
      lpDecimals: 6,
      withdrawalAvailable: true,
      legs: [
        { mint: CPMM.tokenA, decimals: 9, symbol: null },
        { mint: CPMM.tokenB, decimals: 6, symbol: null },
      ],
      snapshotSlot: 430000001,
    });
    expect(row.action?.id).toBe(row.id);
  });

  it("maps an AMM v4 row with unknown withdrawal availability and no pool", () => {
    const data = ammV4Page();
    data.data[0].withdrawal_available = null;
    data.data[0].pool = null;
    expect(validResourcePayload("raydium-amm-v4", data)).toBe(true);
    const row = toProtocolView({ resource: "raydium-amm-v4", data }).positions[0];
    expect(row.action).toMatchObject({
      protocol: "raydium-amm-v4",
      id: AMM_V4.ownerTokenAccount,
      pool: null,
      lpMint: AMM_V4.lpMint,
      withdrawalAvailable: null,
      snapshotSlot: 440000001,
    });
  });

  it("gives no action to a refused receipt", () => {
    const data = cpmmPage();
    data.data[0].status = "refused";
    expect(
      toProtocolView({ resource: "raydium-cpmm", data }).positions[0].action,
    ).toBeUndefined();
  });
});
