import { actionsEnabledFromEnv } from "@/lib/actions/enabled";
import { handleRpc } from "@/lib/rpc/passthrough.server";
import { createRateLimiter } from "@/lib/rpc/rate-limit";

// Module-level, so one limiter per isolate. Per-isolate limits are not
// global: production also needs the Cloudflare rate-limiting rule in the
// README's deploy notes. A claim-all over ~137 positions makes about 40
// calls per 10-transaction prompt.
const limiter = createRateLimiter({ windowMs: 60_000, general: 300, send: 40 });

function handle(request: Request): Promise<Response> {
  const enabled = actionsEnabledFromEnv(process.env);
  return handleRpc(request, {
    enabled,
    // Required when enabled (actionsEnabledFromEnv); there is no public default.
    upstream: enabled ? process.env.SOLANA_RPC_URL!.trim() : "",
    // Called unbound: Workers' fetch throws "Illegal invocation" otherwise.
    fetch: (input, init) => fetch(input, init),
    limiter,
  });
}

export const POST = handle;
// So a disabled pass-through is a plain 404 for every method, and an enabled
// one a 405 for every method but POST (the framework would otherwise answer
// OPTIONS with 204 and the rest with its own 405).
export const GET = handle;
export const OPTIONS = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
