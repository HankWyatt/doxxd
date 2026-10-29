import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createDmndClient } from "../dmnd/client.server";
import { validResourcePayload } from "../dmnd/validation.server";
import type { ResourceData } from "../dmnd/contracts";
import { toProtocolView } from "./model";
import { Holdings } from "@/components/wallet/holdings";
import { ProtocolSection } from "@/components/wallet/protocol-section";
import { Portfolio } from "@/components/wallet/portfolio";

// Scrubbed fixtures derived from recorded API54/55 responses: addresses, amounts,
// slots and times are synthetic, so byte counts and SHA256 pin the scrubbed
// files only. These are independently dated source observations, not a coherent
// financial bundle.
function bytes(name: string) {
  return readFileSync(new NodeURL(`../../tests/fixtures/${name}.json`, import.meta.url));
}
const overviewBytes = bytes("dmnd-source54-new-wallet-overview");
const originalStakeBytes = bytes("dmnd-source55-stake-original");
const newStakeBytes = bytes("dmnd-source55-stake-new");
const overview = () => JSON.parse(overviewBytes.toString()) as ResourceData["overview"];
const stake = (body = newStakeBytes) => JSON.parse(body.toString()) as ResourceData["stake"];
const detail = (label: string) => screen.getByText(label, { exact: true, selector: "dt" }).nextElementSibling?.textContent;
afterEach(() => vi.unstubAllGlobals());

it.each([
  { resource: "overview" as const, body: overviewBytes, size: 1440, sha: "884455f6f59376829946572d8d27e7de0b799b832af54eb30d34e248feb49b04", data: overview(), endpoint: "overview" },
  { resource: "stake" as const, body: originalStakeBytes, size: 480, sha: "ba7bca678f07a697e5e4818a847d1a06fd5dffd941d8d01269bdfa931f49d269", data: stake(originalStakeBytes), endpoint: "stake-accounts" },
  { resource: "stake" as const, body: newStakeBytes, size: 480, sha: "e4266da1f5de01e9b80f81e7c0ebcb34352910defbcd2204d676f525942588a8", data: stake(), endpoint: "stake-accounts" },
])("accepts the scrubbed $resource fixture body for $data.wallet through the current typed client", async record => {
  expect(record.body.length).toBe(record.size);
  expect(createHash("sha256").update(record.body).digest("hex")).toBe(record.sha);
  expect(validResourcePayload(record.resource, record.data)).toBe(true);
  const request = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://doxxd.invalid");
    expect(url.pathname).toBe(`/api/v1/wallets/${record.data.wallet}/${record.endpoint}`);
    return new Response(record.body.toString(), { status: 200 });
  });
  const client = createDmndClient({ DMND_API_BASE_URL: "https://doxxd.invalid/api/v1", DMND_API_KEY: "synthetic-current-wallet-test", DMND_ENABLED_PROTOCOLS: "stake" }, request);
  expect(await client.read(record.data.wallet, record.resource)).toEqual({ ok: true, data: record.data });
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps the newly acquired wallet's exact native amount, token amount and independent clocks", () => {
  const data = overview();
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  render(<Holdings overview={data} />);
  expect(screen.getAllByRole("button", { name: /^Inspect .* holding$/ })).toHaveLength(2);
  expect(screen.getByText("$2.77", { exact: false })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Inspect WSOL holding" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inspect SOL holding" }));
  expect(detail("Balance")).toBe("0.026418207 SOL");
  expect(detail("Raw atoms")).toBe("26418207");
  expect(detail("Balance observation slot")).toBe("333989141");
  fireEvent.click(screen.getByRole("button", { name: "Inspect SYN holding" }));
  expect(detail("Balance")).toBe("71.204393 SYN");
  expect(detail("Raw atoms")).toBe("71204393");
  fireEvent.click(screen.getByText("Token snapshot observed", { exact: false }));
  expect(screen.getByText(/Token slot: 333989140/)).toBeVisible();
  expect(data.wrapped_sol_lamports).toBe("0");
  expect(data.wrapped_sol_slot).toBe(333989140);
  expect(request).not.toHaveBeenCalled();
});

it.each([originalStakeBytes, newStakeBytes])("qualifies the recorded empty stake scope only after a manual expansion", async body => {
  const data = stake(body);
  const view = toProtocolView({ resource: "stake", data });
  expect(view.coverage).toMatchObject({ state: "empty", snapshotSlot: data.coverage.snapshot_slot, observedAt: data.coverage.fetched_at });
  expect(view.positions).toEqual([]);
  expect(view.pageValueUsd).toBeNull();
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "https://doxxd.invalid");
    expect(url.pathname).toBe(`/api/wallet/${data.wallet}/stake`);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.has("cursor")).toBe(false);
    return Response.json({ ok: true, data });
  });
  vi.stubGlobal("fetch", request);
  const { container } = render(<ProtocolSection address={data.wallet} resource="stake" mode={{ kind: "live" }} labels={{}} defaultOpen={false} />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand Native staking" }));
  expect(await screen.findByText("No positions were found in this supported scope.")).toBeVisible();
  fireEvent.click(container.querySelector("summary")!);
  expect(detail("Coverage reason")).toBe("native_stake_complete");
  expect(detail("Source coverage complete")).toBe("true");
  expect(screen.getByText(/Scope: native stake program withdrawer/)).toBeVisible();
  expect(screen.queryByText("Data unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Next positions" })).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps holdings and the independent empty stake scan usable without inventing a portfolio total", async () => {
  const data = overview();
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "https://doxxd.invalid");
    expect(url.pathname.startsWith(`/api/wallet/${data.wallet}/`)).toBe(true);
    const resource = url.pathname.split("/").at(-1);
    return Response.json(resource === "overview" ? { ok: true, data } : resource === "stake" ? { ok: true, data: stake() } : { ok: false, kind: "unavailable" });
  });
  vi.stubGlobal("fetch", request);
  const { container } = render(<Portfolio address={data.wallet} />);
  expect(await screen.findByText("Synthetic Token")).toBeVisible();
  expect(container.querySelector(".summary-value")).toHaveTextContent("—");
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.filter(([input]) => new URL(input, "http://test.local").pathname.endsWith("/positions"))).toHaveLength(1);
  // Without a summary every protocol card is collapsed and loads only when opened.
  expect(screen.getByText("Portfolio summary unavailable — open a protocol to check it.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Expand Native staking" })).toHaveAttribute("aria-expanded", "false");
  expect(request).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole("button", { name: "Expand Native staking" }));
  expect(await screen.findByText("No positions were found in this supported scope.")).toBeVisible();
  expect(container.querySelector(".summary-value")).toHaveTextContent("—");
  expect(screen.getByRole("button", { name: "Inspect SYN holding" })).toBeVisible();
  expect(within(container.querySelector("#protocol-stake")!).getByText("—")).toBeVisible();
  expect(request).toHaveBeenCalledTimes(4);
});

it("rejects another recorded wallet's stake response rather than reusing its qualified empty scope", async () => {
  const request = vi.fn(async () => new Response(originalStakeBytes.toString(), { status: 200 }));
  const client = createDmndClient({ DMND_API_BASE_URL: "https://doxxd.invalid/api/v1", DMND_API_KEY: "synthetic-current-wallet-test", DMND_ENABLED_PROTOCOLS: "stake" }, request);
  expect(await client.read(stake().wallet, "stake")).toEqual({ ok: false, kind: "upstream" });
  expect(request).toHaveBeenCalledTimes(1);
});
