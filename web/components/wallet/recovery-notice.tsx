"use client";
import type { RecoveryState } from "@/lib/wallet-recovery";

export function RecoveryNotice({ state, retained = false, retry }: {
  state: RecoveryState;
  retained?: boolean;
  retry: () => void;
}) {
  if (state === "idle" && !retained) return null;
  return (
    <div className="coverage-note" role="status" aria-live="polite">
      {retained && <span>Showing the last loaded data. </span>}
      {state === "stopped" ? (
        <>
          Automatic checks have stopped. This data is still pending or unavailable.{" "}
          <button className="button ghost" type="button" onClick={retry}>Check again</button>
        </>
      ) : state === "paused" ? (
        "Automatic checks paused while this tab is hidden."
      ) : state === "idle" ? (
        "The latest refresh failed."
      ) : (
        "Checking for wallet data automatically…"
      )}
    </div>
  );
}
