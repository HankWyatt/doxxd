import { expect, it } from "vitest";
import { readFixture, DEMO_ADDRESS, MINTS } from "./wallet";
import { normalizeAddress } from "../address";
import { validResourcePayload } from "../dmnd/validation.server";
it("uses valid synthetic wallet data and preserves the authoritative summary", () => {
  expect(normalizeAddress(DEMO_ADDRESS)).toBe(DEMO_ADDRESS);
  const r = readFixture("summary", "complete");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.data.known_component_net_value_usd).toBe("12345.67");
});
it("pending never supplies a fabricated known portfolio value", () => {
  const r = readFixture("summary", "pending");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.data.known_component_net_value_usd).toBeNull();
});
it("empty and complete are independent fixture copies", () => {
  const empty = readFixture("overview", "empty");
  const complete = readFixture("overview", "complete");
  expect(empty.ok && complete.ok).toBe(true);
  if (empty.ok && complete.ok) {
    expect(empty.data.assets).toHaveLength(0);
    expect(complete.data.assets.length).toBeGreaterThan(0);
  }
});
it("retains empty activity pages that have a continuation", () => {
  const r = readFixture("transactions", "activity-continuation");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.data.data).toHaveLength(0);
    expect(r.data.has_more).toBe(true);
    expect(r.data.cursor).toBe("demo-next");
  }
});
it("keeps positions scoped to indexed trades without adding inventory coverage", () => {
  const result = readFixture("positions", "complete");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(validResourcePayload("positions", result.data)).toBe(true);
  expect(result.data.positions_since).toBe("2026-10-22T18:30:00Z");
  expect(result.data).not.toHaveProperty("coverage");
  expect(result.data.data.map((row) => row.mint)).toEqual([MINTS.jup]);
  expect(result.data.data.map((row) => row.mint)).not.toContain(MINTS.usdc);
  expect(result.data.data[0].bought.count).toBe(1);
  expect(result.data.data[0].sold.count).toBe(0);
});
it.each(["pending", "empty"] as const)(
  "supplies a schema-valid empty positions fixture for %s",
  (scenario) => {
    const result = readFixture("positions", scenario);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validResourcePayload("positions", result.data)).toBe(true);
    expect(result.data.data).toHaveLength(0);
    expect(result.data.position_count).toBe(0);
  },
);
