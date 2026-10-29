"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ResourceError } from "@/lib/dmnd/contracts";
const messages: Record<ResourceError["kind"], [string, string]> = {
  authentication: [
    "Data connection needs attention",
    "The data service could not authorize this connection. Wallet data remains unavailable until the service connection is restored.",
  ],
  refused: [
    "This data scope is unavailable",
    "The source could not serve this request. Try the first page or a narrower activity window.",
  ],
  configuration: [
    "Data connection unavailable",
    "The data service is not configured for this view yet. Wallet data will appear when the connection is restored.",
  ],
  invalid_input: [
    "This request couldn’t be completed",
    "The address, filters, or cursor is invalid. Try the newest page or change the search.",
  ],
  unsupported: [
    "This view isn’t available yet",
    "This data source is not supported by the connected service.",
  ],
  unavailable: [
    "Wallet data is unavailable",
    "This source may be awaiting activation or a new snapshot. Refresh to check again.",
  ],
  not_enabled: [
    "Not available yet",
    "This view isn’t enabled for this connection yet. Other wallet sections remain available.",
  ],
  rate_limited: [
    "A little pause",
    "The data service has asked us to wait before another request.",
  ],
  timeout: [
    "The data service took too long",
    "Other sections may still be available. You can retry this section.",
  ],
  upstream: [
    "Couldn’t load this section",
    "The data service didn’t return a usable response. Other wallet sections remain available.",
  ],
};
// The allowlist turned this wallet away, so no section will load for it.
const walletNotEnabled: [string, string] = [
  "This wallet isn’t enabled yet",
  "This connection isn’t set up to read this wallet, so none of its sections are available here.",
];
export function ResourceState({
  error,
  retry,
}: {
  error: ResourceError;
  retry?: () => void;
}) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const seconds =
      error.kind === "rate_limited" ? (error.retryAfterSeconds ?? 15) : 0;
    setRemaining(seconds);
    if (!seconds) return;
    const timer = setInterval(
      () =>
        setRemaining((n) => {
          if (n <= 1) clearInterval(timer);
          return Math.max(0, n - 1);
        }),
      1000,
    );
    return () => clearInterval(timer);
  }, [error]);
  const [title, detail] =
    error.kind === "not_enabled" && error.scope === "wallet"
      ? walletNotEnabled
      : messages[error.kind];
  return (
    <div className="empty-state" role="status">
      <strong>{title}</strong>
      {detail}
      {retry && (
        <div>
          <button
            className="button"
            type="button"
            disabled={remaining > 0}
            onClick={retry}
          >
            <RefreshCw size={12} />
            {remaining > 0 ? "Retry in " + remaining + "s" : "Retry section"}
          </button>
        </div>
      )}
    </div>
  );
}
export function LoadingRows() {
  return (
    <div aria-label="Loading section" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ))}
    </div>
  );
}
