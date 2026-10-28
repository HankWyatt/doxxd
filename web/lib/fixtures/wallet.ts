import bs58 from "bs58";
import type {
  ResourceName,
  ResourceQuery,
  ResourceData,
  ResourceResult,
  FixtureScenario,
  Schemas,
} from "../dmnd/contracts";
import { protocolResources, resources } from "../dmnd/resources";
export const DEMO_ADDRESS = bs58.encode(new Uint8Array(32).fill(7));
export const MINTS = {
  sol: "So11111111111111111111111111111111111111112",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  jito: bs58.encode(new Uint8Array(32).fill(8)),
  jup: bs58.encode(new Uint8Array(32).fill(9)),
  bonk: bs58.encode(new Uint8Array(32).fill(10)),
  wif: bs58.encode(new Uint8Array(32).fill(11)),
};
const wallet = DEMO_ADDRESS,
  at = "2026-10-22T18:30:00Z",
  slot = 300000000;
const coverage = {
  complete: true,
  fresh: true,
  status: "complete",
  reason: "demo_complete_scope",
  requested_at: at,
  fetched_at: at,
  snapshot_slot: slot,
  scope: "demonstration current inventory",
};
const holdingsCoverage = {
  complete: true,
  reason: "snapshot_complete",
  snapshot_status: "complete",
  balance_stream_since_slot: slot - 1000,
  balance_live_slot: slot,
  token_snapshot_slot: slot,
  native_sol_lamports: "20000000000",
  native_sol_slot: slot,
  wrapped_sol_lamports: "0",
  wrapped_sol_slot: slot,
};
function asset(
  mint: string,
  symbol: string,
  name: string,
  amount: string,
  decimals: number,
  ui_amount: string,
  price_usd: string,
  value_usd: string,
): Schemas["WalletAsset"] {
  return {
    mint,
    symbol,
    name,
    amount,
    decimals,
    ui_amount,
    price_usd,
    value_usd,
    account_count: 1,
    last_slot: slot,
    image_url: null,
    price_updated_at: at,
    observed_price_usd: null,
    observed_price_at: null,
    estimated_value_usd: null,
    volume_24h_usd: null,
    price_change_24h: null,
  };
}
const loanLeg = (amount: string): Schemas["WalletDefiLeg"] => ({
  reserve: wallet,
  mint: MINTS.usdc,
  mint_decimals: 6,
  collateral_atoms: null,
  borrowed_amount_sf: null,
  underlying_atoms: amount + "000000",
  ui_amount: amount,
  amount_status: "observed",
  amount_reason: null,
  price_usd: "1",
  price_source: "demo",
  value_usd: amount,
  price_updated_at: at,
  reserve_snapshot_slot: slot,
  reserve_update_slot: slot,
  reserve_update_stale: false,
  market_value_sf: null,
});
const principal = (
  mint: string,
  decimals: number,
  atoms: string,
  amount: string,
  price: string,
  value: string,
): Schemas["WalletLiquidityLeg"] => ({
  mint,
  decimals,
  amount_atoms: atoms,
  ui_amount: amount,
  price_usd: price,
  price_source: "demo",
  price_updated_at: at,
  value_usd: value,
  amount_reason: null,
  value_reason: null,
});
const activityCoverage: Schemas["WalletActivityCoverage"] = {
  since_slot: slot - 1000,
  native_sol_since_slot: slot - 1000,
  live_slot: slot,
  first_unindexed_slot: null,
  complete_since_slot: true,
  reason: "demo_capture_window",
  native_sol_complete_since_slot: true,
  native_sol_reason: "demo_capture_window",
};
const change = (
  mint: string | null,
  amount: string,
  index: number,
): Schemas["WalletActivityEntry"] => ({
  kind: mint ? "token_balance_change" : "native_sol_balance_change",
  signature: bs58.encode(new Uint8Array(64).fill(index + 1)),
  slot: slot - index,
  transaction_index: index,
  block_time: at,
  mint,
  delta: amount,
  decimals: mint ? 6 : 9,
  ui_amount: mint ? "250" : "-0.002",
});
const transactions: Schemas["WalletTransaction"][] = [
  {
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    slot,
    transaction_index: 0,
    block_time: at,
    fee: { payer: wallet, lamports: "5000", succeeded: true },
    change_count: 2,
    changes_truncated: false,
    changes: [change(MINTS.usdc, "250000000", 0), change(null, "-2000000", 0)],
    trade_count: 1,
    trades_truncated: false,
    observed_trades: [
      {
        signature: bs58.encode(new Uint8Array(64).fill(1)),
        slot,
        transaction_index: 0,
        instruction_index: 1,
        pool_address: wallet,
        mint: MINTS.jup,
        quote_mint: MINTS.usdc,
        exchange: "orca",
        side: "Buy",
        amount_tokens: "625",
        quote_amount: "250",
        wallet,
        block_time: at,
        commitment: "confirmed",
      },
    ],
    transfer_count: 0,
    transfers_truncated: false,
    observed_transfers: [],
  },
  {
    signature: bs58.encode(new Uint8Array(64).fill(2)),
    slot: slot - 1,
    transaction_index: 1,
    block_time: "2026-10-22T16:14:00Z",
    fee: null,
    change_count: 1,
    changes_truncated: false,
    changes: [change(MINTS.usdc, "250000000", 1)],
    trade_count: 0,
    trades_truncated: false,
    observed_trades: [],
    transfer_count: 1,
    transfers_truncated: false,
    observed_transfers: [
      {
        signature: bs58.encode(new Uint8Array(64).fill(2)),
        slot: slot - 1,
        transaction_index: 1,
        instruction_ordinal: 0,
        block_time: "2026-10-22T16:14:00Z",
        program: wallet,
        kind: "token",
        direction: "received",
        mint: MINTS.usdc,
        amount_atoms: "250000000",
        source_account: wallet,
        destination_account: wallet,
        source_owner: null,
        destination_owner: wallet,
      },
    ],
  },
  {
    signature: bs58.encode(new Uint8Array(64).fill(3)),
    slot: slot - 2,
    transaction_index: 2,
    block_time: "2026-10-21T14:00:00Z",
    fee: null,
    change_count: 1,
    changes_truncated: false,
    changes: [change(null, "-2000000", 2)],
    trade_count: 0,
    trades_truncated: false,
    observed_trades: [],
    transfer_count: 0,
    transfers_truncated: false,
    observed_transfers: [],
  },
  {
    signature: bs58.encode(new Uint8Array(64).fill(4)),
    slot: slot - 3,
    transaction_index: 3,
    block_time: "2026-10-21T12:00:00Z",
    fee: { payer: wallet, lamports: "5000", succeeded: false },
    change_count: 0,
    changes_truncated: false,
    changes: [],
    trade_count: 0,
    trades_truncated: false,
    observed_trades: [],
    transfer_count: 0,
    transfers_truncated: false,
    observed_transfers: [],
  },
];
const component = (
  id: string,
  value: string,
  assetValue = value,
  debt = "0",
): Schemas["WalletPortfolioComponent"] => {
  const definition = Object.values(resources).find(
    (entry) => entry.componentId === id,
  );
  if (!definition) throw new Error("Unknown synthetic summary component");
  return {
    id,
    source_path:
      `/wallets/${wallet}/${definition.path}` +
      (definition.protocol ? `?protocol=${definition.protocol}` : ""),
    known_asset_value_usd: assetValue,
    known_debt_value_usd: debt,
    known_net_value_usd: value,
    unpriced_count: 0,
    included_in_known_total: true,
    coverage_complete: true,
    coverage_fresh: true,
    coverage_status: "complete",
    snapshot_slot: slot,
    reason: "demo_complete_scope",
  };
};
const basePage = { wallet, cursor: null, has_more: false };
const lpCoverage = { ...coverage, total_positions: 0 };
const fungibleCoverage = {
  ...coverage,
  inventory_slot: slot,
  generation: 1,
  total_candidates: 0,
  refused_candidates: 0,
  unsupported_scopes: [],
};
const fixtureData: ResourceData = {
  summary: {
    wallet,
    known_component_net_value_usd: "12345.67",
    components: [
      component("tokens_native_sol", "7200"),
      component("native_stake", "1500"),
      component("kamino_lend", "2000", "4000", "2000"),
      component("orca_whirlpools", "1645.67"),
    ],
    valuation_consistency: "independent_snapshots",
    whole_wallet_complete: false,
    unsupported_scopes: ["Other protocols and unqualified assets"],
  },
  overview: {
    wallet,
    assets: [
      asset(
        MINTS.usdc,
        "USDC",
        "USD Coin",
        "1800000000",
        6,
        "1800",
        "1",
        "1800",
      ),
      asset(
        MINTS.jito,
        "JitoSOL",
        "Jito Staked SOL",
        "10000000000",
        9,
        "10",
        "165",
        "1650",
      ),
      asset(MINTS.jup, "JUP", "Jupiter", "1000000000", 6, "1000", "0.4", "400"),
      asset(
        MINTS.bonk,
        "BONK",
        "Bonk",
        "100000000000000",
        6,
        "10000000",
        "0.00002",
        "200",
      ),
      asset(MINTS.wif, "WIF", "dogwifhat", "300000000", 6, "300", "0.5", "150"),
    ],
    native_sol_lamports: "20000000000",
    native_sol_slot: slot,
    native_sol_value_usd: "3000",
    wrapped_sol_lamports: "0",
    wrapped_sol_slot: slot,
    wrapped_sol_value_usd: "0",
    sol_price_usd: "150",
    sol_price_updated_at: at,
    known_value_usd: "7200",
    unpriced_asset_count: 0,
    coverage: holdingsCoverage,
  },
  positions: {
    ...basePage,
    data: [
      {
        mint: MINTS.jup,
        symbol: "JUP",
        name: "Jupiter",
        amount: "1000000000",
        decimals: 6,
        ui_amount: "1000",
        token_accounts: [wallet],
        bought: { amount: "625", sol: "2", usd: "250", count: 1 },
        sold: { amount: "0", sol: "0", usd: "0", count: 0 },
        realized_pnl_sol: "0",
        realized_pnl_usd: "0",
        unpriced_trades: 0,
        first_trade_at: at,
        last_trade_at: at,
      },
    ],
    position_count: 1,
    positions_tracked: true,
    positions_since: at,
    last_active_at: at,
    sort: "total_pnl",
  },
  stake: {
    ...basePage,
    data: [
      {
        stake_account: bs58.encode(new Uint8Array(32).fill(12)),
        snapshot_slot: slot,
        lamports: "10000000000",
        rent_exempt_reserve: "2282880",
        state: "delegated",
        staker: wallet,
        withdrawer: wallet,
        lockup_unix_timestamp: 0,
        lockup_epoch: "0",
        lockup_custodian: wallet,
        vote_account: wallet,
        delegated_lamports: "9997717120",
        activation_epoch: "700",
        deactivation_epoch: null,
        value_usd: "1500",
      },
    ],
    total_lamports: "10000000000",
    sol_price_usd: "150",
    sol_price_updated_at: at,
    known_stake_value_usd: "1500",
    coverage,
  },
  "liquid-staking": {
    wallet,
    positions: [
      {
        protocol: "jito",
        receipt_source: "dmnd_owner_index",
        receipt_mint: MINTS.jito,
        receipt_atoms: "10000000000",
        receipt_ui_amount: "10",
        token_account_count: 1,
        last_token_slot: slot,
        pool_address: wallet,
        pool_source: "finalized_spl_stake_pool",
        pool_snapshot_slot: slot,
        pool_fetched_at: at,
        pool_last_update_epoch: 700,
        pool_total_lamports: "11000000000",
        pool_token_supply: "10000000000",
        rate_status: "fresh",
        underlying_lamports: "11000000000",
        underlying_sol_amount: "11",
        reference_value_usd: "1650",
        sol_price_updated_at: at,
      },
    ],
    coverage: holdingsCoverage,
    overlaps_wallet_overview: true,
  },
  kamino: {
    ...basePage,
    protocol: "kamino_lend",
    data: [
      {
        position_account: bs58.encode(new Uint8Array(32).fill(13)),
        market: wallet,
        owner: wallet,
        tag: "lending",
        snapshot_slot: slot,
        last_update_slot: slot,
        last_update_stale: false,
        last_update_timestamp: 1792693800,
        deposits: [loanLeg("4000")],
        debts: [loanLeg("2000")],
      },
    ],
    known_deposit_value_usd: "4000",
    known_debt_value_usd: "2000",
    known_net_value_usd: "2000",
    unpriced_leg_count: 0,
    coverage,
  },
  solend: {
    ...basePage,
    protocol: "solend",
    data: [],
    known_deposit_value_usd: "0",
    known_debt_value_usd: "0",
    known_net_value_usd: "0",
    unpriced_leg_count: 0,
    valuation_consistency: "independent_snapshots",
    coverage,
  },
  marginfi: {
    ...basePage,
    protocol: "marginfi",
    data: [],
    known_deposit_value_usd: "0",
    known_debt_value_usd: "0",
    known_net_value_usd: "0",
    unpriced_side_count: 0,
    unsupported_leg_count: 0,
    valuation_consistency: "independent_snapshots",
    coverage,
  },
  orca: {
    ...basePage,
    protocol: "orca_whirlpools",
    data: [
      {
        position: bs58.encode(new Uint8Array(32).fill(14)),
        deployment: "orca_whirlpools_mainnet",
        program: wallet,
        owner_token_account: wallet,
        position_mint: wallet,
        token_program: wallet,
        bundle_mint: null,
        bundle_index: null,
        pool: wallet,
        liquidity: "100000000",
        tick_lower: -12000,
        tick_upper: 12000,
        principal_a: principal(MINTS.sol, 9, "5000000000", "5", "150", "750"),
        principal_b: principal(
          MINTS.usdc,
          6,
          "895670000",
          "895.67",
          "1",
          "895.67",
        ),
        fee_owed_a: "12345000",
        fee_owed_b: "7500000",
        rewards: [{ mint: MINTS.jup, owed_atoms: "4250000" }],
        owner_token_slot: slot,
        position_slot: slot,
        pool_slot: slot,
        snapshot_slot: slot,
      },
    ],
    page_known_principal_value_usd: "1645.67",
    page_unpriced_leg_count: 0,
    coverage: { ...lpCoverage, total_positions: 1 },
  },
  "raydium-clmm": {
    ...basePage,
    protocol: "raydium_clmm",
    data: [],
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 0,
    coverage: lpCoverage,
  },
  meteora: {
    ...basePage,
    protocol: "meteora_dlmm",
    data: [],
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 0,
    coverage: lpCoverage,
  },
  "meteora-damm-v2": {
    ...basePage,
    protocol: "meteora_damm_v2",
    data: [],
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 0,
    coverage: lpCoverage,
  },
  "raydium-cpmm": {
    ...basePage,
    protocol: "raydium_cpmm",
    data: [],
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 0,
    coverage: fungibleCoverage,
  },
  "raydium-amm-v4": {
    ...basePage,
    protocol: "raydium_amm_v4",
    data: [],
    page_known_principal_value_usd: "0",
    page_unpriced_leg_count: 0,
    coverage: fungibleCoverage,
  },
  "raydium-farms": {
    ...basePage,
    protocol: "raydium_farms",
    data: [],
    page_known_principal_value_usd: "0",
    page_unpriced_position_count: 0,
    coverage: { ...fungibleCoverage, captured_through_slot: slot },
  },
  drift: {
    ...basePage,
    protocol: "drift",
    data: [],
    known_equity_usd: null,
    valuation_status: "unqualified",
    coverage,
  },
  velocity: {
    ...basePage,
    protocol: "velocity",
    data: [],
    known_equity_usd: null,
    inventory_account_count: 0,
    valuation_status: "unqualified",
    coverage,
  },
  transactions: {
    ...basePage,
    data: transactions,
    coverage: activityCoverage,
    transfer_coverage: {
      transfer: {
        since_slot: slot - 1000,
        native_sol_since_slot: slot - 1000,
        live_slot: slot,
        ingest_slot: slot,
        fill_through_slot: slot,
        fresh: true,
        first_unindexed_slot: null,
        complete_since_slot: true,
        reason: "demo",
        native_sol_complete_since_slot: true,
        native_sol_reason: "demo",
      },
      attribution_since_slot: slot - 1000,
      first_unresolved_slot: null,
      attribution_complete_since_slot: true,
      attribution_reason: "demo",
    },
  },
  activity: {
    ...basePage,
    data: transactions.flatMap((t) => t.changes),
    coverage: activityCoverage,
  },
};
export function readFixture<K extends ResourceName>(
  resource: K,
  scenario: FixtureScenario,
  query: ResourceQuery = {},
): ResourceResult<ResourceData[K]> {
  const data = structuredClone(fixtureData);
  if (scenario === "protocol-error" && resource === "orca")
    return { ok: false, kind: "upstream" };
  if (scenario === "pending" || scenario === "empty") {
    for (const name of protocolResources) {
      const item = data[name];
      if ("data" in item) item.data = [];
      if ("positions" in item) item.positions = [];
      if (scenario === "pending") {
        item.coverage.complete = false;
        if ("fresh" in item.coverage) item.coverage.fresh = false;
        if ("status" in item.coverage) item.coverage.status = "queued";
        if ("snapshot_status" in item.coverage)
          item.coverage.snapshot_status = "queued";
        item.coverage.reason = "snapshot_queued";
      }
    }
    data.overview.assets = [];
    data.overview.native_sol_lamports = scenario === "empty" ? "0" : null;
    data.overview.native_sol_value_usd = scenario === "empty" ? "0" : null;
    data.overview.known_value_usd = "0";
    data.overview.coverage.complete = scenario === "empty";
    data.overview.coverage.snapshot_status =
      scenario === "empty" ? "complete" : "queued";
    data.overview.coverage.reason =
      scenario === "empty" ? "snapshot_complete" : "snapshot_queued";
    data.summary.known_component_net_value_usd =
      scenario === "empty" ? "0" : null;
    for (const c of data.summary.components) {
      c.known_net_value_usd = scenario === "empty" ? "0" : null;
      c.coverage_complete = scenario === "empty";
      c.coverage_fresh = scenario === "empty";
      c.coverage_status = scenario === "empty" ? "complete" : "queued";
    }
    data.transactions.data = [];
    data.activity.data = [];
    data.positions.data = [];
    data.positions.position_count = 0;
  }
  if (scenario === "partial" || scenario === "stale") {
    for (const name of protocolResources) {
      const c = data[name].coverage;
      c.complete = false;
      if ("fresh" in c) c.fresh = false;
      if ("status" in c) c.status = scenario;
      c.reason = scenario;
    }
    data.overview.coverage.complete = false;
    data.overview.coverage.reason = scenario;
    data.overview.coverage.snapshot_status = scenario;
    for (const c of data.summary.components) {
      c.coverage_complete = false;
      c.coverage_fresh = false;
      c.coverage_status = scenario;
      c.reason = scenario;
    }
  }
  if (scenario === "unpriced") {
    data.overview.assets.push({
      ...asset(
        bs58.encode(new Uint8Array(32).fill(15)),
        "UNPRICED",
        "Unpriced token",
        "500000000",
        6,
        "500",
        "0",
        "0",
      ),
      price_usd: null,
      value_usd: null,
    });
    data.overview.unpriced_asset_count = 1;
    data.summary.components[0].unpriced_count = 1;
  }
  if (scenario === "activity-continuation" && !query.cursor) {
    data.transactions.data = [];
    data.transactions.has_more = true;
    data.transactions.cursor = "demo-next";
  }
  if (scenario === "truncated") {
    data.transactions.data[0].changes_truncated = true;
    data.transactions.data[0].trade_count = 75;
    data.transactions.data[0].trades_truncated = true;
  }
  if (scenario === "pending" || scenario === "partial") {
    for (const c of [data.transactions.coverage, data.activity.coverage]) {
      c.complete_since_slot = false;
      c.native_sol_complete_since_slot = false;
      c.reason = "not_indexed";
    }
  }
  // Echo the requested order, as the gateway requires of positions pages.
  data.positions.sort = query.sort ?? "total_pnl";
  for (const feed of [data.transactions, data.activity])
    feed.data = feed.data.filter(
      (row) =>
        (!query.from || Date.parse(row.block_time) >= Date.parse(query.from)) &&
        (!query.to || Date.parse(row.block_time) < Date.parse(query.to)),
    ) as typeof feed.data;
  return { ok: true, data: data[resource] };
}
