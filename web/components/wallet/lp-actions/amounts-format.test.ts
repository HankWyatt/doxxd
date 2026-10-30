import { expect, it } from "vitest";
import { formatAtoms } from "./amounts";

it("formats atoms with known decimals and keeps raw atoms without them", () => {
  expect(formatAtoms("mint", "1500000", () => ({ decimals: 6, name: "SYNA" }))).toBe("1.5 SYNA");
  expect(formatAtoms("mint", "7", () => ({ decimals: null, name: "SYNA" }))).toBe("7 raw atoms SYNA");
});
