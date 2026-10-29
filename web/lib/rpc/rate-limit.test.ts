import { describe, expect, it } from "vitest";
import { createRateLimiter, rateLimitKey } from "./rate-limit";

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

describe("rateLimitKey", () => {
  it("keys an IPv6 client by its /64 prefix, however the address is written", () => {
    const key = rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(key).toBe("2001:db8:1:2::/64");
    for (const same of ["2001:db8:1:2::1", "2001:0db8:0001:0002:0:0:0:ffff", "2001:DB8:1:2::abcd"])
      expect(rateLimitKey(same), same).toBe(key);
    expect(rateLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(key);
  });

  it("keys IPv4 (and IPv4-mapped IPv6) by the whole address", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("falls back to one shared key for a missing or unreadable address", () => {
    expect(rateLimitKey(null)).toBe("local");
    expect(rateLimitKey("")).toBe("local");
    expect(rateLimitKey("not an address")).toBe("not an address");
    expect(rateLimitKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });

  it("makes 300 addresses in one /64 share one budget", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, general: 300, send: 40 });
    let limited = 0;
    for (let i = 0; i < 301; i++)
      if (!limiter.take(rateLimitKey(`2001:db8::${i.toString(16)}`), "getSlot", 0).ok) limited++;
    expect(limited).toBe(1);
  });
});
