import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "lib/**/*.test.{ts,tsx}",
      "worker/**/*.test.ts",
      "components/**/*.test.{ts,tsx}",
      "tests/fixtures/**/*.test.ts",
    ],
    maxWorkers: 2,
    // Suites that load the Solana SDKs (tests/fixtures/actions-chain.ts) run
    // their Node builds, which print two known, harmless notices: web3.js's
    // node-fetch pulls in the deprecated `punycode` module (DEP0040), and
    // bigint-buffer falls back to pure JS because installs skip native
    // builds (--ignore-scripts). Drop exactly those two so output stays clean.
    execArgv: ["--disable-warning=DEP0040"],
    onConsoleLog: (log) =>
      log.startsWith("bigint: Failed to load bindings") ? false : undefined,
  },
});
