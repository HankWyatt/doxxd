import { test, expect } from "@playwright/test";
import bs58 from "bs58";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";
import { mockWalletResources, waitForWalletHydration } from "./mock-wallet-resources";

test("pending, stale, unpriced, and protocol failure preserve honest values", async ({
  page,
}) => {
  const fixtureApi = await mockWalletResources(page, "pending");
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(page.getByText("Demo data", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(/\d+ sources still updating/),
  ).toBeVisible();
  await expect(page.getByText("$0.00", { exact: true })).toHaveCount(0);
  fixtureApi.setScenario("stale");
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await expect(
    page.getByText(/^Saved data from/),
  ).toBeVisible();
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible();
  fixtureApi.setScenario("unpriced");
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  const unpriced = page
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: "Inspect UNPRICED holding" }),
    });
  await expect(unpriced).toContainText("—");
  await expect(unpriced).toContainText("500");
  fixtureApi.setScenario("protocol-error");
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await page
    .getByRole("button", { name: "Expand Orca Whirlpools", exact: true })
    .click();
  await expect(
    page.locator("#protocol-orca").getByText("Couldn’t load this section"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect SOL holding", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible();
});

test("429 cooldown prevents premature refresh and recovers automatically without exposing credentials", async ({
  page,
}) => {
  const browserUrls: string[] = [];
  const browserBodies: string[] = [];
  const summaryRequestTimes: number[] = [];
  let summaryCalls = 0;
  page.on("request", (request) => browserUrls.push(request.url()));
  page.on("response", async (response) => {
    if (response.url().includes("/api/"))
      browserBodies.push(await response.text());
  });
  await page.route("**/api/wallet/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/summary")) {
      summaryRequestTimes.push(performance.now());
      summaryCalls++;
      await route.fulfill(summaryCalls === 1 ? {
        status: 429,
        json: { ok: false, kind: "rate_limited", retryAfterSeconds: 10 },
      } : { status: 200, json: readFixture("summary", "complete") });
    } else
      await route.fulfill({
        status: 503,
        json: { ok: false, kind: "configuration" },
      });
  });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  const cooldown = page.getByRole("button", { name: /^Retry in / });
  await expect(cooldown).toBeDisabled();
  await page.getByRole("button", { name: "Refresh wallet" }).click();
  expect(summaryCalls).toBe(1);
  await expect.poll(() => summaryCalls, { timeout: 15_000 }).toBe(2);
  expect(summaryRequestTimes[1] - summaryRequestTimes[0]).toBeGreaterThanOrEqual(10_000);
  await expect(page.getByText("$12,345.67", { exact: true })).toBeVisible();
  await expect(cooldown).toHaveCount(0);
  expect(browserUrls.join("\n")).not.toContain(
    "doxxd-synthetic-browser-secret",
  );
  expect(browserBodies.join("\n")).not.toContain(
    "doxxd-synthetic-browser-secret",
  );
});

test("wallet A cannot replace B after navigation while A is delayed", async ({
  page,
}) => {
  const walletB = bs58.encode(new Uint8Array(32).fill(22));
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/wallet/**", async (route) => {
    const url = new URL(route.request().url());
    const resource = url.pathname.split("/").at(-1);
    if (resource !== "summary")
      return route.fulfill({
        status: 503,
        json: { ok: false, kind: "configuration" },
      });
    const isA = url.pathname.includes(DEMO_ADDRESS);
    if (isA) {
      began();
      await held;
    }
    const result = readFixture("summary", "complete");
    if (!result.ok) throw new Error("Invalid fixture");
    result.data.wallet = isA ? DEMO_ADDRESS : walletB;
    result.data.known_component_net_value_usd = isA ? "111111.11" : "222222.22";
    await route.fulfill({ json: result }).catch(() => {}); // Navigation may abort the held A request.
  });
  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  await started;
  await page.getByRole("textbox", { name: "Solana address" }).fill(walletB);
  await page.getByRole("button", { name: "Explore wallet" }).click();
  await expect(page.getByText("$222,222.22", { exact: true })).toBeVisible();
  release();
  await expect(page.getByText("$111,111.11", { exact: true })).toHaveCount(0);
  await expect(page.getByText("$222,222.22", { exact: true })).toBeVisible();
});

test("real gateway safely reports missing configuration and no secret", async ({
  request,
}) => {
  const response = await request.get(`/api/wallet/${DEMO_ADDRESS}/summary`);
  expect(response.status()).toBe(503);
  expect(await response.json()).toEqual({ ok: false, kind: "configuration" });
  expect(await response.text()).not.toContain("doxxd-synthetic-browser-secret");
  const invalid = await request.get(
    `/api/wallet/${encodeURIComponent(" " + DEMO_ADDRESS + " ")}/summary`,
  );
  expect(invalid.status()).toBe(400);
});
