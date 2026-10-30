// Server-only JSON-RPC pass-through for wallet actions (POST /api/rpc).
//
// Accepts one JSON-RPC 2.0 request that lib/rpc/policy allows, rate-limits
// it (IPv6 clients per /64), and forwards a freshly serialised copy to the
// upstream Solana RPC with only `content-type: application/json` and the
// pass-through's own request id, never following a redirect. The upstream URL
// may carry an API key: it, upstream HTTP error bodies and network error
// messages never reach a response, and nothing here logs. The reply is
// re-serialised and that text is scanned for the upstream URL's secrets, so a
// JSON \u-escaped key cannot slip through. The answer carries the client's id
// back, put in after the secret scan, so a client cannot probe the scan with
// ids the upstream echoes.
import { checkRpcRequest, type JsonRpcRequest } from "./policy";
import { LIMITER_REFUSAL, rateLimitKey, type RateLimiter } from "./rate-limit";

export type RpcEnv = {
  enabled: boolean;
  upstream: string;
  fetch: typeof fetch;
  limiter: RateLimiter;
};

const MAX_REQUEST_BYTES = 64 * 1024;
// The largest legitimate reply is a getMultipleAccounts of the policy's 100
// accounts: Raydium CLMM tick arrays are about 10 KB each, so about 1.4 MB as
// base64 JSON.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Shorter query values and credentials are too common to scan for.
const MIN_SECRET_LENGTH = 4;
const UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SEC = 2;
// The id every upstream request carries.
const UPSTREAM_ID = 1;
const MAX_RETRY_AFTER_SEC = 300;

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function rpcError(
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status, headers: { ...BASE_HEADERS, ...headers } },
  );
}

// Reads at most `limit` bytes, decoding each chunk as it arrives so the body
// is held once, as text. Returns null when the stream is longer. Throws when
// `decoder` is fatal and the bytes are not valid UTF-8.
async function readCappedText(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  decoder: TextDecoder,
): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const parts: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

// Substrings of the upstream URL that would identify or unlock it: the URL
// itself, its host, credentials, the query string and its values, and long
// path segments (some providers put the key in the path). Query parameter
// names are not secret: a name like `token` also appears in ordinary replies.
function secretParts(upstream: string): string[] {
  const parts = [upstream];
  try {
    const url = new URL(upstream);
    parts.push(url.href, url.host);
    for (const credential of [url.username, url.password])
      if (credential.length >= MIN_SECRET_LENGTH) parts.push(credential);
    if (url.search.length > 1) parts.push(url.search.slice(1));
    for (const value of url.searchParams.values())
      if (value.length >= MIN_SECRET_LENGTH) parts.push(value, encodeURIComponent(value));
    for (const segment of url.pathname.split("/"))
      if (segment.length >= 8) parts.push(segment);
  } catch {
    // An unparseable upstream fails at fetch; the raw string is still covered.
  }
  return parts;
}

function retryAfter(value: string | null): string {
  if (value && /^\d{1,4}$/.test(value)) {
    const seconds = Number(value);
    if (seconds >= 1 && seconds <= MAX_RETRY_AFTER_SEC) return String(seconds);
  }
  return String(DEFAULT_RETRY_AFTER_SEC);
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";")[0].trim().toLowerCase() === "application/json";
}

async function forward(
  request: JsonRpcRequest,
  env: RpcEnv,
): Promise<Response> {
  const unavailable = () =>
    rpcError(502, -32603, "Upstream RPC unavailable", request.id);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const doFetch = env.fetch;
  try {
    let upstream: Response;
    let text: string | null;
    try {
      upstream = await doFetch(env.upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, id: UPSTREAM_ID }),
        signal: controller.signal,
        // A redirect could carry the request (and its key) elsewhere; any
        // 3xx is refused below as a non-200.
        redirect: "manual",
      });
      if (upstream.status === 429) {
        await upstream.body?.cancel().catch(() => undefined);
        return rpcError(429, -32005, "Upstream RPC rate limited", request.id, {
          "retry-after": retryAfter(upstream.headers.get("retry-after")),
        });
      }
      if (upstream.status !== 200) {
        await upstream.body?.cancel().catch(() => undefined);
        return unavailable();
      }
      text = await readCappedText(upstream.body, MAX_RESPONSE_BYTES, new TextDecoder());
    } catch {
      if (controller.signal.aborted)
        return rpcError(504, -32603, "Upstream RPC timed out", request.id);
      return unavailable();
    }
    if (text === null) return unavailable();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return unavailable();
    }
    // Only the parsed reply is needed from here on.
    text = null;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
      (parsed as { id?: unknown }).id !== UPSTREAM_ID ||
      !("result" in parsed || "error" in parsed)
    )
      return unavailable();
    const reply = parsed as { result?: unknown; error?: unknown };
    // Re-serialised once, so escapes are decoded, and scanned before the
    // client's id goes in. What is scanned is exactly what follows the id.
    const payload = JSON.stringify(
      "result" in reply ? { result: reply.result } : { error: reply.error },
    );
    if (secretParts(env.upstream).some((part) => payload.includes(part)))
      return unavailable();
    const out = `{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},${payload.slice(1)}`;
    return new Response(out, {
      status: 200,
      headers: { ...BASE_HEADERS, "content-type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRpc(request: Request, env: RpcEnv): Promise<Response> {
  if (!env.enabled)
    return new Response("Not Found", {
      status: 404,
      headers: { ...BASE_HEADERS, "content-type": "text/plain" },
    });
  if (request.method !== "POST")
    return rpcError(405, -32600, "Use POST", null, { allow: "POST" });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin)
    return rpcError(403, -32600, "Cross-origin requests are not allowed");
  if (!isJsonContentType(request.headers.get("content-type")))
    return rpcError(415, -32600, "Content-Type must be application/json");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_REQUEST_BYTES)
    return rpcError(413, -32600, "Request too large");
  let raw: string | null;
  try {
    raw = await readCappedText(
      request.body,
      MAX_REQUEST_BYTES,
      new TextDecoder("utf-8", { fatal: true }),
    );
  } catch {
    return rpcError(400, -32700, "Parse error");
  }
  if (raw === null) return rpcError(413, -32600, "Request too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Parse error");
  }
  const checked = checkRpcRequest(body);
  if (!checked.ok) {
    const id = (body as { id?: unknown } | null)?.id;
    return rpcError(
      400,
      checked.code,
      checked.message,
      checked.code === -32600 ||
        !(typeof id === "string" || typeof id === "number")
        ? null
        : id,
    );
  }
  const key = rateLimitKey(request.headers.get("cf-connecting-ip"));
  const limit = env.limiter.take(key, checked.method, Date.now());
  if (!limit.ok)
    return rpcError(429, -32005, LIMITER_REFUSAL, checked.request.id, {
      "retry-after": String(limit.retryAfterSec),
    });
  return forward(checked.request, env);
}
