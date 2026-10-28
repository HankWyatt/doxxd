import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Portfolio } from "./portfolio";
import { readFixture, DEMO_ADDRESS } from "@/lib/fixtures/wallet";
import type { ResourceName } from "@/lib/dmnd/contracts";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
afterEach(() => vi.unstubAllGlobals());
function network(summaryError = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://doxxd.test");
      const resource = url.pathname.split("/").at(-1) as ResourceName;
      return new Response(
        JSON.stringify(
          summaryError && resource === "summary"
            ? { ok: false, kind: "configuration" }
            : readFixture(resource, "protocol-error"),
        ),
      );
    }),
  );
}
it("shows holdings and protocol detail without changing the authoritative headline", async () => {
  network();
  render(
    <Portfolio
      address={DEMO_ADDRESS}
      mode={{ kind: "demo", scenario: "protocol-error" }}
    />,
  );
  expect(await screen.findByText("$12,345.67")).toBeVisible();
  expect(await screen.findByText("USD Coin")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /expand kamino/i }));
  expect(await screen.findByText("Lending position")).toBeVisible();
  expect(screen.getByText("$12,345.67")).toBeVisible();
});
it("keeps holdings usable when the summary fails", async () => {
  network(true);
  render(<Portfolio address={DEMO_ADDRESS} />);
  expect(await screen.findByText("USD Coin")).toBeVisible();
  expect(await screen.findByText("Data connection unavailable")).toBeVisible();
});
it("isolates a protocol failure from the rest of the wallet", async () => {
  network();
  render(
    <Portfolio
      address={DEMO_ADDRESS}
      mode={{ kind: "demo", scenario: "protocol-error" }}
    />,
  );
  await screen.findByText("$12,345.67");
  fireEvent.click(screen.getByRole("button", { name: /expand orca/i }));
  expect(await screen.findByText("Couldn’t load this section")).toBeVisible();
  expect(screen.getByText("USD Coin")).toBeVisible();
});

it("mounts summary navigation targets even when a component is excluded from the known total", async () => {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    const result = readFixture(resource, "complete");
    if (resource === "summary" && result.ok) {
      const summary = readFixture("summary", "complete");
      if (!summary.ok) throw Error("fixture");
      summary.data.components.push({
        ...summary.data.components[1],
        id: "liquid_staking_receipts",
        source_path: "liquid-staking",
        known_asset_value_usd: "1650",
        known_debt_value_usd: "0",
        known_net_value_usd: "1650",
        included_in_known_total: false,
        reason: "direct_receipt_overlap",
      });
      expect(validResourcePayload("summary", summary.data)).toBe(true);
      return Response.json(summary);
    }
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<Portfolio address={DEMO_ADDRESS} />);
  const reference = await screen.findByRole("link", { name: /Liquid staking/ });
  expect(reference).toHaveAttribute("href", "#protocol-liquid-staking");
  expect(document.getElementById("protocol-liquid-staking")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Expand Liquid staking" }))
    .toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("$12,345.67")).toBeVisible();
  expect(fetcher.mock.calls).toHaveLength(2);
  expect(fetcher.mock.calls.every(([input]) => !input.includes("/liquid-staking"))).toBe(true);
});
