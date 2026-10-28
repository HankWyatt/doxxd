import { createServer } from "node:http";
import { resolve } from "node:path";
import { bodyJson } from "../lib/dmnd/read-json.mjs";
import { APPROVED_WALLETS } from "./dmnd-acceptance.mjs";
import { CORE, reserveRequest, completeRequest } from "./native-overview-extension.mjs";
import { assertNativeStakeProfile, nativeStakeRouteAllowed, reserveNativeStakeRequest,
  completeNativeStakeRequest } from "./native-stake-profile.mjs";
import { assertNewAddressProfile, newAddressRouteAllowed, reserveNewAddressRequest,
  completeNewAddressRequest } from "./new-address-profile.mjs";

const tails = new Map();
const safeError = (kind, status) =>
  Response.json(
    { ok: false, kind },
    { status, headers: { "cache-control": "no-store" } },
  );

/** @param {{grantPath:string,target:string,token:string,extension?:any,extensionMode?:string,nativeStakeProfile?:any,newAddressProfile?:any}} config @param {(url:string,init:RequestInit)=>Promise<Response>} [network] */
export function boundedProxyHandler(config, network = fetch) {
  if (config.newAddressProfile) {
    assertNewAddressProfile(config.newAddressProfile);
    if (config.nativeStakeProfile || config.extension || config.extensionMode) throw new Error("Invalid bounded profile");
  }
  if (config.nativeStakeProfile) {
    assertNativeStakeProfile(config.nativeStakeProfile);
    if (config.extension || config.extensionMode) throw new Error("Invalid bounded profile");
  }
  const target = new URL(config.target);
  if (
    target.protocol !== "http:" ||
    target.hostname !== "127.0.0.1" ||
    target.pathname !== "/" ||
    target.search ||
    target.hash ||
    target.username ||
    target.password ||
    !config.token
  )
    throw new Error("Invalid bounded proxy target");
  const queueKey = resolve(config.grantPath);
  let closed = false;
  const destinationFor = (url) => {
    const result = new URL(target);
    result.pathname = url.pathname;
    result.search = url.search;
    return result;
  };
  async function walletRead(request) {
    if (closed) return safeError("refused", 422);
    const url = new URL(request.url);
    const match = /^\/api\/wallet\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) return safeError("invalid_input", 400);
    const [, wallet, resource] = match;
    if (config.newAddressProfile) {
      if (!newAddressRouteAllowed(config.newAddressProfile, request)) return safeError("refused", 422);
    } else if (config.nativeStakeProfile) {
      if (!nativeStakeRouteAllowed(config.nativeStakeProfile, request)) return safeError("refused", 422);
    } else {
      if (!APPROVED_WALLETS.includes(wallet))
        return safeError("unavailable", 403);
      if (!CORE.includes(resource)) return safeError("unavailable", 503);
      if (request.method !== "GET") return safeError("invalid_input", 405);
      // The validation profile never falls back to spending original CORE reads.
      if (config.extensionMode === "bonus" && (resource !== "overview" || url.search))
        return safeError("refused", 422);
      if (resource === "transactions" || resource === "activity") {
        const given = url.searchParams.get("limit");
        if (given !== null && (!/^\d+$/.test(given) || Number(given) < 1))
          return safeError("invalid_input", 400);
        url.searchParams.set(
          "limit",
          String(Math.min(10, given === null ? 10 : Number(given))),
        );
      }
    }
    let index;
    try {
      index = config.newAddressProfile ? reserveNewAddressRequest(config.grantPath, config.newAddressProfile, resource) :
        config.nativeStakeProfile ? reserveNativeStakeRequest(config.grantPath, config.nativeStakeProfile, resource) : reserveRequest(
        config.grantPath,
        wallet,
        resource,
        url.searchParams.has("cursor"),
        !url.search,
        config.extension,
        config.extensionMode,
      );
    } catch {
      closed = true;
      return safeError("refused", 422);
    }
    const destination = destinationFor(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.extension ? 8000 : 9000);
    let result, haltStatus;
    try {
      const response = await network(destination.href, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { "x-doxxd-acceptance-token": config.token },
        signal: controller.signal,
      });
      if ((config.extension || config.nativeStakeProfile || config.newAddressProfile) && [401, 403, 429].includes(response.status))
        haltStatus = response.status;
      if (response.status >= 300 && response.status < 400) throw new Error();
      const body = await bodyJson(response);
      result = Response.json(body, {
        status: response.status,
        headers: {
          "cache-control": "no-store",
          ...(response.headers.has("retry-after")
            ? { "retry-after": response.headers.get("retry-after") }
            : {}),
        },
      });
    } catch {
      result = safeError(
        controller.signal.aborted ? "timeout" : "upstream",
        controller.signal.aborted ? 504 : 502,
      );
    } finally {
      clearTimeout(timeout);
    }
    try {
      if (config.newAddressProfile) completeNewAddressRequest(config.grantPath, config.newAddressProfile, index, haltStatus ?? result.status);
      else if (config.nativeStakeProfile) completeNativeStakeRequest(config.grantPath, config.nativeStakeProfile, index, haltStatus ?? result.status);
      else completeRequest(config.grantPath, index, haltStatus ?? result.status, config.extension);
    } catch {
      closed = true;
      return safeError("refused", 422);
    }
    if (haltStatus || (config.nativeStakeProfile || config.newAddressProfile) && result.status !== 200) closed = true;
    return result;
  }
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/wallet/")) {
      const work = (tails.get(queueKey) ?? Promise.resolve()).then(() => walletRead(request));
      const tail = work.then(
        () => {},
        () => {
          closed = true;
        },
      );
      tails.set(queueKey, tail);
      void tail.then(() => { if (tails.get(queueKey) === tail) tails.delete(queueKey); });
      return work;
    }
    if (!["GET", "HEAD"].includes(request.method))
      return safeError("invalid_input", 405);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("x-doxxd-acceptance-token");
    headers.set("accept-encoding", "identity");
    return network(destinationFor(url).href, {
      method: request.method,
      headers,
      redirect: "manual",
    });
  };
}

/** @param {{port:number,grantPath:string,target:string,token:string,extension?:any,extensionMode?:string,nativeStakeProfile?:any,newAddressProfile?:any}} config */
export async function startAcceptanceProxy(config) {
  const handle = boundedProxyHandler(config);
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const incoming = new Request(
        new URL(request.url ?? "/", "http://127.0.0.1:" + config.port),
        { method: request.method, headers },
      );
      const result = await handle(incoming);
      const headersOut = new Headers(result.headers);
      // Fetch decoded the incoming bytes; send metadata for those bytes.
      for (const name of [
        "content-encoding", "content-length", "transfer-encoding", "connection",
        "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
      ]) headersOut.delete(name);
      response.writeHead(result.status, Object.fromEntries(headersOut));
      if (result.body) {
        const reader = result.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      response.end();
    } catch {
      if (!response.headersSent)
        response.writeHead(502, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
      response.end('{"ok":false,"kind":"upstream"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  return server;
}
