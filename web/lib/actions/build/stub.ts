// Stands in for ./index.ts in every non-client Vite environment (see
// ../ssr-stub-plugin.ts) so the Worker never bundles web3.js or the SDKs.
// Export the same names as ./index.ts; each throws if called.
function browserOnly(): never {
  throw new Error("Action builders only run in the browser.");
}

export const sdkProbe = browserOnly;
export const createActionRpc = browserOnly;
export const RpcBusyError = browserOnly;
