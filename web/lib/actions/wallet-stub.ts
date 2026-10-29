// Stands in for `@wallet-standard/react-core` and `@solana/react` in every
// non-client Vite environment (see ./ssr-stub-plugin.ts). The wallet logic runs
// only in the browser after hydration, so the Worker never calls these and
// need not bundle them. Export every name the app imports from those packages.
function browserOnly(): never {
  throw new Error("Wallet connection only runs in the browser.");
}

export const useWallets = browserOnly;
export const useConnect = browserOnly;
export const getWalletFeature = browserOnly;
export const useSignTransactions = browserOnly;
