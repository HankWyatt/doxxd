// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as stub from "./stub";

describe("build stub", () => {
  it("exports the same names as the real entry, each throwing if called", async () => {
    const real = await import("./index");
    expect(Object.keys(stub).sort()).toEqual(Object.keys(real).sort());
    for (const value of Object.values(stub)) {
      expect(() => (value as () => unknown)()).toThrow(/browser/);
    }
  }, 30_000);
});
