// Fixed-window rate limit per key (client IP). Pure: the caller passes `now`.
// `sendTransaction` has its own, smaller budget; every other method counts
// against the general budget. Refused calls are not counted.
import type { RpcMethod } from "./policy";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * The JSON-RPC error message of /api/rpc's own 429 (this limiter), as
 * opposed to the upstream's ("Upstream RPC rate limited"). The browser's RPC
 * client (lib/actions/rpc.ts) reads it: a request refused here was never
 * forwarded, so a send can safely go again.
 */
export const LIMITER_REFUSAL = "Rate limited";

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

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;

// The eight hextets of an IPv6 address, or null. An embedded IPv4 tail
// (::ffff:a.b.c.d) counts as two hextets.
function hextets(address: string): number[] | null {
  let text = address.toLowerCase();
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const parts = IPV4.exec(v4[1])!.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    text = `${text.slice(0, v4.index + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const split = (half: string) => (half === "" ? [] : half.split(":"));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every((h) => HEXTET.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

/**
 * The rate-limit key for a client address (cf-connecting-ip): an IPv6
 * client by its /64 prefix, since one subscriber usually holds a whole /64;
 * an IPv4 client (or IPv4-mapped IPv6) by its address. A missing address
 * shares the key "local"; anything unreadable is its own key.
 */
export function rateLimitKey(address: string | null): string {
  if (!address) return "local";
  if (IPV4.test(address)) return address;
  const h = hextets(address);
  if (!h) return address;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff)
    return `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
  return `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
