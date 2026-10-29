import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

const options = { windowMs: 60_000, general: 120, send: 20 };

describe("createRateLimiter", () => {
  it("refuses the 121st general call within 60 s with a positive retry-after", () => {
    const limiter = createRateLimiter(options);
    const t0 = 1_000_000;
    for (let i = 0; i < 120; i++)
      expect(limiter.take("ip-a", "getAccountInfo", t0 + i * 100)).toEqual({ ok: true });
    const refused = limiter.take("ip-a", "getSlot", t0 + 30_000);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(refused.retryAfterSec).toBe(30);
    // Another key has its own budget.
    expect(limiter.take("ip-b", "getSlot", t0 + 30_000)).toEqual({ ok: true });
  });

  it("refuses the 21st send while general calls still pass", () => {
    const limiter = createRateLimiter(options);
    const t0 = 5_000;
    for (let i = 0; i < 20; i++)
      expect(limiter.take("ip-a", "sendTransaction", t0 + i)).toEqual({ ok: true });
    const refused = limiter.take("ip-a", "sendTransaction", t0 + 100);
    expect(refused).toEqual({ ok: false, retryAfterSec: 60 });
    expect(limiter.take("ip-a", "getSignatureStatuses", t0 + 101)).toEqual({ ok: true });
    expect(limiter.take("ip-a", "simulateTransaction", t0 + 102)).toEqual({ ok: true });
  });

  it("resets after the window", () => {
    const limiter = createRateLimiter(options);
    const t0 = 0;
    for (let i = 0; i < 120; i++) limiter.take("ip-a", "getSlot", t0);
    for (let i = 0; i < 20; i++) limiter.take("ip-a", "sendTransaction", t0);
    expect(limiter.take("ip-a", "getSlot", t0 + 59_999)).toEqual({
      ok: false,
      retryAfterSec: 1,
    });
    expect(limiter.take("ip-a", "sendTransaction", t0 + 59_999).ok).toBe(false);
    expect(limiter.take("ip-a", "getSlot", t0 + 60_000)).toEqual({ ok: true });
    expect(limiter.take("ip-a", "sendTransaction", t0 + 60_000)).toEqual({ ok: true });
  });

  it("does not count refused calls", () => {
    const limiter = createRateLimiter({ windowMs: 1_000, general: 1, send: 1 });
    expect(limiter.take("k", "getSlot", 0).ok).toBe(true);
    for (let i = 0; i < 50; i++) expect(limiter.take("k", "getSlot", 10).ok).toBe(false);
    expect(limiter.take("k", "getSlot", 1_000).ok).toBe(true);
  });

  it("keeps a bounded number of keys", () => {
    const limiter = createRateLimiter({ windowMs: 1_000, general: 1, send: 1 });
    for (let i = 0; i < 20_000; i++) limiter.take(`ip-${i}`, "getSlot", 0);
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
    // The newest key keeps its count.
    expect(limiter.take("ip-19999", "getSlot", 1).ok).toBe(false);
    for (let i = 0; i < 20_000; i++) limiter.take(`new-${i}`, "getSlot", 5_000);
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });
});
