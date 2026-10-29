import { actionsEnabledFromEnv } from "@/lib/actions/enabled";
import { handleRpc } from "@/lib/rpc/passthrough.server";
import { createRateLimiter } from "@/lib/rpc/rate-limit";

// Module-level, so one limiter per isolate.
const limiter = createRateLimiter({ windowMs: 60_000, general: 120, send: 20 });

function handle(request: Request): Promise<Response> {
  return handleRpc(request, {
    enabled: actionsEnabledFromEnv(process.env),
    upstream: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    // Called unbound: Workers' fetch throws "Illegal invocation" otherwise.
    fetch: (input, init) => fetch(input, init),
    limiter,
  });
}

export const POST = handle;
// So a disabled pass-through is a plain 404 for every method.
export const GET = handle;
