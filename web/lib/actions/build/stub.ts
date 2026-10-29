// Stands in for ./index.ts in every non-client Vite environment (see
// ../ssr-stub-plugin.ts) so the Worker never bundles web3.js or the SDKs.
// Export the same names as ./index.ts; each throws if called.
function browserOnly(): never {
  throw new Error("Action builders only run in the browser.");
}

export const createActionRpc = browserOnly;
export const RpcBusyError = browserOnly;
export const isRpcBusy = browserOnly;
export const verifyMessage = browserOnly;
export const packGroups = browserOnly;
export const GroupTooLargeError = browserOnly;
export const runAction = browserOnly;
export const AmountTooSmallError = browserOnly;
export const NothingToWithdrawError = browserOnly;
export const PositionGoneError = browserOnly;
export const buildClaimGroups = browserOnly;
export const quoteWithdraw = browserOnly;
export const buildWithdrawGroups = browserOnly;
