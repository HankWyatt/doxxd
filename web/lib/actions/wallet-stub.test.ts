// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as stub from "./wallet-stub";

// The stub must offer every name the app imports from the two stubbed packages.
describe("wallet stub", () => {
  it("covers every import from the wallet packages, each throwing if called", () => {
    const source = readFileSync(
      new URL("../../components/wallet-connect/provider.tsx", import.meta.url),
      "utf8",
    ) + readFileSync(
      new URL("../../components/wallet-connect/connect-button.tsx", import.meta.url),
      "utf8",
    );
    const used = new Set<string>();
    for (const m of source.matchAll(
      /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(?:@wallet-standard\/react-core|@solana\/react)"/g,
    ))
      for (const part of m[1].split(",")) {
        const name = part.trim();
        if (name && !name.startsWith("type ")) used.add(name);
      }
    expect([...used].sort()).toEqual(Object.keys(stub).sort());
    for (const value of Object.values(stub))
      expect(() => (value as () => unknown)()).toThrow(/browser/);
  });
});
