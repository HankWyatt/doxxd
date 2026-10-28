import { expect, it } from "vitest";
import { coverageView } from "./coverage";
const base = {
  complete: true,
  fresh: true,
  status: "complete",
  rowCount: 0,
  scope: "native stake",
};
it("reserves empty for a complete fresh scoped inventory", () => {
  expect(coverageView(base).state).toBe("empty");
  expect(
    coverageView({ ...base, complete: false, status: "queued" }).state,
  ).toBe("pending");
  expect(coverageView({ ...base, fresh: false, status: "stale" }).state).toBe(
    "stale",
  );
  expect(coverageView({ ...base, fresh: undefined }).state).toBe("partial");
});
it("does not erase known positions when a source is partial", () => {
  expect(
    coverageView({ ...base, complete: false, rowCount: 2, status: "partial" })
      .state,
  ).toBe("partial");
});
