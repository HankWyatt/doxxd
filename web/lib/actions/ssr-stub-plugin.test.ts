// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ssrStubPlugin } from "./ssr-stub-plugin";

const stubPath = fileURLToPath(new URL("./build/stub.ts", import.meta.url));
const entryPath = fileURLToPath(new URL("./build/index.ts", import.meta.url));

const importer = fileURLToPath(
  new URL("../../components/wallet/portfolio.tsx", import.meta.url),
);

type Resolve = (
  this: { environment?: { name: string } },
  id: string,
  importer?: string,
) => unknown;

function resolve(environment: string | undefined, id: string, importer?: string) {
  const hook = ssrStubPlugin().resolveId as Resolve;
  return hook.call(
    { environment: environment ? { name: environment } : undefined },
    id,
    importer,
  );
}

describe("ssrStubPlugin", () => {
  it("runs before Vite's own resolver", () => {
    expect(ssrStubPlugin().enforce).toBe("pre");
  });

  it.each(["ssr", "rsc"])("stubs the build entry in the %s environment", (name) => {
    expect(resolve(name, "@/lib/actions/build")).toBe(stubPath);
    expect(resolve(name, "@/lib/actions/build/index")).toBe(stubPath);
    expect(resolve(name, entryPath)).toBe(stubPath);
    expect(resolve(name, "../../lib/actions/build", importer)).toBe(stubPath);
  });

  it("leaves the build entry alone in the client environment", () => {
    expect(resolve("client", "@/lib/actions/build")).toBeUndefined();
    expect(resolve("client", entryPath)).toBeUndefined();
  });

  it("stubs when the environment is unknown, so the Worker never gets the SDKs", () => {
    expect(resolve(undefined, "@/lib/actions/build")).toBe(stubPath);
  });

  it.each(["@wallet-standard/react-core", "@solana/react"])(
    "stubs %s outside the client environment only",
    (id) => {
      const walletStub = fileURLToPath(new URL("./wallet-stub.ts", import.meta.url));
      expect(resolve("ssr", id)).toBe(walletStub);
      expect(resolve(undefined, id)).toBe(walletStub);
      expect(resolve("client", id)).toBeUndefined();
    },
  );

  it("ignores other modules, including siblings of the entry", () => {
    expect(resolve("ssr", "@/lib/actions/availability")).toBeUndefined();
    expect(resolve("ssr", "@/lib/actions/build-other")).toBeUndefined();
    expect(resolve("ssr", "@/lib/actions/build/stub")).toBeUndefined();
    expect(resolve("ssr", "react")).toBeUndefined();
  });
});
