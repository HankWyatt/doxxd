import { afterEach, describe, expect, it } from "vitest";
import type { Schemas } from "@/lib/dmnd/contracts";
import {
  HIDE_AMOUNTS_KEY,
  claimFeesTarget,
  pillAddress,
  readHideAmounts,
  writeHideAmounts,
} from "./account";

type Component = Schemas["WalletPortfolioComponent"];
const component = (id: string, value: string | null, extra: Partial<Component> = {}): Component => ({
  id,
  source_path: `/wallets/synthetic/${id}`,
  known_asset_value_usd: value,
  known_debt_value_usd: "0",
  known_net_value_usd: value,
  unpriced_count: 0,
  included_in_known_total: true,
  coverage_complete: true,
  coverage_fresh: true,
  coverage_status: "complete",
  reason: "synthetic",
  ...extra,
});

describe("pillAddress", () => {
  it("keeps the first two and last two characters", () => {
    expect(pillAddress("J8abcdefgh8n")).toBe("J8…8n");
  });
  it("leaves very short values whole", () => {
    expect(pillAddress("abcd")).toBe("abcd");
  });
});

describe("claimFeesTarget", () => {
  it("is null with no summary or no claimable liquidity protocol", () => {
    expect(claimFeesTarget(null)).toBeNull();
    expect(
      claimFeesTarget([
        component("tokens_native_sol", "100"),
        // Orca and fungible LP have no on-site fee claim.
        component("orca_whirlpools", "50"),
        component("raydium_cpmm", "40"),
      ]),
    ).toBeNull();
  });
  it("ignores claimable protocols without positions", () => {
    expect(
      claimFeesTarget([
        component("meteora_damm_v2", "0"),
        component("raydium_clmm", null, { coverage_status: "queued", coverage_complete: false }),
      ]),
    ).toBeNull();
  });
  it("picks the first card in the portfolio's order (largest value first)", () => {
    expect(
      claimFeesTarget([
        component("raydium_clmm", "10"),
        component("meteora_damm_v2", "90"),
      ]),
    ).toBe("meteora-damm-v2");
    expect(claimFeesTarget([component("raydium_clmm", "10")])).toBe("raydium-clmm");
  });
});

describe("hide amounts preference", () => {
  afterEach(() => window.localStorage.clear());
  it("defaults to shown and round-trips", () => {
    expect(readHideAmounts()).toBe(false);
    writeHideAmounts(true);
    expect(window.localStorage.getItem(HIDE_AMOUNTS_KEY)).toBe("1");
    expect(readHideAmounts()).toBe(true);
    writeHideAmounts(false);
    expect(readHideAmounts()).toBe(false);
  });
  it("survives storage that throws", () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readHideAmounts()).toBe(false);
      expect(() => writeHideAmounts(true)).not.toThrow();
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });
});
