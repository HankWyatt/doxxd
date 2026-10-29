import type { Page } from "@playwright/test";
import type { ChainSummary } from "./action-rpc-chain";

// The synthetic-chain RPC helper (action-rpc-server.mjs), started by
// playwright.config.ts.
export const ACTION_RPC_HELPER = "http://127.0.0.1:4319";

/** The synthetic chain's addresses and amounts, for DMND rows that match it. */
export async function actionChain(): Promise<ChainSummary> {
  const response = await fetch(`${ACTION_RPC_HELPER}/fixture`);
  if (!response.ok) throw new Error(`action RPC helper: ${response.status}`);
  return (await response.json()) as ChainSummary;
}

/**
 * Answers the page's /api/rpc requests from chainFixture(), through the real
 * pass-through policy (tests/fixtures/mock-action-rpc.ts). `methods` records
 * every JSON-RPC method the page asked for, in order.
 */
export async function routeActionRpc(page: Page) {
  const methods: string[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postData() ?? "";
    let method = "?";
    try {
      const parsed: unknown = JSON.parse(body);
      const name = (parsed as { method?: unknown } | null)?.method;
      if (typeof name === "string") method = name;
    } catch {
      /* forwarded as is; the helper answers a parse error */
    }
    methods.push(method);
    const answer = await fetch(`${ACTION_RPC_HELPER}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: await answer.text(),
    });
  });
  return { methods };
}
