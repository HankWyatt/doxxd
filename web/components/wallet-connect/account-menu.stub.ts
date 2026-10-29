// Stands in for ./account-menu in every non-client Vite environment (see
// lib/actions/ssr-stub-plugin.ts). HeaderAccount renders nothing on the server
// and loads the card lazily in the browser, so the Worker never calls this.
export function AccountMenu(): never {
  throw new Error("The account menu only runs in the browser.");
}
