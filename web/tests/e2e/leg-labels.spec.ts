import { expect, test } from "@playwright/test";
import { DEMO_ADDRESS, MINTS, readFixture } from "../../lib/fixtures/wallet";
import type { Schemas } from "../../lib/dmnd/contracts";
import { short } from "../../lib/portfolio/adapters/shared";
import { cpmmPage } from "../fixtures/synthetic-raydium-positions";
import { syntheticAddress } from "../fixtures/synthetic-meteora-damm-v2";
import { mockWalletResources, waitForWalletHydration } from "./mock-wallet-resources";

// Synthetic only. A CPMM leg the wallet does not hold carries DMND's own
// labels; a leg it holds without them falls back to the holdings labels; a
// leg with neither keeps its short mint; wrapped SOL reads as SOL.
const UNHELD = syntheticAddress("leg-labels/unheld-token");
const BARE = syntheticAddress("leg-labels/bare-token");
const UNHELD_IMAGE = "https://tokens.example.com/syn-unheld.png";
const HELD_IMAGE = "https://tokens.example.com/jup.png";
// A one-colour SVG answers every image request: nothing leaves the test.
const PIXEL = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#888"/></svg>';

test("CPMM legs show DMND, holdings and fallback labels with their images", async ({ page }) => {
  await mockWalletResources(page);
  const images: string[] = [];
  await page.route("https://tokens.example.com/**", (route) => {
    images.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: PIXEL });
  });
  const cpmm = cpmmPage();
  cpmm.wallet = DEMO_ADDRESS;
  const [lp] = cpmm.data;
  cpmm.data = [
    {
      ...lp,
      principal: [
        { ...lp.principal[0], mint: UNHELD, symbol: "SYNU", name: "Synthetic unheld", image_url: UNHELD_IMAGE, ui_amount: "1.5" },
        { ...lp.principal[1], mint: MINTS.jup, ui_amount: "0.75" },
      ],
    },
    {
      ...lp,
      owner_token_account: syntheticAddress("leg-labels/second-lp-account"),
      principal: [
        { ...lp.principal[0], mint: MINTS.sol, symbol: "WSOL", ui_amount: "2" },
        { ...lp.principal[1], mint: BARE, ui_amount: "3" },
      ],
    },
  ];
  cpmm.coverage.total_candidates = 2;
  const summary = readFixture("summary", "complete");
  const overview = readFixture("overview", "complete");
  if (!summary.ok || !overview.ok) throw new Error("Fixtures must succeed");
  const [native] = summary.data.components;
  summary.data.components.push({
    ...native,
    id: "raydium_cpmm",
    source_path: `/wallets/${DEMO_ADDRESS}/fungible-liquidity-positions?protocol=raydium_cpmm`,
    known_asset_value_usd: "50",
    known_net_value_usd: "50",
  } satisfies Schemas["WalletPortfolioComponent"]);
  for (const asset of overview.data.assets)
    if (asset.mint === MINTS.jup) asset.image_url = HELD_IMAGE;
  const answers: Record<string, unknown> = {
    "raydium-cpmm": { ok: true, data: cpmm },
    summary,
    overview,
  };
  await page.route(`**/api/wallet/${DEMO_ADDRESS}/**`, (route) => {
    const resource = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return resource in answers
      ? route.fulfill({ status: 200, json: answers[resource] })
      : route.fallback();
  });

  await page.goto(`/wallet/${DEMO_ADDRESS}`);
  await waitForWalletHydration(page);
  const card = page.locator("#protocol-raydium-cpmm");
  const first = card.locator("tr.data-row", { hasText: "SYNU + JUP" });
  await expect(first).toBeVisible();
  await expect(first.locator("strong", { hasText: "SYNU + JUP" })).toHaveAttribute(
    "title",
    UNHELD + " + " + MINTS.jup,
  );
  const icons = first.locator(".pair-icons > .token-icon");
  await expect(icons.nth(0).locator("img")).toHaveAttribute("src", UNHELD_IMAGE);
  await expect(icons.nth(1).locator("img")).toHaveAttribute("src", HELD_IMAGE);
  await expect.poll(() => [...new Set(images)].sort()).toEqual([HELD_IMAGE, UNHELD_IMAGE].sort());

  const second = card.locator("tr.data-row", { hasText: "SOL + " + short(BARE) });
  await expect(second).toBeVisible();
  await expect(second).not.toContainText("WSOL");
  const pair = second.locator(".pair-icons > .token-icon");
  await expect(pair.nth(0).locator("svg")).toHaveCount(1);
  await expect(pair.nth(1)).toHaveText(short(BARE).slice(0, 1));
  await second.getByRole("button", { name: /details/ }).click();
  await expect(card.locator(".detail-row")).toContainText(BARE);
});
