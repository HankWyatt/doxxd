import { expect, it } from "vitest";
import { readFixture } from "./fixtures/wallet";
import { formatSignedUsd, indexedPnl, pnlTone } from "./indexed-trading";
import type { Schemas } from "./dmnd/contracts";

function position(): Schemas["WalletPosition"] {
  const fixture = readFixture("positions", "complete");
  if (!fixture.ok) throw Error("fixture");
  return {
    ...fixture.data.data[0],
    avg_buy_price_usd: "0.4",
    total_pnl_usd: "15.25",
    realized_pnl_usd: "-4.75",
    unrealized_pnl_usd: "20",
  };
}

it("formats signed source values without converting to binary floating point", () => {
  expect(formatSignedUsd("9007199254740993.25")).toBe("+$9,007,199,254,740,993.25");
  expect(formatSignedUsd("-4.75")).toBe("-$4.75");
  expect(formatSignedUsd("0")).toBe("$0.00");
  expect(formatSignedUsd(null)).toBeNull();
  expect(pnlTone("-0")).toBe("");
  expect(pnlTone("invalid")).toBe("");
});

it("passes source estimates through without deriving cost basis or adding components", () => {
  const source = position();
  expect(indexedPnl(source)).toEqual({
    total: "15.25", realized: "-4.75", unrealized: "20", unavailableReason: null,
  });
  source.total_pnl_usd = null;
  source.unrealized_pnl_usd = null;
  expect(indexedPnl(source)).toMatchObject({ total: null, unrealized: null, realized: "-4.75" });
});

it("does not turn legacy zero profit into a known result without a priced buy basis", () => {
  const source = position();
  source.realized_pnl_usd = "0";
  source.bought = { amount: "0", usd: "0", sol: "0", count: 0 };
  expect(indexedPnl(source)).toEqual({
    total: null, realized: null, unrealized: null,
    unavailableReason: "A priced indexed buy basis is unavailable.",
  });
  source.bought.count = 3;
  // Legacy totals can be zero when none of the indexed fills was priced.
  source.bought.usd = "0";
  expect(indexedPnl(source).total).toBeNull();
});

it("withholds partially priced estimates but retains source trade totals elsewhere", () => {
  const source = position();
  source.unpriced_trades = 1;
  const original = structuredClone(source);
  expect(indexedPnl(source)).toMatchObject({
    total: null, realized: null, unrealized: null,
    unavailableReason: "Some indexed trades have missing prices.",
  });
  expect(source).toEqual(original);
});
