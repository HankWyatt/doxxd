import { expect, it } from "vitest";
import { readFixture, DEMO_ADDRESS } from "./wallet";
import { normalizeAddress } from "../address";
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
