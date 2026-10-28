import { expect, it } from "vitest";
import type { ResourceData } from "@/lib/dmnd/contracts";
import { DEMO_ADDRESS, readFixture } from "@/lib/fixtures/wallet";
import {
  avatarStyle,
  formatHeadline,
  headlineLabel,
  statusLine,
} from "./headline";
import { toSummary } from "./model";

const NOW = new Date("2026-01-02T12:00:00Z");

function raw(): ResourceData["summary"] {
  const result = readFixture("summary", "complete");
  if (!result.ok) throw new Error("Summary fixture unavailable");
  return structuredClone(result.data);
}
const view = (data: ResourceData["summary"]) => toSummary(data);
const complete = () => ({ ...raw(), whole_wallet_complete: true, unsupported_scopes: [] });

it("net worth only when whole wallet complete and fresh", () => {
  expect(headlineLabel(view(complete()))).toBe("Net worth");
});

it("known value when partial or stale", () => {
  expect(headlineLabel(view(raw()))).toBe("Known value");
  const stale = complete();
  stale.components[0].coverage_fresh = false;
  expect(headlineLabel(view(stale))).toBe("Known value");
  const excluded = complete();
  Object.assign(excluded.components[1], { included_in_known_total: false, coverage_fresh: false });
  expect(headlineLabel(view(excluded))).toBe("Net worth");
});

it("null value is never zero", () => {
  const data = raw();
  data.known_component_net_value_usd = null;
  expect(formatHeadline(null)).toBe("—");
  expect(formatHeadline("0")).toBe("$0.00");
  expect(statusLine(view(data), NOW)).toEqual({ tone: "partial", text: "Value unavailable" });
});

it("subtotal reports that wallet balances are unavailable", () => {
  const data = raw();
  Object.assign(data.components[0], {
    included_in_known_total: false,
    coverage_status: "native_balance_stale_or_unavailable",
    coverage_complete: false,
    coverage_fresh: false,
  });
  expect(statusLine(view(data), NOW)).toEqual({
    tone: "partial",
    text: "Wallet balances unavailable · showing protocols only",
  });
});

it("subtotal keeps the same text but turns pending while wallet balances update", () => {
  const data = raw();
  Object.assign(data.components[0], {
    included_in_known_total: false,
    coverage_status: "snapshot_queued",
    coverage_complete: false,
    coverage_fresh: false,
  });
  expect(statusLine(view(data), NOW)).toEqual({
    tone: "pending",
    text: "Wallet balances unavailable · showing protocols only",
  });
});

it("counts the sources that are still updating", () => {
  const data = raw();
  data.components[0].coverage_status = "snapshot_queued";
  data.components[1].coverage_status = "running";
  data.components[2].coverage_status = "pending";
  expect(statusLine(view(data), NOW)).toEqual({ tone: "pending", text: "3 sources still updating" });
  const waiting = raw();
  waiting.known_component_net_value_usd = null;
  waiting.components[0].coverage_status = "queued";
  expect(statusLine(view(waiting), NOW)).toEqual({ tone: "pending", text: "1 sources still updating" });
});

it("saved data names the oldest stale included observation in UTC", () => {
  const data = raw();
  data.components[0].coverage_fresh = false;
  const older = new Date("2026-01-02T09:05:00Z");
  expect(statusLine(view(data), NOW, older)).toEqual({
    tone: "saved",
    text: "Saved data from 09:05 UTC",
  });
});

it("saved data without a usable observation time makes no time claim", () => {
  const data = raw();
  data.components[0].coverage_fresh = false;
  const future = new Date("2026-01-02T13:00:00Z");
  for (const at of [undefined, null, new Date("nope"), future]) {
    expect(statusLine(view(data), NOW, at)).toEqual({
      tone: "saved",
      text: "Saved data from an earlier update",
    });
  }
});

it("a complete and fresh wallet reads updated just now", () => {
  expect(statusLine(view(complete()), NOW)).toEqual({ tone: "ready", text: "Updated just now" });
});

it("anything else reads some values unavailable", () => {
  expect(statusLine(view(raw()), NOW)).toEqual({ tone: "partial", text: "Some values unavailable" });
});

it("avatar is deterministic per address", () => {
  const a = avatarStyle(DEMO_ADDRESS);
  expect(avatarStyle(DEMO_ADDRESS)).toEqual(a);
  expect(a.background).toMatch(/^conic-gradient\(/);
  expect(a.background).toContain("var(--accent)");
  expect(a.background).toContain("var(--violet)");
  expect(avatarStyle("SyntheticWalletAddress000000000000000000002")).not.toEqual(a);
});
