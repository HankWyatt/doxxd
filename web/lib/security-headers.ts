// Security headers for every response the Worker serves: pages, RSC payloads,
// API routes and errors. worker/index.ts applies them, in `npm run dev` too
// (the Cloudflare Vite plugin runs the same Worker entry). Static files from
// the assets binding never reach the Worker: public/_headers (copied into the
// assets directory) gives them the same HTTPS set, and security-headers.test.ts
// keeps the two in sync.
//
// No script-src for now. vinext can put a per-request nonce on its inline
// hydration scripts, but:
// - a nonce on every request turns off vinext's production HTML ISR cache for
//   every page (vinext/dist/server/app-page-dispatch.js and
//   app-page-render.js skip caching when a script nonce is present);
// - wallet extensions that inject page scripts could be blocked by a strict
//   script-src, and the e2e mock wallet (an init script) cannot show that
//   real extensions survive it.

const CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
// No `preload`: submitting the domain to browser preload lists is the owner's
// call, and hard to undo.
const HSTS = "max-age=31536000; includeSubDomains";

/** The response security headers; HSTS only for a request made over HTTPS. */
export function securityHeaders({ https = false }: { https?: boolean } = {}): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": CSP,
    ...(https ? { "Strict-Transport-Security": HSTS } : {}),
  };
}

// vinext reads a script nonce from these request headers (vinext's
// server/csp.js). A client-sent one could switch off the HTML cache for its
// request, or carry characters that make vinext throw, so they never reach it.
const CLIENT_CSP_HEADERS = ["Content-Security-Policy", "Content-Security-Policy-Report-Only"];

// What a thrown or rejected handler answers. Never the error's text: it can
// carry URLs or other server details.
function internalError(): Response {
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Wraps a fetch handler: strips client-sent CSP request headers, then sets
 * securityHeaders() on the response, or on a plain 500 if the handler throws.
 */
export function withSecurityHeaders<Rest extends unknown[]>(
  handler: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Promise<Response> {
  return async (request, ...rest) => {
    let forwarded = request;
    if (CLIENT_CSP_HEADERS.some((name) => request.headers.has(name))) {
      const headers = new Headers(request.headers);
      for (const name of CLIENT_CSP_HEADERS) headers.delete(name);
      forwarded = new Request(request, { headers });
    }
    let response: Response;
    try {
      response = await handler(forwarded, ...rest);
    } catch {
      response = internalError();
    }
    const headers = securityHeaders({ https: new URL(request.url).protocol === "https:" });
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
