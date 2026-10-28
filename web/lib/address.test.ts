import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { normalizeAddress, walletHref } from "./address";
describe("public address input", () => {
  it("trims whitespace and accepts any 32 bytes, including non-curve keys", () => {
    expect(normalizeAddress(" 11111111111111111111111111111111 ")).toBe(
      "11111111111111111111111111111111",
    );
    const key = bs58.encode(new Uint8Array(32).fill(255));
    expect(normalizeAddress(key)).toBe(key);
  });
  it.each([
    "",
    "O0Il",
    bs58.encode(new Uint8Array(31)),
    bs58.encode(new Uint8Array(33)),
  ])("rejects invalid key %s", (input) =>
    expect(normalizeAddress(input)).toBeNull(),
  );
  it("keeps activity as a shareable address route", () =>
    expect(walletHref("11111111111111111111111111111111", "activity")).toBe(
      "/wallet/11111111111111111111111111111111/activity",
    ));
});
