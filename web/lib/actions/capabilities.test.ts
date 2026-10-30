import { describe, expect, it } from "vitest";
import { capabilities, claimableLabel } from "./capabilities";
import type {
  ClmmTarget,
  DammV2Target,
  FungibleTarget,
  Leg,
} from "./types";

const leg: Leg = { mint: "MintSynth", decimals: 6, symbol: null };

const damm = (over: Partial<DammV2Target> = {}): DammV2Target => ({
  protocol: "meteora-damm-v2",
  id: "pos",
  pool: "pool",
  position: "pos",
  positionMint: "nft",
  positionNftAccount: "nftacct",
  nftTokenProgram: "tok",
  program: "prog",
  liquidity: { unlocked: "1000", vested: "200", permanentLocked: "300", total: "1500" },
  feeAAtoms: "0",
  feeBAtoms: "0",
  rewards: [],
  tokenA: leg,
  tokenB: leg,
  snapshotSlot: 1,
  ...over,
});

const clmm = (over: Partial<ClmmTarget> = {}): ClmmTarget => ({
  protocol: "raydium-clmm",
  id: "pos",
  pool: "pool",
  position: "pos",
  positionMint: "nft",
  positionNftAccount: "nftacct",
  nftTokenProgram: "tok",
  program: "prog",
  liquidity: "5000",
  tickLower: -10,
  tickUpper: 10,
  feeOwedAAtoms: "0",
  feeOwedBAtoms: "0",
  rewards: [],
  tokenA: leg,
  tokenB: leg,
  snapshotSlot: 1,
  ...over,
});

const fungible = (over: Partial<FungibleTarget> = {}): FungibleTarget => ({
  protocol: "raydium-cpmm",
  id: "acct",
  pool: "pool",
  lpMint: "lp",
  lpAccount: "acct",
  lpAtoms: "100",
  lpDecimals: 6,
  withdrawalAvailable: true,
  legs: [leg, leg],
  snapshotSlot: 1,
  ...over,
});

describe("DAMM v2 capabilities", () => {
  it("claim is yes when any fee or reward is above 0, else no", () => {
    expect(capabilities(damm()).claim).toBe("no");
    expect(capabilities(damm({ feeAAtoms: "1" })).claim).toBe("yes");
    expect(capabilities(damm({ feeBAtoms: "1" })).claim).toBe("yes");
    expect(
      capabilities(damm({ rewards: [{ index: 0, mint: "r", atoms: "5" }] })).claim,
    ).toBe("yes");
    expect(
      capabilities(damm({ rewards: [{ index: 0, mint: "r", atoms: "0" }] })).claim,
    ).toBe("no");
  });

  it("withdraw is yes with unlocked or vested liquidity", () => {
    expect(capabilities(damm()).withdraw).toBe("yes");
    const onlyVested = damm({
      liquidity: { unlocked: "0", vested: "10", permanentLocked: "0", total: "10" },
    });
    expect(capabilities(onlyVested).withdraw).toBe("yes");
  });

  it("withdraw is locked when only permanently locked liquidity remains", () => {
    const locked = damm({
      liquidity: { unlocked: "0", vested: "0", permanentLocked: "300", total: "300" },
    });
    expect(capabilities(locked)).toMatchObject({
      withdraw: "locked",
      withdrawableBps: 0,
      vestingBps: 0,
    });
  });

  it("withdraw is no when total is 0, without dividing by zero", () => {
    const empty = damm({
      liquidity: { unlocked: "0", vested: "0", permanentLocked: "0", total: "0" },
    });
    expect(capabilities(empty)).toMatchObject({
      withdraw: "no",
      withdrawableBps: 0,
      vestingBps: 0,
    });
  });

  it("computes floored basis points with BigInt", () => {
    // (1000 + 200) * 10000 / 1500 = 8000; 200 * 10000 / 1500 = 1333.33
    expect(capabilities(damm())).toMatchObject({
      withdrawableBps: 8000,
      vestingBps: 1333,
    });
    const huge = damm({
      liquidity: {
        unlocked: "340282366920938463463374607431768211455",
        vested: "0",
        permanentLocked: "340282366920938463463374607431768211455",
        total: "680564733841876926926749214863536422910",
      },
    });
    expect(capabilities(huge).withdrawableBps).toBe(5000);
  });

  it("treats an unparseable amount as zero", () => {
    expect(capabilities(damm({ feeAAtoms: "not-a-number" })).claim).toBe("no");
  });

  it("labels claimable fees exact", () => {
    expect(claimableLabel(damm())).toBe("exact");
  });
});

describe("CLMM capabilities", () => {
  it("claim is maybe with liquidity or any owed amount, else no", () => {
    expect(capabilities(clmm()).claim).toBe("maybe");
    expect(capabilities(clmm({ liquidity: "0" })).claim).toBe("no");
    expect(capabilities(clmm({ liquidity: "0", feeOwedBAtoms: "3" })).claim).toBe("maybe");
    expect(
      capabilities(clmm({ liquidity: "0", rewards: [{ mint: "r", atoms: "3" }] })).claim,
    ).toBe("maybe");
  });

  it("withdraw is yes only with liquidity; bps are full", () => {
    expect(capabilities(clmm())).toMatchObject({
      withdraw: "yes",
      withdrawableBps: 10000,
      vestingBps: 0,
    });
    expect(capabilities(clmm({ liquidity: "0", feeOwedAAtoms: "9" })).withdraw).toBe("no");
  });

  it("labels claimable fees a lower bound", () => {
    expect(claimableLabel(clmm())).toBe("lower-bound");
  });
});

describe("CPMM and AMM v4 capabilities", () => {
  it.each(["raydium-cpmm", "raydium-amm-v4"] as const)("%s never claims", (protocol) => {
    expect(capabilities(fungible({ protocol })).claim).toBe("no");
    expect(claimableLabel(fungible({ protocol }))).toBe("included");
  });

  it("withdraw is yes with LP tokens unless withdrawal is known unavailable", () => {
    expect(capabilities(fungible()).withdraw).toBe("yes");
    expect(capabilities(fungible({ withdrawalAvailable: null })).withdraw).toBe("yes");
    expect(capabilities(fungible({ withdrawalAvailable: false })).withdraw).toBe("no");
    expect(capabilities(fungible({ lpAtoms: "0" })).withdraw).toBe("no");
    expect(capabilities(fungible())).toMatchObject({
      withdrawableBps: 10000,
      vestingBps: 0,
    });
  });

  it.each(["raydium-cpmm", "raydium-amm-v4"] as const)(
    "%s withdraw is no when DMND names no pool",
    (protocol) => {
      expect(capabilities(fungible({ protocol, pool: null })).withdraw).toBe("no");
    },
  );
});

describe("close capability", () => {
  const zero = { unlocked: "0", vested: "0", permanentLocked: "0", total: "0" };
  it("is yes for an empty DAMM v2 position, even with fees or rewards left to collect", () => {
    expect(capabilities(damm({ liquidity: zero })).close).toBe("yes");
    expect(capabilities(damm({ liquidity: zero, feeAAtoms: "5" })).close).toBe("yes");
    expect(capabilities(damm()).close).toBe("no");
    for (const part of ["unlocked", "vested", "permanentLocked", "total"] as const)
      expect(capabilities(damm({ liquidity: { ...zero, [part]: "1" } })).close, part).toBe("no");
  });

  it("is yes for a CLMM position with no liquidity", () => {
    expect(capabilities(clmm({ liquidity: "0" })).close).toBe("yes");
    expect(capabilities(clmm({ liquidity: "0", feeOwedAAtoms: "9" })).close).toBe("yes");
    expect(capabilities(clmm()).close).toBe("no");
  });

  it("is no for an unparseable amount and for CPMM and AMM v4", () => {
    expect(capabilities(damm({ liquidity: { ...zero, unlocked: "?" } })).close).toBe("no");
    expect(capabilities(clmm({ liquidity: "" })).close).toBe("no");
    expect(capabilities(fungible({ lpAtoms: "0" })).close).toBe("no");
    expect(capabilities(fungible({ protocol: "raydium-amm-v4", lpAtoms: "0" })).close).toBe("no");
  });
});
