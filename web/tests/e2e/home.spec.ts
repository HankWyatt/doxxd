import { expect, test } from "@playwright/test";
import { DEMO_ADDRESS } from "../../lib/fixtures/wallet";
import { GITHUB_URL, TRY_WHALE_ADDRESS } from "../../components/home/constants";
import { installMockWallet } from "./mock-wallet-standard";
import { mockWalletResources, waitForWalletHydration } from "./mock-wallet-resources";

test("homepage links: whale shortcut, watchlist and GitHub", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Try a whale" })).toHaveAttribute("href", `/wallet/${TRY_WHALE_ADDRESS}`);
  await expect(page.getByRole("link", { name: "Open your watchlist" })).toHaveAttribute("href", "/watchlist");
  const github = page.getByRole("link", { name: "Open source on GitHub" });
  await expect(github).toHaveAttribute("href", GITHUB_URL);
  await expect(github).toHaveAttribute("rel", "noopener noreferrer");
});

test("the hero card animates, and is static under reduced motion", async ({ page }) => {
  const body = page.locator(".pf-body");
  await page.goto("/");
  await expect.poll(() => body.evaluate((el) => getComputedStyle(el).animationName)).toBe("pf-show");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => body.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await body.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  const addr = page.locator(".pf-addr");
  expect(await addr.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await addr.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("the Manage pillar's Connect wallet opens the header picker and lands on the portfolio", async ({ page }) => {
  await mockWalletResources(page);
  await installMockWallet(page, { address: DEMO_ADDRESS, signBehavior: "sign" });
  await page.goto("/");
  await waitForWalletHydration(page);
  const pillar = page.getByRole("article", { name: "Manage your own" });
  await expect(pillar).toContainText("claim LP fees");
  await pillar.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.locator(".site-header").getByRole("button", { name: "Connect wallet" })).toBeFocused();
  await page.getByRole("button", { name: /Mock/ }).click();
  await expect(page).toHaveURL(`/wallet/${DEMO_ADDRESS}`);
});

test("homepage fits a 390px phone without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForWalletHydration(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // .landing clips overflow, so scrollWidth alone would miss a wide card or pillar.
  for (const box of [page.locator(".pf"), ...(await page.locator(".pillar").all())]) {
    const b = (await box.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  expect(await page.locator(".pillar").count()).toBe(3);
  const search = await page.getByRole("search").boundingBox();
  const card = await page.locator(".pf").boundingBox();
  expect(card!.y).toBeGreaterThan(search!.y + search!.height);
});

test("wallet pages share the homepage footer", async ({ page }) => {
  await mockWalletResources(page);
  for (const tab of ["", "/activity"]) {
    await page.goto(`/wallet/${DEMO_ADDRESS}${tab}`);
    const footer = page.locator("footer.site-footer");
    await expect(footer).toContainText("Public wallets. Open possibilities.");
    await expect(footer.getByRole("link", { name: "Open source on GitHub" })).toHaveAttribute("href", GITHUB_URL);
    await expect(footer.getByRole("link", { name: "Open source on GitHub" })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(footer.getByRole("link", { name: "Powered by DMND" })).toBeVisible();
    await expect(page.getByText("Read-only explorer")).toHaveCount(0);
  }
});
