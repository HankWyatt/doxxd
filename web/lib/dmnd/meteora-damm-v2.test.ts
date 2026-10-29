import { expect, it, vi } from "vitest";
import { createDmndClient } from "./client.server";
import { parseResourceQuery } from "./query";
import { resources, protocolResources } from "./resources";
import { validResourcePayload } from "./validation.server";
import type { ResourceData } from "./contracts";
import { readFixture } from "../fixtures/wallet";
import {
  DAMM,
  dammV2Page,
  syntheticAddress,
} from "../../tests/fixtures/synthetic-meteora-damm-v2";

const wallet = DAMM.wallet;
const env = {
  DMND_API_BASE_URL: "https://api.example.test/api/v1",
  DMND_API_KEY: "synthetic-secret",
  DMND_ENABLED_PROTOCOLS: "orca, meteora-damm-v2",
};

it("registers DAMM v2 as a lazy protocol resource with its summary component", () => {
  expect(protocolResources).toContain("meteora-damm-v2");
  expect(resources["meteora-damm-v2"]).toEqual({
    kind: "liquidity",
    path: "meteora-damm-v2-positions",
    label: "Meteora DAMM v2",
    field: "data",
    componentId: "meteora_damm_v2",
  });
});

it("reads only the fixed DAMM v2 route with validated paging", async () => {
  const body = dammV2Page();
  const network = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe(
      `https://api.example.test/api/v1/wallets/${wallet}/meteora-damm-v2-positions`,
    );
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("opaque-cursor");
    expect(url.searchParams.has("protocol")).toBe(false);
    return Response.json(body);
  });
  expect(
    await createDmndClient(env, network).read(wallet, "meteora-damm-v2", {
      limit: 50,
      cursor: "opaque-cursor",
    }),
  ).toEqual({ ok: true, data: body });
  expect(network).toHaveBeenCalledTimes(1);
});

it("keeps DAMM v2 not enabled until its resource ID is enabled", async () => {
  const network = vi.fn();
  for (const enabled of ["", "meteora", "meteora_damm_v2", undefined])
    expect(
      await createDmndClient(
        { ...env, DMND_ENABLED_PROTOCOLS: enabled },
        network,
      ).read(wallet, "meteora-damm-v2"),
    ).toEqual({ ok: false, kind: "not_enabled" });
  expect(network).not.toHaveBeenCalled();
});

it("accepts cursor and limit within the contract and refuses other filters", () => {
  const parse = (query: string) =>
    parseResourceQuery("meteora-damm-v2", new URLSearchParams(query));
  expect(parse("limit=100&cursor=abc")).toEqual({ limit: 100, cursor: "abc" });
  for (const query of [
    "limit=0",
    "limit=101",
    "from=2026-09-14T00:00:00Z",
    "protocol=meteora_damm_v2",
    "cursor=",
  ])
    expect(parse(query)).toBeNull();
});

it.each([
  ["complete page", () => dammV2Page()],
  [
    "page before any saved scan",
    () => {
      const page = dammV2Page();
      page.data = [];
      delete page.page_known_principal_value_usd;
      delete page.page_unpriced_leg_count;
      page.coverage.snapshot_slot = null;
      return page;
    },
  ],
  [
    "reward without decimals",
    () => {
      const page = dammV2Page();
      page.data[0].rewards[0].decimals = null;
      return page;
    },
  ],
])("accepts a valid %s", async (_, build) => {
  const body = build();
  expect(validResourcePayload("meteora-damm-v2", body)).toBe(true);
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "meteora-damm-v2",
    ),
  ).toEqual({ ok: true, data: body });
});

it.each<[string, (page: any) => void]>([
  ["missing liquidity bucket", (p) => delete p.data[0].liquidity.vested],
  ["numeric fee atoms", (p) => (p.data[0].fee_a_claimable_atoms = 15)],
  ["missing position mint", (p) => delete p.data[0].position_mint],
  ["negative reward index", (p) => (p.data[0].rewards[0].index = -1)],
  ["fractional slot", (p) => (p.data[0].pool_slot = 1.5)],
  ["invalid snapshot clock", (p) => (p.data[0].snapshot_block_time = "soon")],
  ["missing coverage scope", (p) => delete p.coverage.scope],
  ["missing total positions", (p) => delete p.coverage.total_positions],
  ["non-boolean has_more", (p) => (p.has_more = "false")],
  ["foreign wallet", (p) => (p.wallet = syntheticAddress("damm-v2/other"))],
])("rejects a page with %s", async (_, mutate) => {
  const body = dammV2Page();
  mutate(body);
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "meteora-damm-v2",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});

function summary(): ResourceData["summary"] {
  return {
    wallet,
    known_component_net_value_usd: "100",
    valuation_consistency: "independent_snapshots",
    whole_wallet_complete: false,
    unsupported_scopes: [],
    components: [
      {
        id: "meteora_damm_v2",
        source_path: `/wallets/${wallet}/meteora-damm-v2-positions`,
        included_in_known_total: false,
        coverage_complete: false,
        coverage_fresh: null,
        coverage_status: "disabled",
        reason: "disabled",
        known_net_value_usd: null,
        snapshot_slot: null,
      },
    ],
  };
}

it("accepts the DAMM v2 summary component with its canonical source", async () => {
  const body = summary();
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: true, data: body });
});

it.each([
  `/wallets/${wallet}/meteora-dlmm-positions`,
  `/wallets/${wallet}/meteora-damm-v2-positions?protocol=meteora_damm_v2`,
  `/wallets/${wallet}/liquidity-positions?protocol=meteora_damm_v2`,
  `/wallets/${syntheticAddress("damm-v2/other")}/meteora-damm-v2-positions`,
])("rejects the DAMM v2 summary component from source %s", async (source) => {
  const body = summary();
  body.components[0].source_path = source;
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "summary",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});

function overview() {
  const result = readFixture("overview", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  const body = result.data;
  body.wallet = wallet;
  body.assets.push({
    ...body.assets[0],
    mint: DAMM.positionMint,
    symbol: null,
    name: null,
    amount: "1",
    decimals: 0,
    ui_amount: "1",
    price_usd: null,
    value_usd: null,
    position: {
      protocol: "meteora_damm_v2",
      position: DAMM.position,
      pool: DAMM.pool,
    },
  });
  return body;
}

it.each<[string, (asset: any) => void]>([
  ["identified receipt", () => {}],
  [
    "receipt before the first completed scan",
    (a) => (a.position = { protocol: "meteora_damm_v2", position: null, pool: null }),
  ],
  ["ordinary token with null position", (a) => (a.position = null)],
  ["ordinary token without position", (a) => delete a.position],
])("accepts an overview asset as %s", async (_, mutate) => {
  const body = overview();
  mutate(body.assets.at(-1));
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "overview",
    ),
  ).toEqual({ ok: true, data: body });
});

it.each<[string, (asset: any) => void]>([
  ["position without protocol", (a) => delete a.position.protocol],
  ["numeric position", (a) => (a.position.position = 7)],
  ["string position object", (a) => (a.position = "meteora_damm_v2")],
])("rejects an overview asset with %s", async (_, mutate) => {
  const body = overview();
  mutate(body.assets.at(-1));
  expect(
    await createDmndClient(env, async () => Response.json(body)).read(
      wallet,
      "overview",
    ),
  ).toEqual({ ok: false, kind: "upstream" });
});

it("accepts an optional symbol on shared liquidity legs", () => {
  const result = readFixture("orca", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  result.data.data[0].principal_a.symbol = "SYNA";
  result.data.data[0].principal_b.symbol = null;
  expect(validResourcePayload("orca", result.data)).toBe(true);
  (result.data.data[0].principal_a as any).symbol = 5;
  expect(validResourcePayload("orca", result.data)).toBe(false);
});
