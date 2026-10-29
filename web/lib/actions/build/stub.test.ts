// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as stub from "./stub";

// Reads the real entry as text instead of importing it, so the suite does not
// load web3.js and the SDKs. Covers `export function|const|class name` and
// `export { a, b }`; extend if the entry ever re-exports with `export *`.
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(","))
      if (part.trim()) names.add(part.trim().split(/\s+as\s+/).pop()!);
  return [...names].sort();
}

describe("build stub", () => {
  it("exports the same names as the real entry, each throwing if called", () => {
    const entry = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(entry).not.toMatch(/^export\s+\*/m);
    const names = exportedNames(entry);
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(stub).sort()).toEqual(names);
    for (const value of Object.values(stub)) {
      expect(() => (value as () => unknown)()).toThrow(/browser/);
    }
  });
});
