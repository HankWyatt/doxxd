import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";
import type { ResourceName } from "../../lib/dmnd/contracts";
import { waitForWalletHydration } from "./mock-wallet-resources";

// Playwright loads tests in Node rather than Vite. Bundle the unchanged server
// validator and its generated JSON so schema assertions use the real validator.
const validatorBundle = await build({
  entryPoints: [fileURLToPath(new URL("../../lib/dmnd/validation.server.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { validResourcePayload } = await import(
  `data:text/javascript;base64,${Buffer.from(validatorBundle.outputFiles[0].contents).toString("base64")}`
) as typeof import("../../lib/dmnd/validation.server");

// Synthetic source-boundary controls, not evidence of live protocol/history serving.
test("page boundaries preserve source absence and manual continuation recovery", async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  expect(validResourcePayload("summary", {})).toBe(false);
  let protocolStage: "positive-total" | "intermediate" | "missing" = "positive-total";
  let activityRecovered = false;
  const reads: { resource: string; cursor: string | null }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (/hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.route("**/api/wallet/**", route => {
    const url = new URL(route.request().url());
    const resource = url.pathname.split("/").at(-1) as ResourceName;
    const cursor = url.searchParams.get("cursor");
    reads.push({ resource, cursor });
    if (resource === "summary") {
      const result = readFixture("summary", "complete");
      if (!result.ok) throw Error("Synthetic summary required");
      result.data.components.push({
        ...result.data.components[1],
        id: "liquid_staking_receipts", source_path: "liquid-staking",
        known_asset_value_usd: "1650", known_debt_value_usd: "0",
        known_net_value_usd: "1650", included_in_known_total: false,
        reason: "direct_receipt_overlap",
      });
      expect(validResourcePayload("summary", result.data)).toBe(true);
      return route.fulfill({ status: 200, json: result });
    }
    if (resource === "orca") {
      const result = readFixture("orca", "complete");
      if (!result.ok) throw Error("Synthetic positions required");
      result.data.data = [];
      result.data.coverage.total_positions = 1;
      result.data.page_known_principal_value_usd = "0";
      result.data.has_more = !cursor && protocolStage !== "positive-total";
      result.data.cursor = result.data.has_more && protocolStage === "intermediate" ? "LP+/=source-cursor" : null;
      expect(validResourcePayload("orca", result.data)).toBe(true);
      return route.fulfill({ status: 200, json: result });
    }
    if (resource === "transactions") {
      const result = readFixture("transactions", "complete");
      if (!result.ok) throw Error("Synthetic activity required");
      result.data.data = [];
      result.data.has_more = !cursor;
      result.data.cursor = !cursor && activityRecovered ? "ACT+/=source-cursor" : null;
      expect(validResourcePayload("transactions", result.data)).toBe(true);
      return route.fulfill({ status: 200, json: result });
    }
    const result = readFixture(resource, "complete");
    if (result.ok) expect(validResourcePayload(resource, result.data)).toBe(true);
    return route.fulfill({ status: 200, json: result });
  });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible({ timeout: 15_000 });
  const receipt = page.locator("#protocol-liquid-staking");
  await page.getByRole("link", { name: /Liquid staking/ }).click();
  await expect(receipt).toBeInViewport();
  await expect(receipt.getByRole("button", { name: "Expand Liquid staking" })).toHaveAttribute("aria-expanded", "false");
  expect(reads.some(r => r.resource === "liquid-staking")).toBe(false);

  const lp = page.locator("#protocol-orca");
  await lp.getByRole("button", { name: "Expand Orca Whirlpools" }).click();
  await expect(lp.getByText("No positions on this page", { exact: true })).toBeVisible();
  await expect(lp).not.toContainText("No positions were found in this supported scope.");
  await lp.locator(".coverage-note summary").click();
  await expect(lp.getByText("Source snapshot positions: 1.", { exact: true })).toBeVisible();
  expect(reads.filter(r => r.resource === "orca")).toHaveLength(1);
  protocolStage = "intermediate";
  await lp.getByRole("button", { name: "Collapse Orca Whirlpools" }).click();
  await lp.getByRole("button", { name: "Expand Orca Whirlpools" }).click();
  await lp.getByRole("button", { name: "Next positions" }).click();
  await expect(lp.getByRole("button", { name: "First page" })).toBeVisible();
  await expect(lp.getByText("No positions on this page", { exact: true })).toBeVisible();
  await expect(lp).not.toContainText("No positions were found in this supported scope.");
  expect(reads.filter(r => r.resource === "orca").at(-1)?.cursor).toBe("LP+/=source-cursor");
  protocolStage = "missing";
  await lp.getByRole("button", { name: "First page" }).click();
  await expect(lp.getByText("More positions are reported, but the continuation cursor is unavailable.", { exact: true })).toBeVisible();
  protocolStage = "intermediate";
  await lp.getByRole("button", { name: "Retry positions page" }).click();
  await expect(lp.getByRole("button", { name: "Next positions" })).toBeVisible();
  expect(reads.filter(r => r.resource === "orca")).toHaveLength(5);
  await page.screenshot({ path: testInfo.outputPath("page-boundaries-portfolio-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("page-boundaries-portfolio-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await waitForWalletHydration(page);
  const unavailable = page.getByRole("status", { name: "Activity continuation" });
  await expect(unavailable).toContainText("Continuation unavailable.");
  await expect(page.getByText("No matches on this page", { exact: true })).toBeVisible();
  await expect(page.getByText("No observed transactions in this window", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Load more →" })).toHaveCount(0);
  expect(reads.filter(r => r.resource === "transactions")).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("page-boundaries-activity-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("page-boundaries-activity-mobile.png"), fullPage: true });
  activityRecovered = true;
  await page.getByRole("button", { name: "Retry activity page" }).click();
  await page.getByRole("link", { name: "Load more →" }).click();
  await expect(page.getByRole("link", { name: "Newest activity" })).toBeVisible();
  await expect(page.getByText("No matches on this page", { exact: true })).toBeVisible();
  await expect(page.getByText("No observed transactions in this window", { exact: true })).toHaveCount(0);
  expect(reads.filter(r => r.resource === "transactions")).toEqual([
    { resource: "transactions", cursor: null },
    { resource: "transactions", cursor: null },
    { resource: "transactions", cursor: "ACT+/=source-cursor" },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});
