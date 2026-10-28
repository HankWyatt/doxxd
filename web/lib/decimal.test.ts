import { expect, it } from "vitest";
import {
  formatUsd,
  formatPrice,
  formatAmount,
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
