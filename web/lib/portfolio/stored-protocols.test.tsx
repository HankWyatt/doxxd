import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createDmndClient } from "../dmnd/client.server";
import { validResourcePayload } from "../dmnd/validation.server";
import type { ResourceData } from "../dmnd/contracts";
import { toProtocolView } from "./model";
import { PositionDetail } from "@/components/wallet/position-detail";
import { ProtocolSection } from "@/components/wallet/protocol-section";

// Scrubbed fixtures derived from recorded API53 bodies (synthetic addresses, quantities,
// slots and times), intentionally without a trailing newline.
const marginfiBytes = readFileSync(new NodeURL("../../tests/fixtures/dmnd-source53-marginfi-stored.json", import.meta.url));
const velocityBytes = readFileSync(new NodeURL("../../tests/fixtures/dmnd-source53-velocity-stored.json", import.meta.url));
const marginfi = () => JSON.parse(marginfiBytes.toString("utf8")) as ResourceData["marginfi"];
const velocity = () => JSON.parse(velocityBytes.toString("utf8")) as ResourceData["velocity"];
const value = (label: string) => screen.getByText(label, { exact: true }).nextElementSibling?.textContent;
afterEach(() => vi.unstubAllGlobals());

it.each([
  { resource: "marginfi" as const, bytes: marginfiBytes, size: 1495, sha: "8139be0b8b3884916ae0879c578df9337e3c7f645433340576698c74d50d112c", data: marginfi(), path: "marginfi-positions" },
  { resource: "velocity" as const, bytes: velocityBytes, size: 1791, sha: "599665c726b505655aa1a30503c25cccc954bf10fa585488b17138430bbd41cc", data: velocity(), path: "velocity-positions" },
])("retains the scrubbed stored $resource fixture body through the unchanged client", async record => {
  expect(record.bytes.length).toBe(record.size);
  expect(createHash("sha256").update(record.bytes).digest("hex")).toBe(record.sha);
  expect(validResourcePayload(record.resource, record.data)).toBe(true);
  const request = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://doxxd.invalid");
    expect(url.pathname).toBe(`/api/v1/wallets/${record.data.wallet}/${record.path}`);
    expect(url.searchParams.get("limit")).toBe("1");
    return new Response(record.bytes.toString("utf8"), { status: 200 });
  });
  const client = createDmndClient({ DMND_API_BASE_URL: "https://doxxd.invalid/api/v1", DMND_API_KEY: "synthetic-stored-protocol-test", DMND_ENABLED_PROTOCOLS: record.resource }, request);
  expect(await client.read(record.data.wallet, record.resource, { limit: 1 })).toEqual({ ok: true, data: record.data });
  expect(request).toHaveBeenCalledTimes(1);
});

it("expands exact stored Marginfi shares, underlying quantities and independent price/bank clocks", () => {
  const data = marginfi();
  const view = toProtocolView({ resource: "marginfi", data });
  expect(view.coverage.state).toBe("stale");
  expect(view.positions[0].assets[0].amount).toBe("7.318264");
  expect(view.positions[0].valueUsd).toBeNull();
  expect(view.pageValueUsd).toBeNull();
  render(<PositionDetail position={view.positions[0]} />);
  expect(value("Asset shares (raw)")).toBe("2059908188962430000000");
  expect(value("Liability shares (raw)")).toBe("0");
  expect(value("Bank asset atoms")).toBe("7318264");
  expect(value("Underlying deposit atoms")).toBe("7318264");
  expect(value("Source deposit unit amount")).toBe("7.318264");
  expect(value("Mint decimals")).toBe("6");
  expect(value("Bank snapshot slot")).toBe("432937397");
  expect(value("Position snapshot slot")).toBe("432937396");
  expect(value("Price observation (source)")).toBe("2026-07-24T01:25:48Z");
  expect(value("Price source")).toBe("dmnd_pool_trade_sol");
  expect(value("Source price (USD)")).toBe("1");
  expect(screen.queryByText("Current snapshot")).toBeNull();
});

it("keeps Velocity scaled spot balances separate from unavailable tokens and base/quote quantities separate from equity", () => {
  const data = velocity();
  const view = toProtocolView({ resource: "velocity", data });
  expect(view.coverage.state).toBe("stale");
  expect(view.positions[0].assets[0].amount).toBeNull();
  expect(view.positions[0].assets[0].qualifier).toBe("unavailable_market_snapshot");
  expect(view.positions[0].assets[1].amount).toBe("62.5");
  expect(view.positions[0].valueUsd).toBeNull();
  expect(view.pageValueUsd).toBeNull();
  expect(view.hasMore).toBe(true);
  expect(view.cursor).toBe(data.cursor);
  render(<PositionDetail position={view.positions[0]} />);
  expect(value("Scaled balance (raw)")).toBe("381726905248");
  expect(value("Source token atoms")).toBe("Unknown");
  expect(value("Source spot unit amount")).toBe("Unknown");
  expect(value("Raw base amount")).toBe("62500000000");
  expect(value("Source base unit amount")).toBe("62.5");
  expect(value("Raw quote amount")).toBe("-7302449518");
  expect(value("Source quote unit amount")).toBe("-7302.449518");
  expect(value("Owner inventory slot")).toBe("Unknown");
  expect(value("Account valuation")).toBe("unavailable_equity");
  expect(screen.queryByText(/\$62|\$7,302/)).toBeNull();
});

it("retains zero, null and full-width raw Marginfi shares without converting bank amounts", () => {
  const data = marginfi();
  const leg = data.data[0].legs[0];
  leg.asset_shares = "170141183460469231731687303715884105727";
  leg.deposit_ui_amount = "0";
  leg.bank_asset_atoms = "0";
  leg.underlying_deposit_atoms = null;
  leg.quantity_status = "bank_native";
  const view = toProtocolView({ resource: "marginfi", data });
  expect(validResourcePayload("marginfi", data)).toBe(true);
  expect(view.positions[0].assets[0].amount).toBe("0");
  render(<PositionDetail position={view.positions[0]} />);
  expect(value("Asset shares (raw)")).toBe(leg.asset_shares);
  expect(value("Bank asset atoms")).toBe("0");
  expect(value("Underlying deposit atoms")).toBe("Unknown");
  expect(value("Source deposit unit amount")).toBe("0");
});

it("does not derive a token debt from nonzero liability shares or bank-native atoms", () => {
  const data = marginfi();
  const leg = data.data[0].legs[0];
  leg.asset_shares = "0";
  leg.liability_shares = "170141183460469231731687303715884105727";
  leg.bank_liability_atoms = "42";
  leg.underlying_debt_atoms = null;
  leg.debt_ui_amount = null;
  leg.quantity_status = "unavailable";
  expect(validResourcePayload("marginfi", data)).toBe(true);
  const view = toProtocolView({ resource: "marginfi", data });
  expect(view.positions[0].assets).toEqual([]);
  expect(view.positions[0].debts[0].amount).toBeNull();
  render(<PositionDetail position={view.positions[0]} />);
  expect(value("Liability shares (raw)")).toBe(leg.liability_shares);
  expect(value("Bank liability atoms")).toBe("42");
  expect(value("Underlying debt atoms")).toBe("Unknown");
  expect(value("Source debt unit amount")).toBe("Unknown");
});

it.each(["marginfi", "velocity"] as const)("keeps stored %s coverage incomplete/disabled and never follows a cursor automatically", async resource => {
  const data = resource === "marginfi" ? marginfi() : velocity();
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "https://doxxd.invalid");
    expect(url.pathname).toBe(`/api/wallet/${data.wallet}/${resource}`);
    expect(url.searchParams.get("cursor")).toBeNull();
    return Response.json({ ok: true, data });
  });
  vi.stubGlobal("fetch", request);
  render(<ProtocolSection address={data.wallet} resource={resource} mode={{ kind: "live" }} labels={{}} defaultOpen={false} />);
  fireEvent.click(screen.getByRole("button", { name: resource === "marginfi" ? "Expand MarginFi" : "Expand Velocity" }));
  expect(await screen.findByText("Saved snapshot")).toBeVisible();
  expect(screen.getByText("Coverage reason", { exact: true }).nextElementSibling).toHaveTextContent(`${resource}_scan_disabled`);
  expect(value("Source coverage complete")).toBe("false");
  expect(screen.queryByText("Current snapshot")).toBeNull();
  expect(screen.queryByText("No positions were found in this supported scope.")).toBeNull();
  if (resource === "velocity") expect(screen.getByRole("button", { name: "Next positions" })).toBeVisible();
  else expect(screen.queryByRole("button", { name: "Next positions" })).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
