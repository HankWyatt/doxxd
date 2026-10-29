// Server-side switch for on-site LP actions. Everything stays off unless the
// server sets DOXXD_ACTIONS_ENABLED=1. This file must not be "use client":
// pages and routes call it on the server.
export function actionsEnabledFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  return env.DOXXD_ACTIONS_ENABLED === "1";
}
