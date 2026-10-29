// Fixed-window rate limit per key (client IP). Pure: the caller passes `now`.
// `sendTransaction` has its own, smaller budget; every other method counts
// against the general budget. Refused calls are not counted.
import type { RpcMethod } from "./policy";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export type RateLimiter = {
  take(key: string, method: RpcMethod, now: number): RateLimitResult;
  /** Number of keys currently tracked. */
  size(): number;
};

type Bucket = { start: number; general: number; send: number };

// Caps memory in one isolate. Past it, expired windows go first, then the
// oldest windows (the ones closest to resetting anyway).
const MAX_KEYS = 10_000;

export function createRateLimiter(options: {
  windowMs: number;
  general: number;
  send: number;
}): RateLimiter {
  const buckets = new Map<string, Bucket>();

  // Map iterates in insertion order, and a key is re-inserted whenever its
  // window restarts, so the front holds the oldest windows. Drop from the
  // front while entries are expired or the map is full: amortised O(1).
  function prune(now: number) {
    for (const [key, bucket] of buckets) {
      if (buckets.size < MAX_KEYS && now - bucket.start < options.windowMs) break;
      buckets.delete(key);
    }
  }

  return {
    take(key, method, now) {
      let bucket = buckets.get(key);
      if (!bucket || now - bucket.start >= options.windowMs) {
        buckets.delete(key);
        prune(now);
        bucket = { start: now, general: 0, send: 0 };
        buckets.set(key, bucket);
      }
      const kind = method === "sendTransaction" ? "send" : "general";
      if (bucket[kind] >= options[kind])
        return {
          ok: false,
          retryAfterSec: Math.max(
            1,
            Math.ceil((bucket.start + options.windowMs - now) / 1000),
          ),
        };
      bucket[kind] += 1;
      return { ok: true };
    },
    size: () => buckets.size,
  };
}
