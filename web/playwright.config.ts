import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4318",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4318",
    url: "http://127.0.0.1:4318",
    reuseExistingServer: false,
    timeout: 60_000,
    // Deliberately invalid base: even unintercepted requests cannot reach DMND.
    // Explicit values override inherited or dotenv credentials.
    env: {
      DMND_API_BASE_URL: "http://disabled.invalid",
      DMND_API_KEY: "doxxd-synthetic-browser-secret",
      DMND_ENABLED_PROTOCOLS: "",
    },
  },
});
