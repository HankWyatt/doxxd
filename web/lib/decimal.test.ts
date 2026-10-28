import { expect, it } from "vitest";
import {
  formatUsd,
  formatPrice,
  formatAmount,
  formatCompactAmount,
  compareDecimalDesc,
} from "./decimal";
it("shows meaningful sub-cent token prices without rounding them to zero", () => {
  expect(formatPrice("0.00002")).toBe("$0.00002");
  expect(formatPrice("0.000000000003123456")).toBe("$0.0000000000031235");
  expect(formatPrice("0.4")).toBe("$0.40");
  expect(formatPrice("150")).toBe("$150.00");
  expect(formatPrice(null)).toBe("—");
});
it.each([
  ["9007199254740993.12", "$9,007,199,254,740,993.12"],
  ["-12.34", "-$12.34"],
  ["0.001", "<$0.01"],
  ["-0.001", "-<$0.01"],
  ["0", "$0.00"],
  [null, "—"],
  ["NaN", "—"],
  ["Infinity", "—"],
])("formats exact dollars %s", (v, want) => expect(formatUsd(v)).toBe(want));
it("sorts large exact values and places unknowns last", () => {
  const values = [null, "9007199254740992.01", "9007199254740992.02", "-2"];
  expect(values.sort(compareDecimalDesc)).toEqual([
    "9007199254740992.02",
    "9007199254740992.01",
    "-2",
    null,
  ]);
});
it("preserves token precision and avoids falsely rounding tiny balances to zero", () => {
  expect(formatAmount("10000000")).toBe("10,000,000");
  expect(formatAmount("0.000000001")).toBe("<0.000001");
  expect(formatAmount("1.230000")).toBe("1.23");
});
it.each([
  ["1000", "1K"],
  ["1250", "1.25K"],
  ["1234567", "1.23M"],
  ["9876543210", "9.88B"],
  ["1000000000000", "1,000B"],
  ["-1250", "-1.25K"],
  ["90071992547409925000000", "90,071,992,547,409.93B"],
])("compacts exact token quantities %s", (value, want) => {
  expect(formatCompactAmount(value)).toBe(want);
});
it("retains accepted significant digits beyond the ordinary decimal context", () => {
  const wholeBillions = "1234567890".repeat(15);
  expect(formatCompactAmount(wholeBillions + "125000000").replaceAll(",", ""))
    .toBe(wholeBillions + ".13B");
});
it.each([
  ["999994", "999.99K"],
  ["999995", "1M"],
  ["999994999", "999.99M"],
  ["999995000", "1B"],
  ["-999995000", "-1B"],
])("promotes rounded compact quantities at suffix boundaries %s", (value, want) => {
  expect(formatCompactAmount(value)).toBe(want);
});
it.each(["0", "-0", "47.183920517", "999.999999", "0.000000001", "-0.000000001"])(
  "retains ordinary quantity formatting below one thousand %s",
  (value) => expect(formatCompactAmount(value)).toBe(formatAmount(value)),
);
it.each([null, undefined, "", " ", "NaN", "Infinity", "not a quantity", "1".repeat(513)])(
  "keeps unavailable compact quantities unknown %s",
  (value) => expect(formatCompactAmount(value)).toBe("—"),
);
