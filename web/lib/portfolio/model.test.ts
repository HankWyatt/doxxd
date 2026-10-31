import { expect, it } from "vitest";
import { readFixture } from "../fixtures/wallet";
import { validResourcePayload } from "../dmnd/validation.server";
import { toSummary, toProtocolView, type ProtocolPayload } from "./model";
it("uses the upstream summary verbatim rather than adding receipt and position rows", () => {
  const r = readFixture("summary", "complete");
  if (!r.ok) throw Error("fixture");
  const v = toSummary(r.data);
  expect(v.valueUsd).toBe("12345.67");
  expect(v.label).toBe("Known portfolio value");
  expect(v.complete).toBe(false);
});
it("retains unknown debt quantities and underlying source status", () => {
  const r = readFixture("kamino", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data[0].debts[0].ui_amount = null;
  r.data.data[0].debts[0].value_usd = null;
  const v = toProtocolView({ resource: "kamino", data: r.data });
  expect(v.positions[0]?.debts[0]?.amount).toBeNull();
  expect(v.positions[0]?.debts[0]?.valueUsd).toBeNull();
});
it("keeps LP page value distinct and reward counters in raw units", () => {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  const v = toProtocolView({ resource: "orca", data: r.data });
  expect(v.pageValueUsd).toBe("1645.67");
  expect(v.positions[0]?.valueUsd).toBeNull();
  expect(v.positions[0]?.rewards[0]?.qualifier).toMatch(/raw atoms/i);
});
it("does not turn reference liquid-staking claims into additive assets", () => {
  const r = readFixture("liquid-staking", "complete");
  if (!r.ok) throw Error("fixture");
  const v = toProtocolView({ resource: "liquid-staking", data: r.data });
  expect(
    v.positions[0]?.details.some((d) => /already included/i.test(d.value)),
  ).toBe(true);
});
it("does not fabricate Drift equity", () => {
  const r = readFixture("drift", "complete");
  if (!r.ok) throw Error("fixture");
  const v = toProtocolView({ resource: "drift", data: r.data });
  expect(v.pageValueUsd).toBeNull();
});
it("shows a farm deposit when its optional backing principal is absent", () => {
  const r = readFixture("raydium-farms", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data = [
    {
      ledger: "farm-ledger",
      context_slot: 1,
      version: 6,
      status: "observed",
      principal_value_reason: "unqualified_backing",
      rewards: [],
      sources: [],
      withdrawal_verified: false,
      deposited_ui_amount: "12",
    },
  ];
  const v = toProtocolView({ resource: "raydium-farms", data: r.data });
  expect(v.positions[0]?.assets[0]?.amount).toBe("12");
  expect(v.positions[0]?.valueUsd).toBeNull();
});

it.each(["orca", "raydium-clmm", "meteora"] as const)(
  "%s does not infer scope emptiness from a page when its source reports positions",
  (resource) => {
    const r = readFixture(resource, "complete");
    if (!r.ok) throw Error("fixture");
    r.data.data = [];
    r.data.coverage.total_positions = 3;
    r.data.page_known_principal_value_usd = "0";
    expect(validResourcePayload(resource, r.data)).toBe(true);
    const original = structuredClone(r.data);
    const view = toProtocolView({ resource, data: r.data } as ProtocolPayload);
    expect(view.positions).toHaveLength(0);
    expect(view.coverage.state).toBe("ready");
    expect(view.totalPositions).toBe(3);
    expect(view.pageValueUsd).toBe("0");
    expect(view.coverage.snapshotSlot).toBe(r.data.coverage.snapshot_slot);
    expect(r.data).toEqual(original);
  },
);

it("does not use an invalid admitted inventory count to prove an empty scope", () => {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data = [];
  r.data.coverage.total_positions = -1;
  expect(validResourcePayload("orca", r.data)).toBe(true);
  const view = toProtocolView({ resource: "orca", data: r.data });
  expect(view.totalPositions).toBeNull();
  expect(view.coverage.state).toBe("ready");
});

it("does not infer an empty scope from an empty terminal continuation without an inventory count", () => {
  const r = readFixture("kamino", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data = [];
  expect(validResourcePayload("kamino", r.data)).toBe(true);
  const view = toProtocolView(
    { resource: "kamino", data: r.data },
    { isContinuation: true },
  );
  expect(view.positions).toHaveLength(0);
  expect(view.coverage.state).toBe("ready");
  expect(view.totalPositions).toBeNull();
});

it("retains genuinely empty fresh complete first-page scope evidence", () => {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data = [];
  r.data.coverage.total_positions = 0;
  r.data.page_known_principal_value_usd = "0";
  expect(validResourcePayload("orca", r.data)).toBe(true);
  const view = toProtocolView({ resource: "orca", data: r.data });
  expect(view.coverage.state).toBe("empty");
  expect(view.totalPositions).toBe(0);
});

it.each(["raydium-cpmm", "raydium-amm-v4", "raydium-farms"] as const)(
  "%s does not interpret candidate counts as position counts",
  (resource) => {
    const r = readFixture(resource, "complete");
    if (!r.ok) throw Error("fixture");
    r.data.coverage.total_candidates = 3;
    expect(validResourcePayload(resource, r.data)).toBe(true);
    const view = toProtocolView({ resource, data: r.data } as ProtocolPayload);
    expect(view.coverage.state).toBe("empty");
    expect(view.totalPositions).toBeNull();
  },
);

it.each([null, "", " \t "])(
  "retains rows and reported continuation when the next cursor is unusable: %j",
  (cursor) => {
    const r = readFixture("orca", "complete");
    if (!r.ok) throw Error("fixture");
    r.data.has_more = true;
    r.data.cursor = cursor;
    expect(validResourcePayload("orca", r.data)).toBe(true);
    const original = structuredClone(r.data);
    const view = toProtocolView({ resource: "orca", data: r.data });
    expect(view.hasMore).toBe(true);
    expect(view.continuationUnavailable).toBe(true);
    expect(view.cursor).toBe(cursor);
    expect(view.positions).toHaveLength(r.data.data.length);
    expect(view.pageValueUsd).toBe(r.data.page_known_principal_value_usd);
    expect(view.coverage.state).toBe("partial");
    expect(r.data).toEqual(original);
  },
);

it("preserves an opaque usable cursor exactly", () => {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.has_more = true;
  r.data.cursor = "  opaque:+/cursor  ";
  expect(validResourcePayload("orca", r.data)).toBe(true);
  const view = toProtocolView({ resource: "orca", data: r.data });
  expect(view.cursor).toBe(r.data.cursor);
  expect(view.continuationUnavailable).toBe(false);
});

it.each(["pending", "partial", "stale"] as const)(
  "retains %s source coverage on an empty page",
  (scenario) => {
    const r = readFixture("orca", scenario);
    if (!r.ok) throw Error("fixture");
    r.data.data = [];
    expect(validResourcePayload("orca", r.data)).toBe(true);
    const view = toProtocolView(
      { resource: "orca", data: r.data },
      { isContinuation: true },
    );
    expect(view.coverage.state).toBe(
      scenario === "pending" ? "pending" : scenario,
    );
  },
);

it("does not turn a disabled empty page into fresh or empty scope evidence", () => {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data = [];
  r.data.coverage.complete = false;
  r.data.coverage.fresh = false;
  r.data.coverage.status = "disabled";
  r.data.coverage.reason = "liquidity_scan_disabled";
  expect(validResourcePayload("orca", r.data)).toBe(true);
  const view = toProtocolView(
    { resource: "orca", data: r.data },
    { isContinuation: true },
  );
  expect(view.coverage.state).toBe("unavailable");
  expect(view.totalPositions).toBe(1);
});

it.each([
  "stake",
  "liquid-staking",
  "kamino",
  "solend",
  "marginfi",
  "raydium-cpmm",
  "raydium-amm-v4",
  "raydium-farms",
  "drift",
  "velocity",
] as const)("ignores same-name inventory extensions on %s", (resource) => {
  const r = readFixture(resource, "complete");
  if (!r.ok) throw Error("fixture");
  const baseline = toProtocolView({ resource, data: r.data } as ProtocolPayload);
  for (const extension of [{ unexpected: "value" }, 9]) {
    const data = {
      ...r.data,
      coverage: { ...r.data.coverage, total_positions: extension },
    };
    expect(validResourcePayload(resource, data)).toBe(true);
    const original = structuredClone(data);
    const view = toProtocolView({ resource, data } as ProtocolPayload);
    expect(view.totalPositions).toBeNull();
    expect(view.positions).toEqual(baseline.positions);
    expect(view.coverage).toEqual(baseline.coverage);
    expect(data).toEqual(original);
  }
});

it.each(["orca", "raydium-clmm", "meteora"] as const)(
  "%s retains only safe nonnegative integer inventory counts",
  (resource) => {
    const r = readFixture(resource, "complete");
    if (!r.ok) throw Error("fixture");
    for (const count of [0, 3, Number.MAX_SAFE_INTEGER]) {
      r.data.coverage.total_positions = count;
      expect(validResourcePayload(resource, r.data)).toBe(true);
      const view = toProtocolView({ resource, data: r.data } as ProtocolPayload);
      expect(view.totalPositions).toBe(count);
    }
    for (const count of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      r.data.coverage.total_positions = count;
      expect(validResourcePayload(resource, r.data)).toBe(count === -1);
      const view = toProtocolView({ resource, data: r.data } as ProtocolPayload);
      expect(view.totalPositions).toBeNull();
    }
  },
);

it.each([
  { has_more: true, cursor: { unrelated: "extension" } },
  { has_more: true, cursor: "unrelated-cursor" },
  { has_more: { unrelated: "extension" }, cursor: null },
])("ignores pagination extensions on unpaged liquid receipts: %j", (extension) => {
  const r = readFixture("liquid-staking", "complete");
  if (!r.ok) throw Error("fixture");
  const baseline = toProtocolView({ resource: "liquid-staking", data: r.data });
  const data = { ...r.data, ...extension };
  expect(validResourcePayload("liquid-staking", data)).toBe(true);
  const original = structuredClone(data);
  const view = toProtocolView({ resource: "liquid-staking", data });
  expect(view.positions).toEqual(baseline.positions);
  expect(view.coverage).toEqual(baseline.coverage);
  expect(view.hasMore).toBe(false);
  expect(view.cursor).toBeNull();
  expect(view.continuationUnavailable).toBe(false);
  expect(data).toEqual(original);
});

it.each([
  "stake",
  "kamino",
  "solend",
  "marginfi",
  "orca",
  "raydium-clmm",
  "meteora",
  "raydium-cpmm",
  "raydium-amm-v4",
  "raydium-farms",
  "drift",
  "velocity",
] as const)("retains the admitted pagination fields for %s", (resource) => {
  const r = readFixture(resource, "complete");
  if (!r.ok) throw Error("fixture");
  r.data.has_more = true;
  r.data.cursor = resource + ":opaque+/cursor";
  expect(validResourcePayload(resource, r.data)).toBe(true);
  const original = structuredClone(r.data);
  const view = toProtocolView({ resource, data: r.data } as ProtocolPayload);
  expect(view.hasMore).toBe(true);
  expect(view.cursor).toBe(r.data.cursor);
  expect(view.continuationUnavailable).toBe(false);
  expect(r.data).toEqual(original);
});

it("does not trim a malformed paged cursor when adapting without gateway validation", () => {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  const data = {
    ...r.data,
    has_more: true,
    cursor: { malformed: "not an admitted cursor" },
  };
  expect(validResourcePayload("orca", data)).toBe(false);
  const view = toProtocolView({ resource: "orca", data } as unknown as ProtocolPayload);
  expect(view.positions).toHaveLength(r.data.data.length);
  expect(view.hasMore).toBe(true);
  expect(view.cursor).toBeNull();
  expect(view.continuationUnavailable).toBe(true);
});

function pagedOrca(patch: (d: ReturnType<typeof orcaData>) => void) {
  const data = orcaData();
  data.has_more = true;
  data.cursor = "synthetic-next";
  patch(data);
  return toProtocolView({ resource: "orca", data });
}
function orcaData() {
  const r = readFixture("orca", "complete");
  if (!r.ok) throw Error("fixture");
  return r.data;
}

it("labels a complete, fresh multi-page scan as current and notes the page boundary with the source total", () => {
  const view = pagedOrca((d) => {
    d.coverage.total_positions = 137;
  });
  const n = view.positions.length;
  expect(view.coverage.state).toBe("ready");
  expect(view.coverage.label).toBe("Current snapshot");
  expect(view.pageNote).toBe(
    `Showing ${n} of 137 positions. More on the next page.`,
  );
});

it("notes the page boundary without a total when the resource gives none", () => {
  const r = readFixture("raydium-cpmm", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.has_more = true;
  r.data.cursor = "synthetic-next";
  const view = toProtocolView({ resource: "raydium-cpmm", data: r.data });
  expect(view.totalPositions).toBeNull();
  expect(view.coverage.label).toBe("Current snapshot");
  expect(view.pageNote).toBe(
    `Showing ${view.positions.length} positions. More on the next page.`,
  );
});

it("does not establish an empty scope from an empty page that has more pages", () => {
  const r = readFixture("raydium-cpmm", "complete");
  if (!r.ok) throw Error("fixture");
  r.data.data = [];
  r.data.has_more = true;
  r.data.cursor = "synthetic-next";
  const view = toProtocolView({ resource: "raydium-cpmm", data: r.data });
  expect(view.coverage.state).toBe("ready");
  expect(view.coverage.label).not.toBe("No positions");
});

it("keeps the partial warning for an incomplete multi-page scan", () => {
  const view = pagedOrca((d) => {
    d.coverage.complete = false;
  });
  expect(view.coverage.state).toBe("partial");
  expect(view.pageNote).toBeNull();
});

it("keeps the saved-snapshot label for a stale multi-page scan", () => {
  const view = pagedOrca((d) => {
    d.coverage.fresh = false;
  });
  expect(view.coverage.state).toBe("stale");
  expect(view.pageNote).toBeNull();
});

it("has no page note on a single complete page", () => {
  const view = toProtocolView({ resource: "orca", data: orcaData() });
  expect(view.coverage.state).toBe("ready");
  expect(view.pageNote).toBeNull();
});
