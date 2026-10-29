import { expect, it } from "vitest";
import { resourceResponse } from "./http";

it("keeps HTTP 503 for a source that is not enabled and keeps its kind in the body", async () => {
  const response = resourceResponse({ ok: false, kind: "not_enabled" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, kind: "not_enabled" });
  expect(resourceResponse({ ok: false, kind: "unavailable" }).status).toBe(503);
});
