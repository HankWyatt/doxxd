import { describe, expect, it } from "vitest";
import { headerWalletState } from "./header-state";

describe("headerWalletState", () => {
  it("is disconnected with no connected wallet", () => {
    expect(headerWalletState("A", null)).toBe("disconnected");
  });
  it("is own when the connected wallet is the viewed one", () => {
    expect(headerWalletState("A", "A")).toBe("own");
  });
  it("is other when the connected wallet differs from the viewed one", () => {
    expect(headerWalletState("A", "B")).toBe("other");
  });
});
