import { expect, test } from "@playwright/test";
import bs58 from "bs58";
import { DEMO_ADDRESS } from "../../lib/fixtures/wallet";
import { installMockWallet, switchMockWalletAccount } from "./mock-wallet-standard";
import { mockWalletResources, waitForWalletHydration } from "./mock-wallet-resources";

const OTHER_ADDRESS = bs58.encode(new Uint8Array(32).fill(8));
const short = (a: string) => `${a.slice(0, 5)}…${a.slice(-5)}`;

test("connect the mock wallet, follow it across wallets and account changes", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (m) => {
    if (/hydrat/i.test(m.text())) hydrationErrors.push(m.text());
  });
  await mockWalletResources(page);
  await installMockWallet(page, { address: DEMO_ADDRESS, signBehavior: "sign" });
  await page.route(`**/api/wallet/${OTHER_ADDRESS}/**`, (route) =>
    route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } }),
  );

  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  const connect = page.getByRole("button", { name: "Connect wallet" });
  await expect(connect).toBeEnabled();
  await connect.click();
  await page.getByRole("button", { name: /Mock/ }).click();
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();

  // The wallet is remembered: a silent connect restores it on the next load,
  // here on a different wallet's page.
  await page.goto(`/wallet/${OTHER_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(
    page.getByText(`Connected as ${short(DEMO_ADDRESS)} · viewing another wallet`),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to my wallet" })).toHaveAttribute(
    "href",
    `/wallet/${DEMO_ADDRESS}`,
  );

  // The mock wallet switches account; the header follows it.
  await switchMockWalletAccount(page, OTHER_ADDRESS);
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();
  await switchMockWalletAccount(page, DEMO_ADDRESS);
  await expect(page.getByText(/viewing another wallet/)).toBeVisible();

  await page.getByRole("link", { name: "Go to my wallet" }).click();
  await waitForWalletHydration(page);
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await page.reload();
  await waitForWalletHydration(page);
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  await expect(page.getByText("Your wallet · Mock")).toHaveCount(0);
  expect(hydrationErrors).toEqual([]);
});

test("header actions fit a 390px screen and show no picker without a wallet", async ({ page }) => {
  await mockWalletResources(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  const connect = page.getByRole("button", { name: "Connect wallet" });
  await expect(connect).toBeEnabled();
  await expect(connect).toBeVisible();
  await connect.click();
  await expect(page.getByText("No Solana wallet found")).toBeVisible();
  const phantom = page.getByRole("link", { name: /Phantom/ });
  await expect(phantom).toHaveAttribute("href", "https://phantom.com/");
  await expect(phantom).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = await page.locator(".wallet-picker").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("connected states wrap within a 390px screen", async ({ page }) => {
  await mockWalletResources(page);
  await installMockWallet(page, { address: OTHER_ADDRESS, signBehavior: "sign" });
  await page.route(`**/api/wallet/${OTHER_ADDRESS}/**`, (route) =>
    route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Mock/ }).click();
  await expect(page.getByText(/viewing another wallet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to my wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
