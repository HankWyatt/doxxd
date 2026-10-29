import { expect, test, type Page } from "@playwright/test";
import bs58 from "bs58";
import { DEMO_ADDRESS } from "../../lib/fixtures/wallet";
import { installMockWallet, switchMockWalletAccount } from "./mock-wallet-standard";
import { mockWalletResources, waitForWalletHydration } from "./mock-wallet-resources";

const OTHER_ADDRESS = bs58.encode(new Uint8Array(32).fill(8));
const pillLabel = (a: string) => `Connected wallet ${a.slice(0, 2)}…${a.slice(-2)}`;
const pill = (page: Page, address = DEMO_ADDRESS) =>
  page.getByRole("button", { name: pillLabel(address) });

test("connect from the header on the homepage, keep the wallet across pages, disconnect from the menu", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (m) => {
    if (/hydrat/i.test(m.text())) hydrationErrors.push(m.text());
  });
  await mockWalletResources(page);
  await installMockWallet(page, { address: DEMO_ADDRESS, signBehavior: "sign" });
  await page.route(`**/api/wallet/${OTHER_ADDRESS}/**`, (route) =>
    route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } }),
  );

  // Connecting on the homepage lands on the connected wallet's portfolio.
  await page.goto("/");
  await waitForWalletHydration(page);
  const header = page.locator(".site-header");
  const connect = header.getByRole("button", { name: "Connect wallet" });
  await expect(connect).toBeEnabled();
  await connect.click();
  await page.getByRole("button", { name: /Mock/ }).click();
  await expect(page).toHaveURL(`/wallet/${DEMO_ADDRESS}`);
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();
  await expect(pill(page)).toBeVisible();
  // The wallet page no longer has its own Connect or Disconnect button.
  await expect(page.locator(".wallet-actions").getByRole("button", { name: /Connect wallet|Disconnect/ })).toHaveCount(0);

  // Remembered: a silent connect restores it on any page, without navigating.
  await page.goto("/watchlist");
  await expect(pill(page)).toBeVisible();
  await expect(page).toHaveURL("/watchlist");

  await page.goto(`/wallet/${OTHER_ADDRESS}`);
  await waitForWalletHydration(page);
  const goToMine = page.getByRole("link", { name: "Go to my wallet" });
  await expect(page.locator(".pill", { has: goToMine })).toHaveText("Viewing another wallet · Go to my wallet");
  await expect(goToMine).toHaveAttribute("href", `/wallet/${DEMO_ADDRESS}`);

  // The mock wallet switches account; the header and the tag follow it.
  await switchMockWalletAccount(page, OTHER_ADDRESS);
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();
  await expect(pill(page, OTHER_ADDRESS)).toBeVisible();
  await switchMockWalletAccount(page, DEMO_ADDRESS);
  await expect(page.getByText(/Viewing another wallet/)).toBeVisible();

  await goToMine.click();
  await waitForWalletHydration(page);
  await expect(page.getByText("Your wallet · Mock")).toBeVisible();

  // The account card: net worth, its actions, Esc closes it.
  await pill(page).click();
  const card = page.getByRole("dialog", { name: "Wallet account" });
  await expect(card.getByText("$12,345.67")).toBeVisible();
  await expect(card.getByRole("link", { name: "Portfolio" })).toHaveAttribute("href", `/wallet/${DEMO_ADDRESS}`);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(pill(page)).toBeFocused();

  await pill(page).click();
  await card.getByRole("button", { name: "Disconnect" }).click();
  await expect(header.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByText("Your wallet · Mock")).toHaveCount(0);
  await page.reload();
  await waitForWalletHydration(page);
  await expect(header.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  await expect(page.getByText("Your wallet · Mock")).toHaveCount(0);
  expect(hydrationErrors).toEqual([]);
});

test("the header connect fits a 390px screen and shows no picker without a wallet", async ({ page }) => {
  await mockWalletResources(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  const connect = page.locator(".site-header").getByRole("button", { name: "Connect wallet" });
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

test("on a 390px screen the pill is an icon and the account card spans the width", async ({ page }) => {
  await mockWalletResources(page);
  await installMockWallet(page, { address: OTHER_ADDRESS, signBehavior: "sign" });
  await page.route(`**/api/wallet/${OTHER_ADDRESS}/**`, (route) =>
    route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await page.locator(".site-header").getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Mock/ }).click();
  await expect(page.getByRole("link", { name: "Go to my wallet" })).toBeVisible();
  const button = pill(page, OTHER_ADDRESS);
  await expect(button).toBeVisible();
  await expect(button.locator(".account-pill-address")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await button.click();
  const card = page.getByRole("dialog", { name: "Wallet account" });
  await expect(card.getByText("—")).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(15);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(box!.width).toBeGreaterThanOrEqual(350);
  // It drops from the header bar, below the pill.
  const anchor = await button.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
});
