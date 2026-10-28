import { expect, it } from "vitest";
import { parseResourceQuery } from "./query";
it("preserves opaque cursors and validates supported fields", () => {
  expect(
    parseResourceQuery(
      "transactions",
      new URLSearchParams("cursor=a%2Bb%2F%3D&limit=25"),
    ),
  ).toEqual({ cursor: "a+b/=", limit: 25 });
  expect(
    parseResourceQuery("orca", new URLSearchParams("protocol=evil")),
  ).toBeNull();
  expect(
    parseResourceQuery("summary", new URLSearchParams("limit=50")),
  ).toBeNull();
});
it("honors the transaction cap independently from raw activity and protocol rows", () => {
  expect(
    parseResourceQuery("transactions", new URLSearchParams("limit=26")),
  ).toBeNull();
  expect(
    parseResourceQuery("transactions", new URLSearchParams("limit=50")),
  ).toBeNull();
  expect(
    parseResourceQuery("activity", new URLSearchParams("limit=100")),
  ).toEqual({ limit: 100 });
  expect(parseResourceQuery("orca", new URLSearchParams("limit=100"))).toEqual({
    limit: 100,
  });
});
it.each([
  "limit=0",
  "limit=1.5",
  "limit=101",
  "limit=1&limit=2",
  "from=yesterday",
  "from=2026-10-22T00:00:00Z&to=2026-10-01T00:00:00Z",
  "from=2026-02-30T00:00:00Z",
])("rejects invalid pagination/window %s", (params) =>
  expect(
    parseResourceQuery("transactions", new URLSearchParams(params)),
  ).toBeNull(),
);
it("accepts valid explicit time bounds", () =>
  expect(
    parseResourceQuery(
      "activity",
      new URLSearchParams("from=2026-10-01T00:00:00Z&to=2026-10-22T00:00:00Z"),
    ),
  ).toEqual({ from: "2026-10-01T00:00:00Z", to: "2026-10-22T00:00:00Z" }));
