import { expect, it } from "vitest";
import type { Schemas } from "../dmnd/contracts";
import { protocolResources, resources } from "../dmnd/resources";
import { readFixture } from "../fixtures/wallet";
import { DAMM, dammV2Page } from "../../tests/fixtures/synthetic-meteora-damm-v2";
import { fungibleRows, meteoraRows } from "./adapters/liquidity";
import { kindTag, manageLink } from "./links";
import { toProtocolView } from "./model";

const POOL = "SyntheticPool1111111111111111111111111111111";

it("kindTag maps every protocol resource", () => {
  for (const resource of protocolResources) {
    const kind = resources[resource].kind;
    expect(kind, resource).toBeDefined();
    expect(kindTag(kind!), resource).not.toBe("");
  }
  expect(kindTag("lending")).toBe("Lending");
  expect(kindTag("staking")).toBe("Staking");
  expect(kindTag("liquidity")).toBe("Liquidity Pool");
  expect(kindTag("perps")).toBe("Perps");
  expect(kindTag("yield")).toBe("Yield");
});

it("assigns the planned kind to each protocol", () => {
  const kinds = Object.fromEntries(
    protocolResources.map((r) => [r, resources[r].kind]),
  );
  expect(kinds).toEqual({
    kamino: "lending",
    solend: "lending",
    marginfi: "lending",
    stake: "staking",
    "liquid-staking": "staking",
    orca: "liquidity",
    "raydium-clmm": "liquidity",
    meteora: "liquidity",
    "meteora-damm-v2": "liquidity",
    "raydium-cpmm": "liquidity",
    "raydium-amm-v4": "liquidity",
    "raydium-farms": "yield",
    drift: "perps",
    velocity: "perps",
  });
});

it("manageLink builds verified pool URLs", () => {
  expect(manageLink("meteora-damm-v2", { pool: POOL })).toEqual({
    label: "Manage on Meteora",
    href: "https://app.meteora.ag/dammv2/" + POOL,
  });
});

it("manageLink returns null without a pool or for unverified protocols", () => {
  expect(manageLink("meteora-damm-v2", undefined)).toBeNull();
  expect(manageLink("meteora-damm-v2", {})).toBeNull();
  expect(
    manageLink("meteora-damm-v2", { position: DAMM.position }),
  ).toBeNull();
  for (const resource of protocolResources) {
    if (resource === "meteora-damm-v2") continue;
    expect(
      manageLink(resource, {
        pool: POOL,
        position: "p",
        positionMint: "m",
      }),
      resource,
    ).toBeNull();
  }
});

it("adapters expose links", () => {
  const damm = toProtocolView({
    resource: "meteora-damm-v2",
    data: dammV2Page(),
  }).positions[0];
  expect(damm.links).toEqual({
    pool: DAMM.pool,
    position: DAMM.position,
    positionMint: DAMM.positionMint,
  });

  const orcaResult = readFixture("orca", "complete");
  if (!orcaResult.ok) throw new Error("fixture failed");
  const row = orcaResult.data.data[0];
  expect(
    toProtocolView({ resource: "orca", data: orcaResult.data }).positions[0]
      .links,
  ).toEqual({
    pool: row.pool,
    position: row.position,
    positionMint: row.position_mint,
  });

  const leg = { mint: DAMM.tokenA, symbol: null, ui_amount: null };
  const dlmm = meteoraRows({
    data: [
      { pair: POOL, position: "PosSynth", principal_x: leg, principal_y: leg, rewards: [] },
    ],
  } as unknown as Schemas["WalletMeteoraPositions"]);
  expect(dlmm[0].links).toEqual({ pool: POOL, position: "PosSynth" });

  const receipt = (pool: string | null) =>
    fungibleRows({
      data: [{ owner_token_account: "TokAcct", pool, principal: [], sources: [] }],
    } as unknown as Schemas["WalletFungibleLiquidityPositions"])[0];
  expect(receipt(POOL).links).toEqual({ pool: POOL });
  expect(receipt(null).links).toBeUndefined();
});
