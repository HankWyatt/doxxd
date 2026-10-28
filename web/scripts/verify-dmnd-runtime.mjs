import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { devNull } from "node:os";

const project = fileURLToPath(new URL("../", import.meta.url));
export function buildFingerprint(root) {
  const hash = createHash("sha256");
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        hash.update(path.slice(root.length));
        hash.update(readFileSync(path));
      } else throw new Error("Unsupported build artifact");
    }
  }
  walk(root);
  return hash.digest("hex");
}
export function assertRuntimeProof(buildRoot, receipt) {
  try {
    const proof = JSON.parse(readFileSync(receipt, "utf8"));
    const age = Date.now() - Date.parse(proof.at);
    if (
      proof.version !== 2 ||
      proof.guarded !== true ||
      proof.configured !== true ||
      proof.budgeted !== true ||
      proof.navigated !== true ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 3600000 ||
      proof.fingerprint !== buildFingerprint(buildRoot)
    )
      throw new Error();
  } catch {
    throw new Error("Built runtime proof is missing or stale");
  }
}
async function portNumber() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
export function assertRuntimeBindings(config) {
  for (const name of [
    "DMND_API_BASE_URL",
    "DMND_API_KEY",
    "DMND_ENABLED_PROTOCOLS",
    "DMND_ALLOWED_WALLETS",
    "DMND_REQUEST_BUDGET",
    "DMND_ACCEPTANCE_PROXY_TOKEN",
  ])
    if (!config.secrets?.required?.includes(name))
      throw new Error("Built runtime proof failed");
}
export async function verifyRuntime() {
  const buildRoot = join(project, "dist");
  const fingerprint = buildFingerprint(buildRoot);
  const config = JSON.parse(
    readFileSync(join(buildRoot, "server/wrangler.json"), "utf8"),
  );
  assertRuntimeBindings(config);
  const port = await portNumber(),
    token = randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(project, "scripts/sites-env.mjs"),
      join(project, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--config",
      "dist/server/wrangler.json",
      "--local",
      "--persist-to",
      ".wrangler/state",
      "--ip",
      "127.0.0.1",
      "--inspector-port",
      "0",
      "--port",
      String(port),
      "--env-file",
      devNull,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        DMND_API_BASE_URL: "https://doxxd.invalid",
        DMND_API_KEY: "synthetic-runtime-proof",
        DMND_ENABLED_PROTOCOLS: "",
        DMND_ALLOWED_WALLETS: "7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa",
        DMND_REQUEST_BUDGET: "1",
        DMND_ACCEPTANCE_PROXY_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  let exited = false;
  const done = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });
  try {
    let ready = false;
    const end = Date.now() + 60000;
    while (Date.now() < end && !exited) {
      try {
        const r = await fetch("http://127.0.0.1:" + port + "/", {
          signal: AbortSignal.timeout(2000),
        });
        await r.body?.cancel();
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("Built runtime proof failed");
    const url =
      "http://127.0.0.1:" +
      port +
      "/api/wallet/7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa/summary";
    const direct = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const directBody = await direct.json();
    if (direct.status !== 403 || directBody.kind !== "authentication")
      throw new Error("Built runtime proof failed");
    const authorized = await fetch(url, {
      headers: { "x-doxxd-acceptance-token": token },
      signal: AbortSignal.timeout(10000),
    });
    const authorizedBody = await authorized.json();
    if (authorized.status !== 502 || authorizedBody.kind !== "upstream")
      throw new Error("Built runtime proof failed");
    const exhausted = await fetch(url, {
      headers: { "x-doxxd-acceptance-token": token },
      signal: AbortSignal.timeout(10000),
    });
    if (exhausted.status !== 422 || (await exhausted.json()).kind !== "refused")
      throw new Error("Built runtime proof failed");
    const { verifyBuiltNavigation } = await import("./verify-built-navigation.mjs");
    await verifyBuiltNavigation("http://127.0.0.1:" + port);
    if (buildFingerprint(buildRoot) !== fingerprint)
      throw new Error("Built runtime proof failed");
    const proof = {
      version: 2,
      at: new Date().toISOString(),
      fingerprint,
      guarded: true,
      configured: true,
      budgeted: true,
      navigated: true,
    };
    writeFileSync(
      join(project, ".sites-runtime/dmnd-runtime-proof.json"),
      JSON.stringify(proof, null, 2) + "\n",
    );
    return proof;
  } finally {
    if (!exited) child.kill("SIGTERM");
    await done;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const proof = await verifyRuntime();
    process.stdout.write(JSON.stringify(proof) + "\n");
  } catch {
    process.stderr.write(
      "Built runtime proof failed; no live credential was loaded.\n",
    );
    process.exitCode = 1;
  }
}
