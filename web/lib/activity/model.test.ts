import { expect, it } from "vitest";
import { readFixture } from "../fixtures/wallet";
import { toTransactionView } from "./model";
it("labels observed evidence without inferring wallet ownership or swaps from SOL deltas", () => {
  const raw = readFixture("transactions", "complete");
  if (!raw.ok) throw Error("fixture");
  expect(raw.data.data.map((row) => toTransactionView(row).label)).toEqual([
    "Observed executions",
    "Observed transfers",
    "Balance changes",
    "Network fee",
  ]);
  expect(toTransactionView(raw.data.data[0]).source.fee?.succeeded).toBe(true);
  expect(toTransactionView(raw.data.data[1]).source.fee).toBeNull();
});
it("retains one transaction card for multiple execution legs and carries truncation", () => {
  const raw = readFixture("transactions", "truncated");
  if (!raw.ok) throw Error("fixture");
  const row = raw.data.data[0];
  row.observed_trades.push({ ...row.observed_trades[0], instruction_index: 2 });
  const view = toTransactionView(row);
  expect(view.signature).toBe(row.signature);
  expect(view.source.trades_truncated).toBe(true);
  expect(view.source.observed_trades).toHaveLength(2);
});
