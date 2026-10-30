import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { readFixture } from "@/lib/fixtures/wallet";
import { Holdings } from "./holdings";
import { WalletSummary } from "./summary";

// A safety net for the unknown-value formatters (which return null): whatever
// is unknown must render as blank/"Unknown", never as the words below.
const LEAKS = /\bnull\b|\bundefined\b|\bNaN\b/;

it("holdings with every price, value and estimate unknown never print null or undefined", () => {
  const result = readFixture("overview", "complete");
  if (!result.ok) throw new Error("Fixture");
  const data = result.data;
  data.assets = data.assets.map((asset) => ({
    ...asset,
    price_usd: null,
    value_usd: null,
    estimated_value_usd: null,
    price_updated_at: null,
  }));
  data.known_value_usd = null as never;
  data.sol_price_usd = null;
  data.native_sol_value_usd = null as never;
  render(<Holdings overview={data} />);
  for (const button of screen.queryAllByRole("button", { name: /^Inspect .*holding$/ })) {
    fireEvent.click(button);
  }
  expect(document.body.textContent).not.toMatch(LEAKS);
  expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
});

it("a summary with every component value unknown never prints null or undefined", () => {
  const result = readFixture("summary", "complete");
  if (!result.ok) throw new Error("Fixture");
  const data = result.data;
  data.components = data.components.map((c) => ({
    ...c,
    known_net_value_usd: null,
  }));
  render(<WalletSummary result={{ ok: true, data }} loading={false} retry={vi.fn()} />);
  expect(document.body.textContent).not.toMatch(LEAKS);
});
