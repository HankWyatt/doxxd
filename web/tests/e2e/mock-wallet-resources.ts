import type { Page } from "@playwright/test";
import { DEMO_ADDRESS, readFixture } from "../../lib/fixtures/wallet";
import type { FixtureScenario } from "../../lib/dmnd/contracts";
import { isResource } from "../../lib/dmnd/resources";
import { parseResourceQuery } from "../../lib/dmnd/query";

// Full document navigation can finish while client modules are still loading.
// AddressSearch enables this input only after its hydration effect has run.
export async function waitForWalletHydration(page: Page) {
  await page.locator('input[aria-label="Solana address"]:enabled')
    .waitFor({ state: "visible", timeout: 15_000 });
}

// Test-only transport fixtures. The application has no public sample-data route.
export async function mockWalletResources(
  page: Page,
  initialScenario: FixtureScenario = "complete",
) {
  let scenario = initialScenario;
  await page.route(`**/api/wallet/${DEMO_ADDRESS}/**`, async (route) => {
    const url = new URL(route.request().url());
    const resource = url.pathname.split("/").at(-1);
    if (!resource || !isResource(resource))
      return route.fulfill({ status: 404, json: { ok: false, kind: "invalid_input" } });
    const query = parseResourceQuery(resource, url.searchParams);
    if (query === null)
      return route.fulfill({ status: 400, json: { ok: false, kind: "invalid_input" } });
    const result = readFixture(resource, scenario, query);
    return route.fulfill({ status: result.ok ? 200 : 502, json: result });
  });
  return {
    wallet: DEMO_ADDRESS,
    setScenario(next: FixtureScenario) { scenario = next; },
  };
}
