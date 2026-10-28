import { test, expect } from "@playwright/test";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
  test("compact balances and indexed trading details on " + viewport.name, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const overview = readFixture("overview", "complete");
    const positions = readFixture("positions", "complete");
    const summary = readFixture("summary", "complete");
    if (!overview.ok || !positions.ok || !summary.ok) throw Error("synthetic fixtures");
    const jup = overview.data.assets.find(asset => asset.symbol === "JUP")!;
    Object.assign(jup, { amount: "1250000000000", ui_amount: "1250000", price_usd: "0.0004", value_usd: "500" });
    const bonk = overview.data.assets.find(asset => asset.symbol === "BONK")!;
    Object.assign(bonk, { amount: "1250000000000000", ui_amount: "1250000000", price_usd: "0.0000001", value_usd: "125" });
    overview.data.assets = [jup, bonk, overview.data.assets.find(asset => asset.symbol === "USDC")!];
    overview.data.known_value_usd = "5425";
    Object.assign(positions.data.data[0], {
      amount: jup.amount, ui_amount: jup.ui_amount,
      bought: { amount: "2500000", usd: "1000", sol: "6.666666666", count: 4 },
      sold: { amount: "1250000", usd: "750", sol: "5", count: 3 },
      avg_buy_price_usd: "0.0004", avg_sell_price_usd: "0.0006",
      realized_pnl_usd: "250", unrealized_pnl_usd: "0", total_pnl_usd: "250",
      pnl_percent: "123456.7",
    });
    positions.data.sort = "value";
    let positionRequests = 0;
    await page.route("**/api/wallet/**", route => {
      const resource = new URL(route.request().url()).pathname.split("/").at(-1);
      if (resource === "positions") positionRequests++;
      return route.fulfill({ status: 200, json: resource === "overview" ? overview
        : resource === "positions" ? positions : resource === "summary" ? summary
          : { ok: false, kind: "unavailable" } });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/wallet/" + DEMO_ADDRESS);
    const holdings = page.locator("#holdings");
    const jupButton = holdings.getByRole("button", { name: "Inspect JUP holding", exact: true });
    await expect(jupButton).toBeVisible();
    await expect(holdings.getByText(/Trading history is partial/)).toBeVisible();
    await expect(holdings.getByLabel("Trading data coverage")).toContainText("1 of 1 tokens loaded");
    const row = jupButton.locator("xpath=ancestor::tr");
    await expect(row.locator(".holdings-value")).toHaveText("$500.00");
    await expect(row.locator(".holdings-value")).toHaveCSS("color", "rgb(117, 239, 181)");
    if (viewport.name === "desktop") {
      await expect(row.getByText("1.25M", { exact: true })).toBeVisible();
      await expect(row.getByText("+$250.00", { exact: true })).toBeVisible();
      await expect(row.getByText("4 trades", { exact: true })).toBeVisible();
      await expect(holdings.getByRole("columnheader", { name: "Buys", exact: true })).toBeVisible();
    } else {
      await expect(jupButton.getByText("Balance 1.25M", { exact: true })).toBeVisible();
      await expect(holdings.getByRole("columnheader", { name: "Buys", exact: true })).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await jupButton.click();
    const detail = holdings.locator(".detail-row");
    await expect(detail.getByText("Balance", { exact: true }).locator("..").locator("dd")).toHaveText("1250000 JUP");
    await expect(detail.getByText("1250000000000", { exact: true })).toBeVisible();
    await expect(detail.getByText("Indexed realized P&L estimate", { exact: true })).toBeVisible();
    await expect(detail.getByText("$1,000.00", { exact: true })).toBeVisible();
    await expect(detail.getByText("4 trades", { exact: true })).toBeVisible();
    await expect(detail.getByText("$750.00", { exact: true })).toBeVisible();
    await expect(detail.getByText("3 trades", { exact: true })).toBeVisible();
    await expect(holdings).not.toContainText("123456.7");
    expect(positionRequests).toBe(1);
    await holdings.screenshot({ path: test.info().outputPath("holdings-trading-" + viewport.name + ".png") });
    expect(errors).toEqual([]);
  });
}
