import { test, expect } from "@playwright/test";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";
import { mockWalletResources, waitForWalletHydration } from "./mock-wallet-resources";

test("search, direct entry, tabs, back, and no fixture fallback", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Solana address" })
    .fill("not-an-address");
  await page.getByRole("button", { name: "Explore wallet" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a valid Solana address.",
  );
  await page
    .getByRole("textbox", { name: "Solana address" })
    .fill(`  ${DEMO_ADDRESS}  `);
  await page.getByRole("button", { name: "Explore wallet" }).click();
  await expect(page).toHaveURL(`/wallet/${DEMO_ADDRESS}`);
  await expect(
    page.getByText("Data connection unavailable", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("$12,345.67", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Demo data", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(`/wallet/${DEMO_ADDRESS}/activity`);
  await page.goBack();
  await expect(page).toHaveURL(`/wallet/${DEMO_ADDRESS}`);
  await page.goto("/wallet/O0Il");
  await expect(
    page.getByText("That Solana address isn’t valid."),
  ).toBeVisible();
  await page.goto(`/wallet/${encodeURIComponent(" " + DEMO_ADDRESS + " ")}`);
  await expect(
    page.getByText("That Solana address isn’t valid."),
  ).toBeVisible();
});

test("public demo and sample-data API routes are removed", async ({ page, request }) => {
  const response = await page.goto("/demo");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("$12,345.67", { exact: true })).toHaveCount(0);
  const api = await request.get("/api/demo/summary");
  expect(api.status()).toBe(404);
  await page.goto("/");
  await expect(page.locator('a[href^="/demo"]')).toHaveCount(0);
});

test("portfolio expands with keyboard, copies, and refreshes", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockWalletResources(page);
  let summaries = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/wallet/${DEMO_ADDRESS}/summary`) summaries++;
  });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible();
  const holding = page.getByRole("button", {
    name: "Inspect BONK holding",
    exact: true,
  });
  await holding.focus();
  await expect(holding).toBeFocused();
  await holding.press("Enter");
  await expect(holding).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Raw atoms", { exact: true })).toBeVisible();
  await expect(
    page.getByText("$0.00002", { exact: true }).first(),
  ).toBeVisible();
  const kamino = page.getByRole("button", {
    name: "Collapse Kamino Lend",
    exact: true,
  });
  await expect(kamino).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#protocol-kamino table")).toBeVisible();
  await page.locator("#protocol-kamino table button").first().click();
  await expect(page.locator("#protocol-kamino .detail-row")).toBeVisible();
  await page.getByRole("button", { name: "Copy wallet address" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    DEMO_ADDRESS,
  );
  const before = summaries;
  await page.getByRole("button", { name: "Refresh wallet" }).click();
  await expect.poll(() => summaries).toBeGreaterThan(before);
});

test("activity details, UTC bounds and empty continuation remain navigable", async ({
  page,
}) => {
  const fixtureApi = await mockWalletResources(page);
  await page.goto(`/wallet/${DEMO_ADDRESS}/activity`);
  await waitForWalletHydration(page);
  const transaction = page
    .getByRole("button", { name: /^Inspect transaction/ })
    .first();
  await transaction.focus();
  await transaction.press("Space");
  await expect(transaction).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText("Observed executions", { exact: true }).last(),
  ).toBeVisible();
  await page.getByLabel("From (UTC)", { exact: true }).fill("2026-10-22T00:00");
  await page.getByLabel("To (UTC)", { exact: true }).fill("2026-10-23T00:00");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("from"))
    .toBe("2026-10-22T00:00:00.000Z");
  await expect(
    page.getByRole("button", { name: /^Inspect transaction/ }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^Inspect transaction/ }),
  ).toHaveCount(4);
  fixtureApi.setScenario("activity-continuation");
  await page.goto(`/wallet/${DEMO_ADDRESS}/activity`);
  await waitForWalletHydration(page);
  await expect(
    page.getByText("Another page is available", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Load more →" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("cursor"))
    .toBe("demo-next");
  await expect(
    page.getByRole("button", { name: /^Inspect transaction/ }),
  ).toHaveCount(4);
  await page.goBack();
  await waitForWalletHydration(page);
  await expect(
    page.getByText("Another page is available", { exact: true }),
  ).toBeVisible();
});

test("390px portfolio and activity stay within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWalletResources(page);
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible();
  await page.getByText("Full address", { exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect SOL holding", exact: true })
    .click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await waitForWalletHydration(page);
  await page
    .getByRole("button", { name: /^Inspect transaction/ })
    .first()
    .click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("From (UTC)", { exact: true })).toBeVisible();
});

test("native staking source details retain raw epochs on desktop and mobile", async ({ page }) => {
  // Synthetic source data: the sentinel remains an epoch string, never a date or balance.
  await mockWalletResources(page);
  const fixture = readFixture("stake", "complete");
  if (!fixture.ok) throw Error("Expected synthetic stake fixture");
  fixture.data.data[0].lockup_epoch = "18446744073709551615";
  await page.route(`**/api/wallet/${DEMO_ADDRESS}/stake?**`, route =>
    route.fulfill({ status: 200, json: fixture }),
  );
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (/hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Demo data", { exact: true })).toHaveCount(0);
  const section = page.locator("#protocol-stake");
  await expect(section.getByRole("button", { name: "Collapse Native staking", exact: true })).toHaveAttribute("aria-expanded", "true");
  await section.locator(".data-row button").click();
  const detail = section.locator(".detail-row");
  const field = (label: string) => detail.locator("dl > div")
    .filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
  await expect(field("Account lamports")).toHaveText("10000000000");
  await expect(field("Staker")).toHaveText(DEMO_ADDRESS);
  await expect(field("Authorized withdrawer")).toHaveText(DEMO_ADDRESS);
  await expect(field("Lockup Unix timestamp (seconds)")).toHaveText("0");
  await expect(field("Lockup epoch")).toHaveText("18446744073709551615");
  await expect(field("Lockup custodian")).toHaveText(DEMO_ADDRESS);
  await expect(field("Activation epoch")).toHaveText("700");
  await expect(field("Deactivation epoch")).toHaveText("Unknown");
  await expect(field("Valuation / delegation basis"))
    .toContainText("not effective or withdrawable stake");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect(field("Lockup epoch")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  expect(errors).toEqual([]);
});
