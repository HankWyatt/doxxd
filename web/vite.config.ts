import { existsSync, readFileSync } from "node:fs";
import vinext from "vinext";
import { defineConfig } from "vite";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { configureToolEnvironment } from "./scripts/tool-environment.mjs";
import { sites } from "./scripts/vite/sites-vite-plugin";
import { connectorPreview } from "./scripts/vite/connector-preview-plugin.mjs";
import { ssrStubPlugin } from "./lib/actions/ssr-stub-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// Optional local Sites hosting bindings. The file is git-ignored; without it
// the app runs with no D1 or R2 binding, which the public wallet views need.
const hostingConfigPath = new URL("./.openai/hosting.json", import.meta.url);
const { d1, r2 }: { d1?: string | null; r2?: string | null } = existsSync(
  hostingConfigPath,
)
  ? JSON.parse(readFileSync(hostingConfigPath, "utf8"))
  : { d1: null, r2: null };

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  // Explicit names make Wrangler import only these host values as secret_text.
  // This also keeps the built Worker aligned with dev's server environment.
  secrets: {
    required: [
      "DMND_API_BASE_URL",
      "DMND_API_KEY",
      "DMND_ENABLED_PROTOCOLS",
      "DMND_ALLOWED_WALLETS",
      "DMND_REQUEST_BUDGET",
      "DMND_ACCEPTANCE_PROXY_TOKEN",
      "DOXXD_ACTIONS_ENABLED",
      "SOLANA_RPC_URL",
    ],
  },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  configureToolEnvironment(process.cwd());

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    // Keep RSC client references and browser imports on the same icon module.
    // Prebundling this package caused virtual client-reference imports to fail.
    optimizeDeps: { exclude: ["lucide-react", "next/link", "next/navigation"] },
    server: {
      ...(managedLinux
        ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] }
        : {}),
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      // Keeps web3.js and the SDKs out of the Worker bundle (see the plugin).
      ssrStubPlugin(),
      vinext(),
      sites({ mockAuth: !managedLinux }),
      connectorPreview(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: {
          ...localBindingConfig,
          ...(command === "serve"
            ? {
                services: [
                  {
                    binding: "CONNECTORS",
                    service: "sites-connector-preview",
                    entrypoint: "ConnectorPreview",
                  },
                ],
              }
            : {}),
        },
        ...(command === "serve"
          ? {
              auxiliaryWorkers: [
                {
                  config: {
                    name: "sites-connector-preview",
                    main: "./scripts/connector-preview/worker.mjs",
                    compatibility_date: "2026-05-15",
                  },
                },
              ],
            }
          : {}),
      }),
    ],
  };
});
