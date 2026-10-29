import { expect, it } from "vitest";
import type { Schemas } from "../dmnd/contracts";
import { chipModel, componentState } from "./chips";

type Component = Schemas["WalletPortfolioComponent"];

const component = (id: string, over: Partial<Component> = {}): Component => ({
  id,
  source_path: id,
  known_net_value_usd: "0",
  coverage_complete: true,
  coverage_fresh: true,
  coverage_status: "complete",
  reason: "snapshot_complete",
  included_in_known_total: true,
  ...over,
});

it("only protocols with something become chips", () => {
  const { chips } = chipModel([
    component("kamino_lend", { known_net_value_usd: "10.5" }),
    component("solend", { known_net_value_usd: "0" }),
    component("marginfi", { known_net_value_usd: "0", unpriced_count: 2 }),
    component("drift", { known_net_value_usd: null }),
  ]);
  expect(chips.map((c) => c.id).sort()).toEqual(["kamino_lend", "marginfi"]);
});

it("an unpriced chip with no positive value shows an unknown value, not $0.00", () => {
  const { chips } = chipModel([
    component("marginfi", { known_net_value_usd: "0", unpriced_count: 2 }),
    component("solend", { known_net_value_usd: null, unpriced_count: 1 }),
    component("kamino_lend", { known_net_value_usd: "12", unpriced_count: 1 }),
  ]);
  expect(Object.fromEntries(chips.map((c) => [c.id, c.valueUsd]))).toEqual({
    marginfi: null,
    solend: null,
    kamino_lend: "12",
  });
});

it("a non-zero net value is a chip, and a negative one stays negative", () => {
  const { chips, nothingFound } = chipModel([
    component("solend", { known_net_value_usd: "-45.5", known_asset_value_usd: "10", known_debt_value_usd: "55.5" }),
    component("kamino_lend", { known_net_value_usd: "3" }),
  ]);
  expect(chips.map((c) => [c.id, c.valueUsd])).toEqual([
    ["kamino_lend", "3"],
    ["solend", "-45.5"],
  ]);
  expect(nothingFound).toBe(0);
});

it("real assets or debt with a zero net value are never nothing found", () => {
  const model = chipModel([
    component("solend", { known_net_value_usd: "0", known_asset_value_usd: "50", known_debt_value_usd: "50" }),
    component("marginfi", { known_net_value_usd: "0", known_asset_value_usd: "0", known_debt_value_usd: "20" }),
    component("drift", { known_net_value_usd: "0", known_asset_value_usd: "0", known_debt_value_usd: "0" }),
  ]);
  expect(model.chips.map((c) => c.id).sort()).toEqual(["marginfi", "solend"]);
  expect(model.chips.every((c) => c.valueUsd === "0")).toBe(true);
  expect(model.nothingFound).toBe(1);
});

it("the wallet is never counted as a protocol checked or not available", () => {
  const empty = chipModel([
    component("tokens_native_sol", { known_net_value_usd: null }),
  ]);
  expect(empty).toMatchObject({ chips: [], nothingFound: 0, notAvailable: 0 });
  const unavailable = chipModel([
    component("tokens_native_sol", {
      known_net_value_usd: null,
      coverage_complete: false,
      coverage_status: "native_balance_stale_or_unavailable",
    }),
  ]);
  expect(unavailable).toMatchObject({ chips: [], nothingFound: 0, notAvailable: 0 });
});

it("keeps the wallet chip whenever its value is known, even zero", () => {
  expect(
    chipModel([component("tokens_native_sol", { known_net_value_usd: "0" })])
      .chips.map((c) => c.id),
  ).toEqual(["tokens_native_sol"]);
  const unknown = chipModel([
    component("tokens_native_sol", { known_net_value_usd: null, coverage_complete: false }),
  ]);
  expect(unknown.chips).toEqual([]);
});

it("chips sort by value with unknown last", () => {
  const { chips } = chipModel([
    component("solend", { known_net_value_usd: "5" }),
    component("marginfi", { known_net_value_usd: null, unpriced_count: 1 }),
    component("kamino_lend", { known_net_value_usd: "1000.25" }),
    component("tokens_native_sol", { known_net_value_usd: "31.07" }),
  ]);
  expect(chips.map((c) => c.id)).toEqual([
    "kamino_lend",
    "tokens_native_sol",
    "solend",
    "marginfi",
  ]);
  expect(chips.at(-1)!.valueUsd).toBeNull();
  expect(chips[0]).toMatchObject({ label: "Kamino Lend", valueUsd: "1000.25" });
});

it("complete empty protocols count as nothing found", () => {
  const model = chipModel([
    component("kamino_lend", { known_net_value_usd: "3" }),
    component("solend"),
    component("marginfi", { known_net_value_usd: null }),
    component("drift", { known_net_value_usd: "0.000" }),
  ]);
  expect(model.nothingFound).toBe(3);
  expect(model.notAvailable).toBe(0);
});

it("disabled component is not nothing found", () => {
  const model = chipModel([
    component("solend", { coverage_status: "disabled", reason: "disabled" }),
    component("marginfi", { reason: "source_unavailable" }),
    component("drift", { coverage_complete: false, coverage_status: "partial" }),
    component("velocity", { coverage_status: "not_requested" }),
  ]);
  expect(model.nothingFound).toBe(0);
  expect(model.notAvailable).toBe(4);
});

it("pending components are neither empty nor unavailable", () => {
  const model = chipModel([
    component("solend", { coverage_complete: false, coverage_status: "queued", known_net_value_usd: null }),
    component("kamino_lend", {
      coverage_complete: false,
      coverage_status: "running",
      known_net_value_usd: "8",
    }),
  ]);
  expect(model.chips.map((c) => c.id)).toEqual(["kamino_lend"]);
  expect(model.nothingFound).toBe(0);
  expect(model.notAvailable).toBe(0);
});

it("wallet chip links to #holdings, and protocols link to #protocol-<resource>", () => {
  const { chips } = chipModel([
    component("tokens_native_sol", { known_net_value_usd: "1" }),
    component("kamino_lend", { known_net_value_usd: "2" }),
    component("meteora_damm_v2", { known_net_value_usd: "3" }),
    component("mystery_source", { known_net_value_usd: "4" }),
  ]);
  const byId = Object.fromEntries(chips.map((c) => [c.id, c]));
  expect(byId.tokens_native_sol).toMatchObject({ resource: "overview", href: "#holdings", label: "Wallet" });
  expect(byId.kamino_lend).toMatchObject({ resource: "kamino", href: "#protocol-kamino" });
  expect(byId.meteora_damm_v2.href).toBe("#protocol-meteora-damm-v2");
  expect(byId.mystery_source).toMatchObject({ resource: undefined, href: "#coverage", label: "mystery source", initials: "·" });
  expect(byId.kamino_lend.initials).toBe("Ka");
});

it("classifies each component the same way the chip counts do", () => {
  expect(componentState(component("kamino_lend", { known_net_value_usd: "10" }))).toBe("chip");
  expect(componentState(component("solend"))).toBe("empty");
  expect(
    componentState(component("orca_whirlpools", { coverage_status: "snapshot_queued", coverage_complete: false })),
  ).toBe("pending");
  expect(componentState(component("drift", { coverage_status: "disabled" }))).toBe("unavailable");
  expect(componentState(component("marginfi", { coverage_complete: false }))).toBe("unavailable");
  expect(componentState(component("tokens_native_sol", { known_net_value_usd: null }))).toBeNull();
});

it("chipValue hides a zero net when positions are unpriced", async () => {
  const { chipValue } = await import("./chips");
  const base = { known_net_value_usd: "0", unpriced_count: 2 } as Parameters<typeof chipValue>[0];
  expect(chipValue(base)).toBeNull();
  expect(chipValue({ ...base, unpriced_count: 0 })).toBe("0");
  expect(chipValue({ ...base, known_net_value_usd: "12.5" })).toBe("12.5");
  expect(chipValue({ ...base, known_net_value_usd: null })).toBeNull();
});
