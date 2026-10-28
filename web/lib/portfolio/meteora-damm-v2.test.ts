import { expect, it } from "vitest";
import { toProtocolView } from "./model";
import { short } from "./adapters/shared";
import { validResourcePayload } from "../dmnd/validation.server";
import { readFixture } from "../fixtures/wallet";
import {
  DAMM,
  dammV2Page,
  dammV2State,
} from "../../tests/fixtures/synthetic-meteora-damm-v2";

const view = (data = dammV2Page()) => {
  expect(validResourcePayload("meteora-damm-v2", data)).toBe(true);
  return toProtocolView({ resource: "meteora-damm-v2", data });
};
const detail = (labels: { label: string; value: string }[], label: string) =>
  labels.find((d) => d.label === label)?.value;

it("presents the pair with provided symbols and short-mint fallbacks", () => {
  const row = view().positions[0];
  expect(row.id).toBe(DAMM.position);
  expect(row.label).toBe("SYNA / " + short(DAMM.tokenB));
  expect(detail(row.details, "Pool")).toBe(DAMM.pool);
  expect(detail(row.details, "Position")).toBe(DAMM.position);
  expect(detail(row.details, "Position NFT mint")).toBe(DAMM.positionMint);
});

it("derives leg amounts from atoms and decimals and keeps unknown value unknown", () => {
  const [a, b] = view().positions[0].assets;
  expect(a).toMatchObject({ label: "SYNA", mint: DAMM.tokenA, amount: "2.5", valueUsd: "40" });
  expect(b).toMatchObject({ mint: DAMM.tokenB, amount: "1234.5", valueUsd: null });
  expect(b.sourceDetails).toContainEqual({ label: "Raw atoms", value: "1234500000" });
});

it("keeps a leg amount unknown when its decimals are unknown", () => {
  const data = dammV2Page();
  data.data[0].token_b.decimals = null;
  const b = view(data).positions[0].assets[1];
  expect(b.amount).toBeNull();
  expect(b.sourceDetails).toContainEqual({ label: "Raw atoms", value: "1234500000" });
});

it("shows claimable fees and rewards without a USD value", () => {
  const [feeA, feeB, reward] = view().positions[0].rewards;
  expect(feeA).toMatchObject({ label: "SYNA", amount: "1.5" });
  expect(feeA.qualifier).toMatch(/claimable fee/i);
  expect(feeB).toMatchObject({ mint: DAMM.tokenB, amount: "0.25" });
  expect(reward).toMatchObject({ mint: DAMM.reward, amount: "7" });
  expect(reward.qualifier).toMatch(/claimable reward/i);
  for (const value of [feeA, feeB, reward]) expect(value.valueUsd).toBeUndefined();
});

it("keeps fee and reward atoms raw when decimals are unknown", () => {
  const data = dammV2Page();
  data.data[0].token_a.decimals = null;
  data.data[0].rewards[0].decimals = null;
  const [feeA, , reward] = view(data).positions[0].rewards;
  expect(feeA).toMatchObject({ amount: "1500000000" });
  expect(feeA.qualifier).toMatch(/raw atoms/i);
  expect(reward).toMatchObject({ amount: "7000000" });
  expect(reward.qualifier).toMatch(/raw atoms/i);
});

it("shows every liquidity bucket including vesting and permanently locked", () => {
  const details = view().positions[0].details;
  expect(detail(details, "Unlocked liquidity")).toBe("1000");
  expect(detail(details, "Vesting liquidity")).toBe("200");
  expect(detail(details, "Permanently locked liquidity")).toBe("300");
  expect(detail(details, "Total liquidity")).toBe("1500");
  expect(detail(details, "Liquidity units")).toMatch(/included in the token amounts/i);
});

it("uses only DMND's principal value and preserves source clocks", () => {
  const unvalued = view();
  expect(unvalued.positions[0].valueUsd).toBeNull();
  expect(unvalued.pageValueUsd).toBe("40");
  const details = unvalued.positions[0].details;
  expect(detail(details, "Owner token slot")).toBe("410000003");
  expect(detail(details, "Position account slot")).toBe("410000002");
  expect(detail(details, "Pool slot")).toBe("410000001");
  expect(detail(details, "Snapshot slot")).toBe("410000004");
  expect(detail(details, "Position clock time")).toBe("2026-09-14T11:59:30Z");
  expect(detail(details, "Pool price (token A in token B)")).toBe("0.5");
  const data = dammV2Page();
  data.data[0].principal_value_usd = "52";
  expect(view(data).positions[0].valueUsd).toBe("52");
});

it.each([
  ["pending", "pending"],
  ["empty", "empty"],
  ["complete", "ready"],
  ["partial", "partial"],
  ["disabled", "unavailable"],
  ["stale", "stale"],
] as const)("maps the %s coverage to %s", (state, expected) => {
  const v = view(dammV2State(state));
  expect(v.coverage.state).toBe(expected);
  expect(v.coverage.detail).toContain("meteora damm v2 nft position v1 mainnet");
  expect(v.coverageClocks).toContainEqual({
    label: "Coverage reason",
    value: dammV2State(state).coverage.reason,
  });
});

it("retains a continuation cursor and the source inventory count", () => {
  const v = view(dammV2State("partial"));
  expect(v.hasMore).toBe(true);
  expect(v.cursor).toBe("synthetic-damm-v2-cursor-2");
  expect(v.totalPositions).toBe(2);
  expect(v.continuationUnavailable).toBe(false);
});

it("does not treat an empty continuation page as an empty scope", () => {
  const data = dammV2State("empty");
  data.coverage.total_positions = 3;
  expect(view(data).coverage.state).toBe("ready");
});

it("provides a synthetic empty demo page like Meteora DLMM", () => {
  const result = readFixture("meteora-damm-v2", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  expect(validResourcePayload("meteora-damm-v2", result.data)).toBe(true);
  expect(result.data.protocol).toBe("meteora_damm_v2");
  expect(result.data.data).toEqual([]);
});

it("labels shared liquidity legs with a provided symbol", () => {
  const result = readFixture("orca", "complete");
  if (!result.ok) throw new Error("Fixture must succeed");
  result.data.data[0].principal_b.symbol = "SYNB";
  result.data.data[0].principal_a.symbol = " ";
  const row = toProtocolView({ resource: "orca", data: result.data }).positions[0];
  expect(row.assets.map((a) => a.label)).toEqual(["WSOL", "SYNB"]);
});
