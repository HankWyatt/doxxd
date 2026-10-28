import { test, expect } from "@playwright/test";
import bs58 from "bs58";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";

test("large observed holdings can be paged and searched without more wallet reads", async ({ page }) => {
  const result = readFixture("overview", "complete");
  if (!result.ok) throw Error("Expected synthetic overview");
  const template = result.data.assets[0];
  result.data.assets = Array.from({ length: 45 }, (_, index) => ({
    ...template,
    mint: bs58.encode(new Uint8Array(32).fill(index + 30)),
    symbol: "OBS" + String(index).padStart(2, "0"),
    name: "Observed token " + index,
    amount: "1000000",
    ui_amount: "1",
    price_usd: null,
    price_updated_at: null,
    value_usd: null,
    last_slot: 100 + index,
  }));
  // Native SOL remains the only priced observation; every token is unpriced.
  result.data.known_value_usd = "3000";
  result.data.unpriced_asset_count = 45;
  result.data.coverage.complete = false;
  // Use terminal partial coverage so automatic scan checks do not compete with
  // this assertion that local paging/search themselves cause no wallet reads.
  result.data.coverage.snapshot_status = "done";
  result.data.coverage.reason = "snapshot_partial";
  result.data.coverage.token_snapshot_slot = null;
  let walletReads = 0;
  await page.route("**/api/wallet/**", route => {
    walletReads++;
    return new URL(route.request().url()).pathname === `/api/wallet/${DEMO_ADDRESS}/overview`
      ? route.fulfill({ status: 200, json: result })
      : route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (/hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  const holdings = page.locator("#holdings");
  const rows = holdings.locator(".data-row");
  const next = holdings.getByRole("button", { name: "Next holdings", exact: true });
  const previous = holdings.getByRole("button", { name: "Previous holdings", exact: true });
  await expect(rows).toHaveCount(20, { timeout: 15_000 });
  await expect(previous).toBeDisabled();
  await expect(holdings.getByRole("button", { name: "Inspect SOL holding", exact: true })).toBeVisible();
  await next.focus();
  await next.press("Enter");
  await expect(holdings.getByRole("button", { name: "Inspect OBS19 holding", exact: true })).toBeVisible();
  await expect(rows).toHaveCount(20);
  await next.click();
  await expect(rows).toHaveCount(6);
  await expect(next).toBeDisabled();
  await expect(holdings.getByRole("button", { name: "Inspect OBS44 holding", exact: true })).toBeVisible();
  await previous.click();
  await expect(rows).toHaveCount(20);

  const search = holdings.getByLabel("Search observed holdings", { exact: true });
  await search.fill(result.data.assets[44].mint);
  await expect(rows).toHaveCount(1);
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  const late = holdings.getByRole("button", { name: "Inspect OBS44 holding", exact: true });
  await expect(late.locator("xpath=ancestor::tr")).not.toContainText("$0.00");
  await late.click();
  const detail = holdings.locator(".detail-row");
  await expect(detail.getByText("1000000", { exact: true })).toBeVisible();
  await expect(detail.getByText("144", { exact: true })).toBeVisible();
  await expect(holdings.locator(".section-heading")).toContainText("$3,000.00");
  await expect(holdings.locator(".coverage-note summary")).toContainText("45 unpriced");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await search.fill("no-observed-token-matches");
  await expect(rows).toHaveCount(0);
  await expect(holdings.getByText("No observed holdings match this search.", { exact: true })).toBeVisible();
  await expect(holdings.getByText("No token balances in the available snapshot", { exact: true })).toHaveCount(0);
  await expect(holdings.locator(".detail-row")).toHaveCount(0);
  await holdings.getByRole("button", { name: "Clear holdings search", exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(holdings.getByRole("button", { name: "Inspect SOL holding", exact: true })).toBeVisible();
  await expect(holdings.locator(".section-heading")).toContainText("$3,000.00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(walletReads).toBe(3); // Overview, unavailable summary and independent trading page only.
  expect(errors).toEqual([]);
});
