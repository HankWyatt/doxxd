import type { Page } from "@playwright/test";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";
import type { ResourceName, Schemas } from "../../lib/dmnd/contracts";
import { isResource } from "../../lib/dmnd/resources";
import { parseResourceQuery } from "../../lib/dmnd/query";
import { dammV2Page, dammV2Position } from "../fixtures/synthetic-meteora-damm-v2";
import { cpmmPage } from "../fixtures/synthetic-raydium-positions";
import type { ChainSummary } from "./action-rpc-chain";

const CP_AMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// DMND's view of the synthetic chain owner (tests/fixtures/actions-chain.ts),
// for the LP action flows. Every row names the same pool, position, NFT and
// LP accounts that the mocked /api/rpc serves, with DMND-shaped (made-up,
// round) display values. Everything else is the ordinary synthetic wallet
// fixture, re-addressed to the owner.

// DMND's snapshot predates the synthetic cluster's slot (SYNTHETIC.clock.slot,
// 1,000), where the mocked RPC confirms every transaction: a confirmed action
// stays pending until DMND reports a later slot.
const SNAPSHOT_SLOT = 990;

function dammRow(
  chain: ChainSummary,
  variant: "unlocked" | "locked",
  valueUsd: string,
): Schemas["WalletMeteoraDammV2Position"] {
  const accounts = chain.dammV2[variant];
  const base = dammV2Position();
  const full = chain.amounts.positionLiquidity;
  const half = chain.amounts.halfLiquidity;
  return {
    ...base,
    position_mint: accounts.positionMint,
    position: accounts.position,
    pool: accounts.pool,
    program: CP_AMM,
    // Position NFTs are Token-2022 mints in a PDA token account.
    token_program: TOKEN_2022,
    owner_token_account: accounts.positionNftAccount,
    token_a: { ...base.token_a, mint: chain.mints.syna, symbol: "SYNA", decimals: 9, amount_atoms: "4000000000", ui_amount: "4", price_usd: "10", value_usd: "40" },
    token_b: { ...base.token_b, mint: chain.mints.wsol, symbol: "SOL", decimals: 9, amount_atoms: "4000000000", ui_amount: "4", price_usd: null, value_usd: null },
    liquidity:
      variant === "unlocked"
        ? { unlocked: full, vested: "0", permanent_locked: "0", total: full }
        : { unlocked: half, vested: "0", permanent_locked: half, total: full },
    fee_a_claimable_atoms: chain.amounts.feeA,
    fee_b_claimable_atoms: chain.amounts.feeB,
    rewards: [{ index: 0, mint: chain.mints.reward, decimals: 6, claimable_atoms: chain.amounts.reward }],
    principal_value_usd: valueUsd,
    owner_token_slot: SNAPSHOT_SLOT,
    position_slot: SNAPSHOT_SLOT,
    pool_slot: SNAPSHOT_SLOT,
    snapshot_slot: SNAPSHOT_SLOT,
  };
}

/** Every DMND resource for the chain owner, as the Doxxd API returns it. */
export function lpActionsWallet(chain: ChainSummary) {
  const owner = chain.owner;
  // The ordinary synthetic wallet, re-addressed to the chain owner.
  const readAs = (resource: ResourceName, query: Parameters<typeof readFixture>[2]) =>
    JSON.parse(JSON.stringify(readFixture(resource, "complete", query)).replaceAll(DEMO_ADDRESS, owner));

  const damm = dammV2Page();
  damm.wallet = owner;
  // Unlocked first (higher value), then the half permanently locked one.
  damm.data = [dammRow(chain, "unlocked", "80"), dammRow(chain, "locked", "40")];
  damm.page_known_principal_value_usd = "120";
  damm.page_unpriced_leg_count = 0;
  damm.coverage.total_positions = 2;
  damm.coverage.snapshot_slot = SNAPSHOT_SLOT;

  const cpmm = cpmmPage();
  cpmm.wallet = owner;
  const [lp] = cpmm.data;
  cpmm.data = [
    {
      ...lp,
      lp_mint: chain.cpmm.lpMint,
      owner_token_account: chain.cpmm.lpAccount,
      lp_atoms: chain.amounts.cpmmOwnerLp,
      lp_decimals: 9,
      pool: chain.cpmm.pool,
      context_slot: SNAPSHOT_SLOT,
      principal: [
        { ...lp.principal[0], mint: chain.mints.wsol, decimals: 9, gross_atoms: "10000000000", net_atoms: "10000000000", available_vault_atoms: "10000000000" },
        { ...lp.principal[1], mint: chain.mints.synb, decimals: 6, gross_atoms: "500000000", net_atoms: "500000000", available_vault_atoms: "500000000" },
      ],
    },
  ];

  const summary = readAs("summary", {}) as { ok: true; data: Schemas["WalletPortfolioSummary"] };
  const [native] = summary.data.components;
  const component = (id: string, path: string, value: string) => ({
    ...native,
    id,
    source_path: `/wallets/${owner}/${path}`,
    known_asset_value_usd: value,
    known_net_value_usd: value,
  });
  summary.data.components = [
    native,
    component("meteora_damm_v2", "meteora-damm-v2-positions", "120"),
    component("raydium_cpmm", "fungible-liquidity-positions?protocol=raydium_cpmm", "50"),
  ];
  summary.data.known_component_net_value_usd = "7370";

  return {
    owner,
    read(resource: ResourceName, query: Parameters<typeof readFixture>[2]) {
      if (resource === "meteora-damm-v2") return { ok: true, data: damm };
      if (resource === "raydium-cpmm") return { ok: true, data: cpmm };
      if (resource === "summary") return summary;
      return readAs(resource, query);
    },
  };
}

/** Routes /api/wallet/{owner}/** to lpActionsWallet, like mockWalletResources. */
export async function mockLpActionsWallet(page: Page, chain: ChainSummary) {
  const wallet = lpActionsWallet(chain);
  await page.route(`**/api/wallet/${wallet.owner}/**`, async (route) => {
    const url = new URL(route.request().url());
    const resource = url.pathname.split("/").at(-1);
    if (!resource || !isResource(resource))
      return route.fulfill({ status: 404, json: { ok: false, kind: "invalid_input" } });
    const query = parseResourceQuery(resource, url.searchParams);
    if (query === null)
      return route.fulfill({ status: 400, json: { ok: false, kind: "invalid_input" } });
    return route.fulfill({ status: 200, json: wallet.read(resource, query) });
  });
  return wallet.owner;
}
