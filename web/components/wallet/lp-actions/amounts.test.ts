import { expect, it, vi } from "vitest";

// formatAmount returns null for unparsable input. atomsToUi output is normally
// always parsable, so the guard is exercised by forcing that null.
vi.mock("@/lib/decimal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/decimal")>()),
  formatAmount: () => null,
}));

import { formatAtoms } from "./amounts";

it("falls back to raw atoms when the scaled amount cannot be formatted, never printing null", () => {
  const text = formatAtoms("mint", "1500000", () => ({ decimals: 6, name: "SYNA" }));
  expect(text).toBe("1500000 raw atoms SYNA");
  expect(text).not.toContain("null");
});
