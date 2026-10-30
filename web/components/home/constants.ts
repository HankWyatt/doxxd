/**
 * The "Try a whale" link on the homepage: a well-known public exchange wallet,
 * so a first-time visitor sees a busy portfolio. Change it here only.
 */
export const TRY_WHALE_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

export const GITHUB_URL = "https://github.com/HankWyatt/doxxd";

/**
 * Protocol names for the homepage strip, in display order. Each is the brand
 * behind one or more protocol resources in `lib/dmnd/resources.ts` (a test
 * keeps the two in step), so the strip never names a protocol Doxxd does not read.
 */
export const HOME_PROTOCOLS = [
  "Kamino",
  "Orca",
  "Raydium",
  "Meteora",
  "Drift",
  "MarginFi",
  "Solend",
] as const;
