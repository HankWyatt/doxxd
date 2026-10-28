import { createHash } from "node:crypto";
import bs58 from "bs58";
import type { Schemas } from "@/lib/dmnd/contracts";

// Every address, amount, slot and time here is invented. Addresses are the
// base58 encoding of sha256("doxxd-synthetic:" + label); none is a real account.
export const syntheticAddress = (label: string) =>
  bs58.encode(
    createHash("sha256").update("doxxd-synthetic:" + label).digest(),
  );

export const DAMM = {
  wallet: syntheticAddress("damm-v2/wallet"),
  position: syntheticAddress("damm-v2/position-1"),
  positionMint: syntheticAddress("damm-v2/position-mint-1"),
  pool: syntheticAddress("damm-v2/pool-1"),
  tokenA: syntheticAddress("damm-v2/token-a"),
  tokenB: syntheticAddress("damm-v2/token-b"),
  reward: syntheticAddress("damm-v2/reward"),
  program: syntheticAddress("damm-v2/program"),
  tokenProgram: syntheticAddress("damm-v2/token-program"),
  ownerTokenAccount: syntheticAddress("damm-v2/owner-token-account"),
};

export function dammV2Position(): Schemas["WalletMeteoraDammV2Position"] {
  return {
    position_mint: DAMM.positionMint,
    position: DAMM.position,
    pool: DAMM.pool,
    program: DAMM.program,
    token_program: DAMM.tokenProgram,
    owner_token_account: DAMM.ownerTokenAccount,
    collect_fee_mode: "both_token",
    token_a: {
      mint: DAMM.tokenA,
      symbol: "SYNA",
      decimals: 9,
      amount_atoms: "2500000000",
      ui_amount: "2.5",
      price_usd: "16",
      price_source: "synthetic",
      price_updated_at: "2026-09-14T12:00:00Z",
      value_usd: "40",
      amount_reason: null,
      value_reason: null,
    },
    token_b: {
      mint: DAMM.tokenB,
      symbol: null,
      decimals: 6,
      amount_atoms: "1234500000",
      ui_amount: null,
      price_usd: null,
      price_source: null,
      price_updated_at: null,
      value_usd: null,
      amount_reason: null,
      value_reason: "no_price",
    },
    liquidity: {
      unlocked: "1000",
      vested: "200",
      permanent_locked: "300",
      total: "1500",
    },
    fee_a_claimable_atoms: "1500000000",
    fee_b_claimable_atoms: "250000",
    rewards: [
      {
        index: 0,
        mint: DAMM.reward,
        decimals: 6,
        claimable_atoms: "7000000",
      },
    ],
    sqrt_price: "18446744073709551616",
    pool_price: "0.5",
    principal_value_usd: null,
    owner_token_slot: 410000003,
    position_slot: 410000002,
    pool_slot: 410000001,
    snapshot_slot: 410000004,
    snapshot_block_time: "2026-09-14T11:59:30Z",
  };
}

export function dammV2Page(): Schemas["WalletMeteoraDammV2Positions"] {
  return {
    wallet: DAMM.wallet,
    protocol: "meteora_damm_v2",
    data: [dammV2Position()],
    cursor: null,
    has_more: false,
    page_known_principal_value_usd: "40",
    page_unpriced_leg_count: 1,
    coverage: {
      complete: true,
      fresh: true,
      status: "complete",
      reason: "meteora_damm_v2_complete",
      requested_at: "2026-09-14T11:58:00Z",
      fetched_at: "2026-09-14T11:59:45Z",
      snapshot_slot: 410000004,
      total_positions: 1,
      scope: "meteora_damm_v2_nft_position_v1_mainnet",
    },
  };
}

/** Coverage the endpoint reports for each lifecycle state, as DMND builds it. */
export function dammV2State(
  state: "pending" | "empty" | "complete" | "partial" | "disabled" | "stale",
): Schemas["WalletMeteoraDammV2Positions"] {
  const page = dammV2Page();
  const c = page.coverage;
  if (state === "pending") {
    page.data = [];
    delete page.page_known_principal_value_usd;
    delete page.page_unpriced_leg_count;
    Object.assign(c, {
      complete: false,
      fresh: false,
      status: "queued",
      reason: "meteora_damm_v2_scan_queued",
      fetched_at: null,
      snapshot_slot: null,
      total_positions: 0,
    });
  } else if (state === "empty") {
    page.data = [];
    page.page_known_principal_value_usd = "0";
    page.page_unpriced_leg_count = 0;
    c.total_positions = 0;
  } else if (state === "partial") {
    page.has_more = true;
    page.cursor = "synthetic-damm-v2-cursor-2";
    c.total_positions = 2;
  } else if (state === "disabled") {
    page.data = [];
    delete page.page_known_principal_value_usd;
    delete page.page_unpriced_leg_count;
    Object.assign(c, {
      complete: false,
      fresh: false,
      status: "disabled",
      reason: "meteora_damm_v2_scan_disabled",
      requested_at: null,
      fetched_at: null,
      snapshot_slot: null,
      total_positions: 0,
    });
  } else if (state === "stale") {
    Object.assign(c, {
      complete: false,
      fresh: false,
      reason: "meteora_damm_v2_scan_stale",
    });
  }
  return page;
}
