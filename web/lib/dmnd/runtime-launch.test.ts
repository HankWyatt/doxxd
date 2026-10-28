// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  runtimeConfiguration,
  safeOutput,
  claimGrant,
  resumeGrant,
  claimLease,
} from "../../scripts/run-dmnd.mjs";
const paths: string[] = [];
it("resumes only the exact reconciled grant while preserving spent requests", () => {
  const root = mkdtempSync(join(tmpdir(), "doxxd-resume-test-"));
  paths.push(root);
  const file = join(root, "grant.json");
  claimGrant(file, 34);
  writeFileSync(file, JSON.stringify({
    allocatedRequests: 34,
    usedRequests: 8,
    requests: Array.from({ length: 8 }, () => ({
      wallet: "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa", status: 200,
    })),
  }));
  const original = readFileSync(file, "utf8");
  expect(() => resumeGrant(file, 34, 7)).toThrow("Live acceptance grant cannot be reconciled");
  expect(() => resumeGrant(file, 33, 8)).toThrow("Live acceptance grant cannot be reconciled");
  resumeGrant(file, 34, 8);
  expect(readFileSync(file, "utf8")).toBe(original);
  writeFileSync(file, original.replace('"status":200', '"status":null'));
  expect(() => resumeGrant(file, 34, 8)).toThrow("Live acceptance grant cannot be reconciled");
});
it("permits only one launcher lease until its owner releases it", () => {
  const root = mkdtempSync(join(tmpdir(), "doxxd-lease-test-"));
  paths.push(root);
  const file = join(root, "lease.json");
  const release = claimLease(file);
  expect(() => claimLease(file)).toThrow("Live acceptance runtime is already owned");
  release();
  const again = claimLease(file);
  again();
});
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true });
});
function privateFile() {
  const root = mkdtempSync(join(tmpdir(), "doxxd-runtime-test-"));
  paths.push(root);
  const path = join(root, "synthetic.private");
  writeFileSync(path, "doxxd-synthetic-runtime-secret\n", { mode: 0o600 });
  return path;
}
it("does not silently renew the approved request budget after a runtime restart", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "doxxd-grant-test-")),
    "grant.json",
  );
  paths.push(join(path, ".."));
  claimGrant(path, 34);
  expect(() => claimGrant(path, 34)).toThrow(
    "Live acceptance grant is already claimed",
  );
});
it("loads external custody into only server runtime fields with a fixed acceptance scope", () => {
  const runtime = runtimeConfiguration(
    { keyFile: privateFile(), port: 4327 },
    { PATH: "/test" },
  );
  expect(runtime.env.DMND_API_KEY).toBe("doxxd-synthetic-runtime-secret");
  expect(runtime.env.DMND_REQUEST_BUDGET).toBe("34");
  expect(runtime.env.DMND_ENABLED_PROTOCOLS).toBe("");
  expect(runtime.env.DMND_ALLOWED_WALLETS).toBe(
    "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa,7ZcdCFE2eRM5VpNy2ETofVGizwPeXLWLDCceXt4NhqvF",
  );
  expect(
    Object.keys(runtime.env).some((k) => k.startsWith("NEXT_PUBLIC_")),
  ).toBe(false);
  expect(runtime.port).toBe(4327);
});
it("refuses broadly readable custody and never echoes its content in errors", () => {
  const path = privateFile();
  chmodSync(path, 0o644);
  expect(() => runtimeConfiguration({ keyFile: path }, {})).toThrow(
    "Private credential is unavailable or unsafe",
  );
});
it("redacts credentials from diagnostic output", () => {
  expect(
    safeOutput(
      "request ?api_key=doxxd-synthetic-runtime-secret failed",
      "doxxd-synthetic-runtime-secret",
    ),
  ).toBe("request ?api_key=[redacted] failed");
});
it("also redacts URL-encoded credentials", () => {
  expect(
    safeOutput("encoded=synthetic%2Fkey%2Bvalue", "synthetic/key+value"),
  ).toBe("encoded=[redacted]");
});

it("configures an explicitly reconciled resume with external synthetic custody", () => {
  const runtime = runtimeConfiguration(
    { keyFile: privateFile(), port: 4327, requestBudget: 34, resumeUsedRequests: 8 },
    { PATH: "/test" },
  );
  expect(runtime.env.DMND_REQUEST_BUDGET).toBe("34");
  expect(runtime.port).toBe(4327);
  expect(() => runtimeConfiguration({ keyFile: privateFile(), requestBudget: 34, resumeUsedRequests: 34 }, {})).toThrow("Invalid runtime configuration");
});

it("requires a pinned scoped receipt for 42 and keeps the Worker budget at 34", () => {
  const keyFile = privateFile();
  const extensionReceiptFile = join(keyFile, "..", "extension.json");
  const bytes = JSON.stringify({ new_bounded_validation_allocation: {
    additional_requests_max: 8, old_lifetime_cap: 34, new_lifetime_cap: 42,
    already_used: 29, expires_at: "2099-10-23T10:15:00Z",
    allowed_resources: ["overview"],
    allowed_wallets: ["7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa", "7ZcdCFE2eRM5VpNy2ETofVGizwPeXLWLDCceXt4NhqvF"],
    unpaged_overview: true, response_max_bytes: 8388608, timeout_ms: 8000,
  } });
  writeFileSync(extensionReceiptFile, bytes, { mode: 0o600 });
  const extensionReceiptSha256 = createHash("sha256").update(bytes).digest("hex");
  expect(() => runtimeConfiguration({ keyFile, requestBudget: 42, resumeUsedRequests: 29 }, {})).toThrow();
  const runtime = runtimeConfiguration({ keyFile, requestBudget: 42, resumeUsedRequests: 29,
    extensionReceiptFile, extensionReceiptSha256 }, {});
  expect(runtime.env.DMND_REQUEST_BUDGET).toBe("34");
  expect(runtime.requestBudget).toBe(42);
  expect(runtime.extensionMode).toBe("bonus");
  expect(() => claimGrant(join(keyFile, "..", "grant-42.json"), 42)).toThrow();
});

// A wrong profile branch would leave normal staking disabled or broaden the wallet scope.
it("enables only the separately scoped small-wallet staking profile", () => {
  const root = mkdtempSync(join(tmpdir(), "doxxd-stake-profile-"));
  paths.push(root);
  const scopeFile = new URL("../../tests/fixtures/dmnd-native-stake-scope-20261025.json", import.meta.url).pathname;
  const scope = JSON.parse(readFileSync(scopeFile, "utf8"));
  const readinessFile = join(root, "readiness.json");
  const bytes = JSON.stringify({ at: new Date().toISOString(), all_health_200: true,
    provider_requests: 0, wallet_GETs: 0, production_mutations: 0,
    services: [scope.fresh_readiness.api, scope.fresh_readiness.worker] });
  writeFileSync(readinessFile, bytes, { mode: 0o600 });
  const runtime = runtimeConfiguration({ keyFile: privateFile(),
    profile: "native-stake-small-wallet-3-20261025", scopeFile, readinessFile,
    readinessSha256: createHash("sha256").update(bytes).digest("hex") }, {});
  expect(runtime.env.DMND_ENABLED_PROTOCOLS).toBe("stake");
  expect(runtime.env.DMND_ALLOWED_WALLETS).toBe("Fsx2Z8MEvG4DrBKq6mZBDaURMMKtPECjNKfeF15RfK4X");
  expect(runtime.env.DMND_REQUEST_BUDGET).toBe("3");
  expect(runtime.requestBudget).toBe(3);
});

// A wrong branch must not broaden earlier allowances or enable protocol reads.
it("loads the separate new-address four-read profile without enabling protocols", () => {
  const root = mkdtempSync(join(tmpdir(), "doxxd-new-address-profile-"));
  paths.push(root);
  const scopeFile = new URL("../../tests/fixtures/dmnd-new-address-scope-20261025.json", import.meta.url).pathname;
  const qualified = JSON.parse(readFileSync(new URL("../../tests/fixtures/dmnd-native-stake-scope-20261025.json", import.meta.url), "utf8")).fresh_readiness;
  const readinessFile = join(root, "health.json");
  const bytes = JSON.stringify({ at: new Date().toISOString(), all_health_200: true,
    provider_requests: 0, wallet_GETs: 0, production_mutations: 0,
    services: [qualified.api, qualified.worker] });
  writeFileSync(readinessFile, bytes, { mode: 0o600 });
  const runtime = runtimeConfiguration({ keyFile: privateFile(),
    profile: "new-address-initial-refresh-4-20261025", scopeFile, readinessFile,
    readinessSha256: createHash("sha256").update(bytes).digest("hex") }, {});
  expect(runtime.env.DMND_ENABLED_PROTOCOLS).toBe("");
  expect(runtime.env.DMND_ALLOWED_WALLETS).toBe("aLqXroJ6z41nDQ9zEmqj5mPU86DJ1LXfABfAKxFzDS2");
  expect(runtime.env.DMND_REQUEST_BUDGET).toBe("4");
  expect(runtime.requestBudget).toBe(4);
});
