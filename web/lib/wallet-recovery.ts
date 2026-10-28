import type { ResourceName, ResourceResult } from "./dmnd/contracts";
import { protocolResources } from "./dmnd/resources";

export type RecoveryState = "idle" | "waiting" | "refreshing" | "paused" | "stopped";
export const RECOVERY_INTERVAL_MS = 5_000;
export const RECOVERY_WINDOW_MS = 120_000;
export const RECOVERY_MAX_RETRIES = 20;

export function recoverableResource(resource: ResourceName, cursor?: string) {
  return !cursor && (resource === "summary" || resource === "overview" ||
    protocolResources.includes(resource as never));
}

export function transientError(result: ResourceResult<unknown>) {
  return !result.ok && ["upstream", "timeout", "rate_limited"].includes(result.kind);
}

// Partial financial coverage, unpriced assets, and disabled/failed integrations
// are terminal observations, not evidence that a scan is still running.
export function needsRecovery(result: ResourceResult<unknown>) {
  if (!result.ok) return transientError(result);
  const data = result.data as {
    components?: { coverage_status?: string }[];
    coverage?: { status?: string; snapshot_status?: string };
  };
  const pending = (status?: string) => /^(snapshot_)?(queued|pending|running)$/.test(status ?? "");
  return data.components?.some((c) => pending(c.coverage_status)) ||
    pending(data.coverage?.snapshot_status) || pending(data.coverage?.status);
}
