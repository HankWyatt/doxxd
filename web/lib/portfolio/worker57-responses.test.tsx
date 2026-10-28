import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createDmndClient } from "../dmnd/client.server";
import { validResourcePayload } from "../dmnd/validation.server";
import type { ResourceData } from "../dmnd/contracts";
import { ProtocolSection } from "@/components/wallet/protocol-section";
import { toProtocolView } from "./model";

// Scrubbed fixtures derived from recorded worker57 Drift responses (synthetic wallet,
// slots and times). Provenance and limits live alongside the fixtures; this test makes no live call.
const records = [
  { phase: "initial", size: 491, sha: "00cf4611cb81e970885777b23450152d20ed55eb9b904f06a649b75cc80b4de4", state: "pending" },
  { phase: "final", size: 518, sha: "9d1f661c4a4ede97741db1af414ebe42e554559ff7f61ca6e11a6cb320761585", state: "empty" },
] as const;
const bytes = (phase: string) => readFileSync(new NodeURL(`../../tests/fixtures/dmnd-worker57-drift-${phase}.json`, import.meta.url));
const payload = (phase: string) => JSON.parse(bytes(phase).toString()) as ResourceData["drift"];
afterEach(() => vi.unstubAllGlobals());

it.each(records)("preserves the scrubbed $phase Drift response through the current client and adapter", async record => {
  const body = bytes(record.phase), data = payload(record.phase);
  expect(body.length).toBe(record.size);
  expect(createHash("sha256").update(body).digest("hex")).toBe(record.sha);
  expect(validResourcePayload("drift", data)).toBe(true);
  const request = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://doxxd.invalid");
    expect(url.pathname).toBe(`/api/v1/wallets/${data.wallet}/drift-positions`);
    expect(url.searchParams.get("limit")).toBe("1");
    return new Response(body.toString(), { status: 200 });
  });
  const client = createDmndClient({ DMND_API_BASE_URL: "https://doxxd.invalid/api/v1", DMND_API_KEY: "synthetic-worker57", DMND_ENABLED_PROTOCOLS: "drift" }, request);
  const result = await client.read(data.wallet, "drift", { limit: 1 });
  expect(result).toEqual({ ok: true, data });
  const view = toProtocolView({ resource: "drift", data });
  expect(view.coverage.state).toBe(record.state);
  expect(view.positions).toEqual([]);
  expect(view.pageValueUsd).toBeNull();
  expect(data.known_equity_usd).toBeNull();
  expect(data.valuation_status).toBe("unavailable_equity");
  expect(view.coverage.snapshotSlot).toBe(data.coverage.snapshot_slot ?? undefined);
});

it.each(records)("shows the $phase supported Drift scope without inventing zero equity", async record => {
  const data = payload(record.phase);
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "https://doxxd.invalid");
    expect(url.pathname).toBe(`/api/wallet/${data.wallet}/drift`);
    expect(url.searchParams.get("limit")).toBe("50");
    return Response.json({ ok: true, data });
  });
  vi.stubGlobal("fetch", request);
  const { container } = render(<ProtocolSection address={data.wallet} resource="drift" mode={{ kind: "live" }} labels={{}} />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand Drift" }));
  if (record.phase === "initial") {
    expect(await screen.findByText("Preparing wallet data", { selector: ".empty-state strong" })).toBeVisible();
    expect(screen.queryByText("No positions were found in this supported scope.")).not.toBeInTheDocument();
  } else {
    expect(await screen.findByText("No positions were found in this supported scope.")).toBeVisible();
    fireEvent.click(container.querySelector("summary")!);
    expect(screen.getByText("Source slot: 403321218.")).toBeVisible();
    expect(screen.getByText(/Scope: drift user accounts authorized by wallet/)).toBeVisible();
  }
  expect(container.querySelector(".protocol-value")).toHaveTextContent("—");
  expect(screen.queryByText(/This page:/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next positions" })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(records)("rejects the $phase recording for another requested wallet", async record => {
  const client = createDmndClient({ DMND_API_BASE_URL: "https://doxxd.invalid/api/v1", DMND_API_KEY: "synthetic-worker57", DMND_ENABLED_PROTOCOLS: "drift" }, async () => new Response(bytes(record.phase).toString(), { status: 200 }));
  expect(await client.read("Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X", "drift")).toEqual({ ok: false, kind: "upstream" });
});
