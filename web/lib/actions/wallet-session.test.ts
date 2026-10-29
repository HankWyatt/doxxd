import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetWallet,
  isSolanaSigner,
  readRememberedWallet,
  rememberWallet,
  signTransactionBytes,
} from "./wallet-session";

describe("remembered wallet", () => {
  beforeEach(() => window.localStorage.clear());
  it("round-trips and forgets", () => {
    expect(readRememberedWallet()).toBeNull();
    rememberWallet("Phantom");
    expect(readRememberedWallet()).toBe("Phantom");
    forgetWallet();
    expect(readRememberedWallet()).toBeNull();
  });
  it("ignores corrupt data", () => {
    window.localStorage.setItem("doxxd.wallet.v1", "{nope");
    expect(readRememberedWallet()).toBeNull();
    window.localStorage.setItem("doxxd.wallet.v1", JSON.stringify({ name: 5 }));
    expect(readRememberedWallet()).toBeNull();
  });
});

describe("isSolanaSigner", () => {
  const base = {
    chains: ["solana:mainnet"],
    features: ["standard:connect", "solana:signTransaction"],
  };
  it("needs mainnet, connect and signTransaction", () => {
    expect(isSolanaSigner(base)).toBe(true);
    expect(isSolanaSigner({ ...base, chains: ["solana:devnet"] })).toBe(false);
    expect(isSolanaSigner({ ...base, features: ["standard:connect"] })).toBe(false);
    expect(isSolanaSigner({ ...base, features: ["solana:signTransaction"] })).toBe(false);
  });
});

describe("signTransactionBytes", () => {
  const sign = (calls: number[]) => async (
    ...inputs: Array<{ transaction: Uint8Array }>
  ) => {
    calls.push(inputs.length);
    return inputs.map((i) => ({ signedTransaction: Uint8Array.from([...i.transaction, 1]) }));
  };
  it("sends every transaction in one call when batching", async () => {
    const calls: number[] = [];
    const out = await signTransactionBytes(sign(calls), [Uint8Array.of(1), Uint8Array.of(2)], true);
    expect(calls).toEqual([2]);
    expect(out).toEqual([Uint8Array.of(1, 1), Uint8Array.of(2, 1)]);
  });
  it("signs one at a time otherwise", async () => {
    const calls: number[] = [];
    await signTransactionBytes(sign(calls), [Uint8Array.of(1), Uint8Array.of(2)], false);
    expect(calls).toEqual([1, 1]);
  });
  it("rejects a wrong-sized answer and handles empty input", async () => {
    await expect(
      signTransactionBytes(async () => [], [Uint8Array.of(1)], true),
    ).rejects.toThrow();
    expect(await signTransactionBytes(async () => [], [], true)).toEqual([]);
  });
});
