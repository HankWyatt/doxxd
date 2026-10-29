import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// The lazy action entry (`lib/actions/build/index.ts`) pulls in web3.js and the
// protocol SDKs. Vinext bundles dynamic imports from client components into the
// Worker even though they only run on click, which cost about 380 KiB gzip in
// the spike. So every non-client Vite environment gets `build/stub.ts` instead.
const stubPath = fileURLToPath(new URL("./build/stub.ts", import.meta.url));
const buildDir = fileURLToPath(new URL("./build", import.meta.url));
const entryPath = resolve(buildDir, "index.ts");

// The wallet connection libraries run only in the browser after hydration, so
// the Worker gets the throwing stand-in for them too (keeps its size flat).
const walletStubPath = fileURLToPath(new URL("./wallet-stub.ts", import.meta.url));
const walletPackages = new Set(["@wallet-standard/react-core", "@solana/react"]);

// The header's account card (Radix Popover and its positioning code) is a lazy
// import that only runs after a wallet connects in the browser.
const menuPath = fileURLToPath(
  new URL("../../components/wallet-connect/account-menu.tsx", import.meta.url),
);
const menuStubPath = fileURLToPath(
  new URL("../../components/wallet-connect/account-menu.stub.ts", import.meta.url),
);

function isAccountMenu(id: string, importer: string | undefined): boolean {
  const bare = id.split("?")[0];
  if (/^@\/components\/wallet-connect\/account-menu(\.tsx)?$/.test(bare)) return true;
  const path =
    bare.startsWith(".") && importer
      ? resolve(dirname(importer.split("?")[0]), bare)
      : bare;
  return path === menuPath || path === menuPath.replace(/\.tsx$/, "");
}

function isBuildEntry(id: string, importer: string | undefined): boolean {
  const bare = id.split("?")[0];
  if (/^@\/lib\/actions\/build(\/index(\.ts)?)?$/.test(bare)) return true;
  const path =
    bare.startsWith(".") && importer
      ? resolve(dirname(importer.split("?")[0]), bare)
      : bare;
  return path === buildDir || path === entryPath || path === resolve(buildDir, "index");
}

export function ssrStubPlugin(): Plugin {
  return {
    name: "doxxd-actions-ssr-stub",
    enforce: "pre",
    resolveId(id, importer) {
      if (this.environment?.name === "client") return undefined;
      if (walletPackages.has(id)) return walletStubPath;
      if (isAccountMenu(id, importer)) return menuStubPath;
      return isBuildEntry(id, importer) ? stubPath : undefined;
    },
  };
}
