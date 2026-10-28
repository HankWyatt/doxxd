import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { relative, isAbsolute, resolve } from "node:path";
import { devNull } from "node:os";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { APPROVED_WALLETS } from "./dmnd-acceptance.mjs";
import { startAcceptanceProxy } from "./acceptance-proxy.mjs";
import { assertRuntimeProof, buildFingerprint } from "./verify-dmnd-runtime.mjs";
import { loadExtensionReceipt, readGrant, validateGrant, resumeExtensionGrant } from "./native-overview-extension.mjs";
import { NATIVE_STAKE_SCOPE, NATIVE_STAKE_WALLET, loadNativeStakeProfile,
  assertNativeStakeProfile, nativeStakeGrantPath, claimNativeStakeGrant,
  assertNativeStakeRehearsal } from "./native-stake-profile.mjs";
import { NEW_ADDRESS_SCOPE, NEW_ADDRESS_WALLET, loadNewAddressProfile,
  assertNewAddressProfile, newAddressGrantPath, claimNewAddressGrant,
  assertNewAddressRehearsal } from "./new-address-profile.mjs";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const safeOutput = (line, key) =>
  [
    key,
    encodeURIComponent(key),
    new URLSearchParams({ api_key: key }).toString().slice(8),
  ].reduce((text, secret) => text.split(secret).join("[redacted]"), line);
export function claimGrant(path, budget) {
  if (!Number.isInteger(budget) || budget < 1 || budget > 34)
    throw new Error("Invalid live acceptance grant");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        claimedAt: new Date().toISOString(),
        allocatedRequests: budget,
        usedRequests: 0,
        requests: [],
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    throw new Error("Live acceptance grant is already claimed");
  }
}
export function resumeGrant(path, budget, used, extension) {
  try {
    if (extension) {
      resumeExtensionGrant(path, budget, used, extension);
      return;
    }
    const { state } = readGrant(path);
    validateGrant(state);
    if (
      !Number.isInteger(budget) || budget < 1 || budget > 34 ||
      !Number.isInteger(used) || used < 0 || used >= budget ||
      state.allocatedRequests !== budget || state.usedRequests !== used
    ) throw new Error();
  } catch {
    throw new Error("Live acceptance grant cannot be reconciled");
  }
}
export function claimLease(path) {
  const token = randomBytes(16).toString("hex");
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, token }) + "\n", {
      flag: "wx", mode: 0o600,
    });
  } catch {
    throw new Error("Live acceptance runtime is already owned");
  }
  return () => {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (state.pid === process.pid && state.token === token) unlinkSync(path);
    } catch {}
  };
}
/** @param {any} config @param {Record<string,string|undefined>} [inherited] @param {any} [preparedProfile] */
export function runtimeConfiguration(config, inherited = process.env, preparedProfile = undefined) {
  const stakeProfile = config?.profile === NATIVE_STAKE_SCOPE;
  const newAddress = config?.profile === NEW_ADDRESS_SCOPE;
  const allowed = stakeProfile || newAddress
    ? ["keyFile", "port", "profile", "scopeFile", "readinessFile", "readinessSha256", "syntheticProofFile", "syntheticProofSha256"]
    : ["keyFile", "port", "requestBudget", "resumeUsedRequests", "extensionReceiptFile", "extensionReceiptSha256"];
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (key) => !allowed.includes(key),
    )
  )
    throw new Error("Invalid runtime configuration");
  const port = config.port ?? 4317,
    budget = stakeProfile ? 3 : newAddress ? 4 : config.requestBudget ?? 34;
  if (
    config.resumeUsedRequests !== undefined &&
    (!Number.isInteger(config.resumeUsedRequests) ||
      config.resumeUsedRequests < 0 || config.resumeUsedRequests >=
        (config.extensionReceiptFile !== undefined ? 42 : budget))
  ) throw new Error("Invalid runtime configuration");
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isInteger(budget) ||
    budget < 1 ||
    (budget > 34 && budget !== 42) ||
    typeof config.keyFile !== "string" ||
    !isAbsolute(config.keyFile)
  )
    throw new Error("Invalid runtime configuration");
  const hasExtension = config.extensionReceiptFile !== undefined || config.extensionReceiptSha256 !== undefined;
  if ((budget === 42 && !hasExtension) ||
    (hasExtension && (![34, 42].includes(budget) || config.resumeUsedRequests === undefined)))
    throw new Error("Invalid runtime configuration");
  const trees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectRoot, encoding: "utf8",
  }).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  const extension = hasExtension ? loadExtensionReceipt(
    config.extensionReceiptFile, config.extensionReceiptSha256, trees, budget === 34,
  ) : undefined;
  const nativeStakeProfile = stakeProfile ? preparedProfile ?? loadNativeStakeProfile(
    config.scopeFile, config.readinessFile, config.readinessSha256,
  ) : undefined;
  if (nativeStakeProfile) assertNativeStakeProfile(nativeStakeProfile);
  const newAddressProfile = newAddress ? preparedProfile ?? loadNewAddressProfile(
    config.scopeFile, config.readinessFile, config.readinessSha256,
  ) : undefined;
  if (newAddressProfile) assertNewAddressProfile(newAddressProfile);
  let key;
  try {
    const location = realpathSync(config.keyFile);
    if (
      trees.some((tree) => {
        const rel = relative(tree, location);
        return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
      })
    )
      throw new Error();
    const fd = openSync(
      config.keyFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" &&
          stat.uid !== process.getuid()) ||
        stat.size < 1 ||
        stat.size > 4096
      )
        throw new Error();
      key = readFileSync(fd, "utf8").trim();
      if (!key || /\s/.test(key)) throw new Error();
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error("Private credential is unavailable or unsafe");
  }
  // This launcher is the bounded integration profile, not the public production policy.
  return {
    port,
    requestBudget: budget,
    extension,
    nativeStakeProfile,
    newAddressProfile,
    extensionMode: extension ? (budget === 42 ? "bonus" : "original") : undefined,
    env: {
      ...inherited,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
      DMND_API_BASE_URL: "https://api.dmnd.dev/api/v1",
      DMND_API_KEY: key,
      DMND_ENABLED_PROTOCOLS: nativeStakeProfile ? "stake" : "",
      DMND_ALLOWED_WALLETS: nativeStakeProfile ? NATIVE_STAKE_WALLET : newAddressProfile ? NEW_ADDRESS_WALLET : APPROVED_WALLETS.join(","),
      DMND_REQUEST_BUDGET: String(Math.min(budget, 34)),
      DMND_ACCEPTANCE_PROXY_TOKEN: randomBytes(32).toString("hex"),
    },
  };
}
async function availablePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let child, proxy, releaseLease, childReaped;
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16384) throw new Error();
    }
    assertRuntimeProof(
      resolve(projectRoot, "dist"),
      resolve(projectRoot, ".sites-runtime/dmnd-runtime-proof.json"),
    );
    const config = JSON.parse(input);
    let nativeStakeProfile, newAddressProfile;
    if (config?.profile === NATIVE_STAKE_SCOPE) {
      nativeStakeProfile = loadNativeStakeProfile(config.scopeFile, config.readinessFile, config.readinessSha256);
      assertNativeStakeRehearsal(config, buildFingerprint(resolve(projectRoot, "dist")),
        resolve(projectRoot, ".sites-runtime/dmnd-runtime-proof.json"));
    }
    if (config?.profile === NEW_ADDRESS_SCOPE) {
      newAddressProfile = loadNewAddressProfile(config.scopeFile, config.readinessFile, config.readinessSha256);
      assertNewAddressRehearsal(config, buildFingerprint(resolve(projectRoot, "dist")),
        resolve(projectRoot, ".sites-runtime/dmnd-runtime-proof.json"));
    }
    releaseLease = claimLease(resolve(projectRoot, ".sites-runtime/dmnd-live-lease.json"));
    const runtime = runtimeConfiguration(config, process.env, nativeStakeProfile ?? newAddressProfile);
    const grantPath = nativeStakeProfile ? nativeStakeGrantPath() : newAddressProfile ? newAddressGrantPath() : fileURLToPath(
      new URL("../.sites-runtime/dmnd-live-grant.json", import.meta.url),
    );
    if (nativeStakeProfile) claimNativeStakeGrant(grantPath, nativeStakeProfile);
    else if (newAddressProfile) claimNewAddressGrant(grantPath, newAddressProfile);
    else if (config.resumeUsedRequests !== undefined)
      resumeGrant(grantPath, runtime.requestBudget, config.resumeUsedRequests, runtime.extension);
    else claimGrant(grantPath, runtime.requestBudget);
    const workerPort = await availablePort();
    const args = [
      "--import",
      fileURLToPath(new URL("./sites-env.mjs", import.meta.url)),
      fileURLToPath(
        new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
      ),
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
      String(workerPort),
      "--env-file",
      devNull,
    ];
    proxy = await startAcceptanceProxy({
      port: runtime.port,
      grantPath,
      target: "http://127.0.0.1:" + workerPort,
      token: runtime.env.DMND_ACCEPTANCE_PROXY_TOKEN,
      extension: runtime.extension,
      extensionMode: runtime.extensionMode,
      nativeStakeProfile,
      newAddressProfile,
    });
    child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childReaped = new Promise((resolve) => child.once("close", resolve));
    child.on("close", (code) => {
      proxy.close();
      releaseLease?.();
      process.exitCode = code ?? 1;
    });
    child.on("error", () => {
      proxy?.close();
      process.stderr.write("Could not start the bounded DMND runtime.\n");
      process.exitCode = 1;
    });
    process.stdout.write(
      "Bounded Doxxd preview: http://127.0.0.1:" +
        runtime.port +
        " (" +
        runtime.requestBudget +
        "-request grant shared across Worker reloads)\n",
    );
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on("line", (line) =>
        output.write(
          safeOutput(
            safeOutput(line, runtime.env.DMND_API_KEY),
            runtime.env.DMND_ACCEPTANCE_PROXY_TOKEN,
          ) + "\n",
        ),
      );
    }
    process.on("SIGINT", () => {
      proxy.close();
      child.kill("SIGINT");
    });
    process.on("SIGTERM", () => {
      proxy.close();
      child.kill("SIGTERM");
    });
  } catch {
    proxy?.close();
    child?.kill("SIGTERM");
    if (childReaped) await childReaped;
    releaseLease?.();
    process.stderr.write(
      "Could not load the bounded DMND runtime configuration.\n",
    );
    process.exitCode = 1;
  }
}
