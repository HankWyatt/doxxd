import { expect, it } from "vitest";
import { activityHref, parseActivityWindow } from "./window";
import { DEMO_ADDRESS } from "../fixtures/wallet";
it("preserves opaque cursors and explicit bounds in shareable links", () => {
  const window = { from: "2026-10-01T00:00:00Z", to: "2026-10-22T00:00:00Z" };
  const next = new URL(
    activityHref(DEMO_ADDRESS, window, "a+b/="),
    "https://doxxd.test",
  );
  expect(next.searchParams.get("cursor")).toBe("a+b/=");
  expect(next.searchParams.get("from")).toBe(window.from);
  expect(next.searchParams.get("to")).toBe(window.to);
  expect(
    new URL(
      activityHref(DEMO_ADDRESS, window),
      "https://doxxd.test",
    ).searchParams.has("cursor"),
  ).toBe(false);
});
it.each([
  "from=yesterday",
  "from=2026-10-22T00:00:00Z&to=2026-10-01T00:00:00Z",
  "from=2026-10-01T00:00:00Z&from=2026-10-02T00:00:00Z",
])("rejects invalid windows %s", (value) =>
  expect(parseActivityWindow(new URLSearchParams(value))).toBeNull(),
);
it("normalizes explicit offsets to UTC and permits a genuinely unbounded window", () => {
  expect(
    parseActivityWindow(
      new URLSearchParams("from=2026-10-01T02%3A00%3A00%2B02%3A00"),
    ),
  ).toEqual({ from: "2026-10-01T00:00:00.000Z" });
  expect(parseActivityWindow(new URLSearchParams())).toEqual({});
});
it("binds fallback cursors to their source on the wallet activity route", () => {
  const href = activityHref(DEMO_ADDRESS, {}, "next", undefined, "activity");
  const url = new URL(href, "https://doxxd.test");
  expect(url.pathname).toBe("/wallet/" + DEMO_ADDRESS + "/activity");
  expect(url.searchParams.get("source")).toBe("activity");
  expect(url.searchParams.get("cursor")).toBe("next");
  expect(url.searchParams.has("scenario")).toBe(false);
  expect(url.searchParams.has("tab")).toBe(false);
});
