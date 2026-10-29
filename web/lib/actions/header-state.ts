export type HeaderWalletState = "disconnected" | "own" | "other";

// `viewed` is the address in the URL; `connected` is the visitor's connected
// wallet address, or null when nothing is connected.
export function headerWalletState(
  viewed: string,
  connected: string | null,
): HeaderWalletState {
  if (connected === null) return "disconnected";
  return connected === viewed ? "own" : "other";
}
