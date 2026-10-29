// Security headers for every response the Worker serves: pages, RSC payloads,
// API routes and errors. worker/index.ts applies them, in `npm run dev` too
// (the Cloudflare Vite plugin runs the same Worker entry). Static files from
// the assets binding never reach the Worker and are not covered here.
//
// script-src: vinext puts a nonce on its inline hydration and RSC payload
// scripts when the request carries a Content-Security-Policy header with a
// `'nonce-…'` source (the Next.js convention; vinext/dist/server/csp.js), so
// the wrapper makes one nonce per request, hands it to the renderer on the
// request and sends the same policy back. 'strict-dynamic' lets those scripts
// load the app's chunks (including the lazy wallet-action chunk); 'self' is
// only a fallback for browsers without CSP 3.

const BASE_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

export function securityHeaders(options: { scriptNonce?: string } = {}): Record<string, string> {
  const csp = options.scriptNonce
    ? `${BASE_CSP}; script-src 'self' 'nonce-${options.scriptNonce}' 'strict-dynamic'`
    : BASE_CSP;
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": csp,
  };
}

/** 16 random bytes, base64: 128 bits, as CSP recommends. */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Wraps a fetch handler: a fresh script nonce per request, set on the request
 * (replacing any policy the client sent) and on the response with the rest of
 * securityHeaders().
 */
export function withSecurityHeaders<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    const headers = securityHeaders({ scriptNonce: newNonce() });
    const forwarded = new Headers(request.headers);
    forwarded.delete("Content-Security-Policy-Report-Only");
    forwarded.set("Content-Security-Policy", headers["Content-Security-Policy"]);
    const response = await handler(new Request(request, { headers: forwarded }), ...rest);
    // Redirects and fetched responses have immutable headers; copy those.
    let secured = response;
    try {
      for (const [name, value] of Object.entries(headers)) secured.headers.set(name, value);
    } catch {
      secured = new Response(response.body, response);
      for (const [name, value] of Object.entries(headers)) secured.headers.set(name, value);
    }
    return secured;
  };
}
