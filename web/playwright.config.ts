import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The dev server builds each route's client code on first request. Shared CI
  // runners can take longer than the local defaults to hydrate a cold route.
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  use: {
    baseURL: "http://127.0.0.1:4318",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: process.env.DOXXD_E2E_BUILT === "1"
        ? "npm run start -- --port 4318 --env-file /dev/null"
        : "npm run dev -- --host 127.0.0.1 --port 4318",
      url: "http://127.0.0.1:4318",
      reuseExistingServer: false,
      timeout: 60_000,
      // Deliberately invalid base: even unintercepted requests cannot reach DMND.
      // Explicit values override inherited or dotenv credentials.
      env: {
        DMND_API_BASE_URL: "http://disabled.invalid",
        DMND_API_KEY: "doxxd-synthetic-browser-secret",
        DMND_ENABLED_PROTOCOLS: "",
        // Wallet actions are off unless the server opts in and names an RPC
        // provider. Specs answer /api/rpc in the browser; anything that slips
        // through reaches only the synthetic chain helper below, never a
        // public Solana RPC.
        DOXXD_ACTIONS_ENABLED: "1",
        SOLANA_RPC_URL: "http://127.0.0.1:4319/rpc",
      },
    },
    // Synthetic-chain JSON-RPC for the LP action flows (lp-actions.spec.ts).
    {
      command: "node --disable-warning=DEP0040 tests/e2e/action-rpc-server.mjs",
      url: "http://127.0.0.1:4319/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
