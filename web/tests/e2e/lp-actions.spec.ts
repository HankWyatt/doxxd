import { expect, test, type Page } from "@playwright/test";
import bs58 from "bs58";
import { mockLpActionsWallet } from "./lp-actions-dmnd";
import { actionChain, routeActionRpc } from "./mock-action-rpc-route";
import { installMockWallet } from "./mock-wallet-standard";
import { waitForWalletHydration } from "./mock-wallet-resources";

// Synthetic only: the chain owner, its DMND rows and the RPC answers all come
// from tests/fixtures/actions-chain.ts (served by action-rpc-server.mjs). The
// mock wallet signs slot 0 with a fixed 64-byte pattern and never changes the
// message.
const MOCK_SIGNATURE = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 3 + 1) & 0xff));

async function openOwnWallet(page: Page, signBehavior: "sign" | "reject") {
  const owner = await mockLpActionsWallet(page, await actionChain());
  const rpc = await routeActionRpc(page);
  await installMockWallet(page, { address: owner, signBehavior });
  await page.goto(`/wallet/${owner}`);
  await waitForWalletHydration(page);
  // Connect from the site header (the wallet page has no button of its own).
  await page.locator(".site-header").getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Mock/ }).click();
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();
  const damm = page.locator("#protocol-meteora-damm-v2");
  await expect(damm.getByText("2 positions · fees to claim on 2")).toBeVisible();
  return { rpc, damm };
}

test("security headers on pages and API responses", async ({ page, request }) => {
  const response = await page.goto("/");
  const headers = response!.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  expect(headers["content-security-policy"]).toBe(
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  );

  // A client-sent CSP never reaches vinext (which would read a script nonce
  // from it): the page renders normally, with no nonce on its scripts.
  const forged = await request.get("/", { headers: { "Content-Security-Policy": "script-src 'nonce-<x>'" } });
  expect(forged.status()).toBe(200);
  expect(await forged.text()).not.toContain("nonce=");

  // A method outside the allowlist: refused before any upstream call.
  const api = await request.post("/api/rpc", { data: { jsonrpc: "2.0", id: 1, method: "getHealth" } });
  expect(api.status()).toBe(400);
  expect(api.headers()["x-frame-options"]).toBe("DENY");
  expect(api.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  // Every method but POST is a 405 from the route itself, not the framework's
  // automatic answers (T2 R-002).
  for (const method of ["GET", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
    const other = await request.fetch("/api/rpc", { method });
    expect(other.status(), method).toBe(405);
    expect(other.headers()["allow"], method).toBe("POST");
  }
});

test("the header's Claim LP fees link opens the DAMM v2 card from another page", async ({ page }) => {
  const { damm } = await openOwnWallet(page, "sign");
  const owner = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.goto("/watchlist");
  await page.getByRole("button", { name: /^Connected wallet / }).click();
  const card = page.getByRole("dialog", { name: "Wallet account" });
  await expect(card.getByText("Opportunities")).toBeVisible();
  await card.getByRole("link", { name: /Claim LP fees/ }).click();
  await expect(page).toHaveURL(`/wallet/${owner}#protocol-meteora-damm-v2`);
  await expect(damm.getByRole("button", { name: "Collapse Meteora DAMM v2" })).toBeFocused();
  await expect(damm).toBeInViewport();
});

test("claim all fees on the synthetic DAMM v2 wallet", async ({ page }) => {
  const { rpc, damm } = await openOwnWallet(page, "sign");
  await damm.getByRole("button", { name: "Claim all fees (2)" }).click();
  const progress = damm.locator(".claim-progress");
  await expect(progress.getByText("Claiming fees from 2 positions")).toBeVisible();
  await expect(progress.getByText("1 transaction · approve them in Mock")).toBeVisible();
  await expect(progress.getByText("Transaction 1 · 2 positions")).toBeVisible();
  await expect(progress.getByText("Confirmed")).toBeVisible({ timeout: 15_000 });
  await expect(progress.getByRole("link", { name: /Solscan/ })).toHaveAttribute(
    "href",
    `https://solscan.io/tx/${MOCK_SIGNATURE}`,
  );
  await expect(damm.getByText("Just claimed · updating")).toHaveCount(2);
  expect(rpc.methods.filter((m) => m === "sendTransaction")).toHaveLength(1);
});

test("withdraw 50% from the unlocked DAMM v2 position", async ({ page }) => {
  const { rpc, damm } = await openOwnWallet(page, "sign");
  const unlocked = damm.locator("tr.data-row").filter({ hasNot: page.locator(".lock-badge") });
  await unlocked.getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Withdraw from SYNA + SOL" })).toBeVisible();
  await dialog.getByRole("button", { name: "50%" }).first().click();
  const receive = dialog.locator("dt", { hasText: "You receive (about)" }).locator("+ dd");
  await expect(receive).not.toHaveText("—");
  await expect(receive).toContainText("SYNA");
  await dialog.getByRole("button", { name: "Review in wallet" }).click();
  await expect(dialog.getByText("Confirmed")).toBeVisible({ timeout: 15_000 });
  expect(rpc.methods.filter((m) => m === "sendTransaction")).toHaveLength(1);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(damm.getByText("Withdrawn · updating")).toBeVisible();
});

test("a declined prompt sends nothing", async ({ page }) => {
  const { rpc, damm } = await openOwnWallet(page, "reject");
  await damm.getByRole("button", { name: "Claim all fees (2)" }).click();
  const progress = damm.locator(".claim-progress");
  await expect(progress.getByText("You declined in your wallet")).toBeVisible({ timeout: 15_000 });
  await expect(progress.getByText("Nothing was claimed")).toBeVisible();
  expect(rpc.methods).toContain("simulateTransaction");
  expect(rpc.methods).not.toContain("sendTransaction");
  await expect(damm.getByText("Just claimed · updating")).toHaveCount(0);
});

test("a CPMM row offers Withdraw but no Claim", async ({ page }) => {
  await openOwnWallet(page, "sign");
  const cpmm = page.locator("#protocol-raydium-cpmm");
  const row = cpmm.locator("tr.data-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Withdraw" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Claim" })).toHaveCount(0);
  await expect(row.getByText("Included in your LP tokens")).toBeVisible();
  await expect(cpmm.getByRole("button", { name: /Claim all fees/ })).toHaveCount(0);
});
