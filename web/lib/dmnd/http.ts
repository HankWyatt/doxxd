import type { ResourceResult } from "./contracts";
export function resourceResponse(result: ResourceResult<unknown>): Response {
  const statuses = {
    configuration: 503,
    authentication:
      !result.ok && result.kind === "authentication"
        ? (result.upstreamStatus ?? 401)
        : 401,
    refused: 422,
    invalid_input: 400,
    unsupported: 501,
    unavailable: 503,
    not_enabled: 503,
    rate_limited: 429,
    timeout: 504,
    upstream: 502,
  };
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (!result.ok && result.retryAfterSeconds !== undefined)
    headers["retry-after"] = String(result.retryAfterSeconds);
  return Response.json(result, {
    status: result.ok ? 200 : statuses[result.kind],
    headers,
  });
}
