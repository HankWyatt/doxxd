// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRuntimeProof,
  buildFingerprint,
  assertRuntimeBindings,
} from "../../scripts/verify-dmnd-runtime.mjs";
const paths: string[] = [];
it("refuses a canary build that could fall back to the live API because its base binding is absent", () => {
  expect(() =>
    assertRuntimeBindings({
      secrets: {
        required: [
          "DMND_API_KEY",
          "DMND_REQUEST_BUDGET",
          "DMND_ACCEPTANCE_PROXY_TOKEN",
        ],
      },
    }),
  ).toThrow("Built runtime proof failed");
});
afterEach(() =>
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true })),
);
it("requires a fresh executed proof of the exact build before private startup", () => {
  const root = mkdtempSync(join(tmpdir(), "doxxd-build-proof-"));
  paths.push(root);
  const artifact = join(root, "worker.js");
  writeFileSync(artifact, "synthetic build");
  const receipt = join(
    tmpdir(),
    "doxxd-proof-" + root.split("/").at(-1) + ".json",
  );
  paths.push(receipt);
  expect(() => assertRuntimeProof(root, receipt)).toThrow(
    "Built runtime proof is missing or stale",
  );
  const proof = {
    version: 2,
    at: new Date().toISOString(),
    fingerprint: buildFingerprint(root),
    guarded: true,
    configured: true,
    budgeted: true,
    navigated: true,
  };
  writeFileSync(receipt, JSON.stringify({ ...proof, navigated: false }));
  expect(() => assertRuntimeProof(root, receipt)).toThrow(
    "Built runtime proof is missing or stale",
  );
  writeFileSync(receipt, JSON.stringify(proof));
  expect(() => assertRuntimeProof(root, receipt)).not.toThrow();
  writeFileSync(artifact, "changed build");
  expect(() => assertRuntimeProof(root, receipt)).toThrow(
    "Built runtime proof is missing or stale",
  );
});
