import type { Schemas } from "@/lib/dmnd/contracts";
import { syntheticAddress } from "./synthetic-meteora-damm-v2";

// Every address, amount and slot here is invented (see the DAMM v2 fixture for
// how addresses are derived). Only the program IDs are the real public ones.
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const CLMM = {
  wallet: syntheticAddress("clmm/wallet"),
  position: syntheticAddress("clmm/position-1"),
  positionMint: syntheticAddress("clmm/position-mint-1"),
  pool: syntheticAddress("clmm/pool-1"),
  tokenA: syntheticAddress("clmm/token-a"),
  tokenB: syntheticAddress("clmm/token-b"),
  reward: syntheticAddress("clmm/reward"),
  ownerTokenAccount: syntheticAddress("clmm/owner-token-account"),
  program: CLMM_PROGRAM,
  tokenProgram: TOKEN_PROGRAM,
};

export const CPMM = {
  wallet: syntheticAddress("cpmm/wallet"),
  lpMint: syntheticAddress("cpmm/lp-mint"),
  pool: syntheticAddress("cpmm/pool-1"),
  tokenA: syntheticAddress("cpmm/token-a"),
  tokenB: syntheticAddress("cpmm/token-b"),
  ownerTokenAccount: syntheticAddress("cpmm/owner-token-account"),
};

export const AMM_V4 = {
  wallet: syntheticAddress("amm-v4/wallet"),
  lpMint: syntheticAddress("amm-v4/lp-mint"),
  pool: syntheticAddress("amm-v4/pool-1"),
  tokenA: syntheticAddress("amm-v4/token-a"),
  tokenB: syntheticAddress("amm-v4/token-b"),
  ownerTokenAccount: syntheticAddress("amm-v4/owner-token-account"),
};

const clmmLeg = (
  mint: string,
  symbol: string | null,
  decimals: number,
  atoms: string,
): Schemas["WalletLiquidityLeg"] => ({
  mint,
  symbol,
  decimals,
  amount_atoms: atoms,
  ui_amount: null,
  price_usd: null,
  price_source: null,
  price_updated_at: null,
  value_usd: null,
  amount_reason: null,
  value_reason: "price_unavailable",
});

export function clmmPosition(): Schemas["WalletLiquidityPosition"] {
  return {
    deployment: "synthetic",
    program: CLMM.program,
    token_program: CLMM.tokenProgram,
    pool: CLMM.pool,
    position: CLMM.position,
    position_mint: CLMM.positionMint,
    owner_token_account: CLMM.ownerTokenAccount,
    liquidity: "5000000",
    tick_lower: -1200,
    tick_upper: 3600,
    fee_owed_a: "1500000",
    fee_owed_b: "250000",
    rewards: [{ mint: CLMM.reward, owed_atoms: "7000000" }],
    principal_a: clmmLeg(CLMM.tokenA, "SYNA", 9, "2500000000"),
    principal_b: clmmLeg(CLMM.tokenB, null, 6, "1234500000"),
    owner_token_slot: 420000003,
    position_slot: 420000002,
    pool_slot: 420000001,
    snapshot_slot: 420000004,
  };
}

export function clmmPage(): Schemas["WalletLiquidityPositions"] {
  return {
    wallet: CLMM.wallet,
    protocol: "raydium_clmm",
    data: [clmmPosition()],
    cursor: null,
    has_more: false,
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 2,
    coverage: {
      complete: true,
      fresh: true,
      status: "complete",
      reason: "raydium_clmm_complete",
      requested_at: "2026-09-14T11:58:00Z",
      fetched_at: "2026-09-14T11:59:45Z",
      snapshot_slot: 420000004,
      total_positions: 1,
      scope: "raydium_clmm_synthetic",
    },
  };
}

const fungibleLeg = (
  mint: string,
  decimals: number,
  atoms: string,
): Schemas["WalletFungibleLiquidityLeg"] => ({
  mint,
  decimals,
  gross_atoms: atoms,
  net_atoms: atoms,
  transfer_fee_atoms: "0",
  available_vault_atoms: atoms,
  ui_amount: "0",
  price_usd: null,
  price_source: null,
  price_updated_at: null,
  value_usd: null,
  value_reason: "price_unavailable",
});

function fungiblePage(
  kind: "cpmm" | "amm-v4",
  addrs: typeof CPMM,
  slot: number,
): Schemas["WalletFungibleLiquidityPositions"] {
  return {
    wallet: addrs.wallet,
    protocol: "raydium_" + kind.replace("-", "_"),
    data: [
      {
        lp_mint: addrs.lpMint,
        owner_token_account: addrs.ownerTokenAccount,
        lp_atoms: "4000000",
        lp_decimals: 6,
        pool: addrs.pool,
        principal: [
          fungibleLeg(addrs.tokenA, 9, "1500000000"),
          fungibleLeg(addrs.tokenB, 6, "750000"),
        ],
        sources: [],
        status: "observed",
        withdrawal_available: true,
        context_slot: slot,
      },
    ],
    cursor: null,
    has_more: false,
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 2,
    coverage: {
      complete: true,
      fresh: true,
      status: "complete",
      reason: "synthetic",
      refused_candidates: 0,
      total_candidates: 1,
      unsupported_scopes: [],
      scope: "raydium_" + kind.replace("-", "_") + "_synthetic",
    },
  };
}

export const cpmmPage = () => fungiblePage("cpmm", CPMM, 430000001);
export const ammV4Page = () => fungiblePage("amm-v4", AMM_V4, 440000001);
