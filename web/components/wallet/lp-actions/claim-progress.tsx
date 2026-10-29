"use client";
// The progress of a wallet action: one line per transaction, with the
// runner's own status and reason copy. Used for claims here and for a single
// withdrawal in the withdraw dialog.
import { useId } from "react";
import type { ActionStep } from "@/lib/actions/run";
import { explorerHref } from "@/lib/safe-url";
import { formatAmounts, type MintLookup } from "./amounts";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const STATUS: Record<ActionStep["status"], { mark: string; tone: string; text: string }> = {
  confirmed: { mark: "✓", tone: "ok", text: "Confirmed" },
  "awaiting-approval": { mark: "●", tone: "wait", text: "Waiting for your approval" },
  sending: { mark: "●", tone: "wait", text: "Sending" },
  queued: { mark: "○", tone: "idle", text: "Queued" },
  failed: { mark: "✕", tone: "bad", text: "Failed" },
  skipped: { mark: "–", tone: "idle", text: "Skipped" },
  stopped: { mark: "–", tone: "idle", text: "Stopped" },
};

function Step({ step, lookup }: { step: ActionStep; lookup: MintLookup }) {
  const status = STATUS[step.status];
  // Skipped and stopped steps say why in place of the status word.
  const replaced = (step.status === "skipped" || step.status === "stopped") && step.reason;
  return (
    <li className={"progress-step " + status.tone}>
      <span className="progress-mark" aria-hidden="true">
        {status.mark}
      </span>
      <span className="stack">
        <span>
          Transaction {step.index} · {plural(step.positionIds.length, "position")}
        </span>
        {step.expected && step.expected.length > 0 && (
          <span className="faint small">≈ {formatAmounts(step.expected, lookup)}</span>
        )}
      </span>
      <span className="progress-status">
        {replaced ? (
          step.reason
        ) : step.status === "confirmed" && step.signature ? (
          <>
            <span>{status.text}</span> ·{" "}
            <a href={explorerHref("tx", step.signature)} target="_blank" rel="noopener noreferrer">
              Solscan <span aria-hidden="true">↗</span>
            </a>
          </>
        ) : (
          status.text
        )}
        {step.status === "failed" && step.reason && (
          <span className="progress-reason">{step.reason}</span>
        )}
      </span>
    </li>
  );
}

export function ClaimProgress({
  title,
  walletName,
  steps,
  skipped = [],
  names = {},
  lookup,
  waiting,
  error,
  done,
  stopping,
  onStop,
  onDone,
}: {
  title: string;
  walletName: string;
  steps: ActionStep[];
  /** Positions the build left out, with the builder's reason. */
  skipped?: { positionId: string; reason: string }[];
  /** Position names by id, for skipped positions. */
  names?: Record<string, string>;
  lookup: MintLookup;
  /** Shown before the transactions are known. */
  waiting?: string | null;
  error?: string | null;
  done: boolean;
  stopping: boolean;
  onStop(): void;
  onDone(): void;
}) {
  const id = useId();
  return (
    <section className="claim-progress" aria-labelledby={id} aria-live="polite">
      <strong id={id}>{title}</strong>
      {steps.length > 0 && (
        <div className="muted small">
          {plural(steps.length, "transaction")} · approve them in {walletName}
        </div>
      )}
      {waiting && !done && steps.length === 0 && <div className="faint small">{waiting}</div>}
      <ol className="progress-steps">
        {steps.map((step) => (
          <Step key={step.index} step={step} lookup={lookup} />
        ))}
        {skipped.map((skip) => (
          <li key={skip.positionId} className="progress-step idle">
            <span className="progress-mark" aria-hidden="true">
              –
            </span>
            <span>{names[skip.positionId] ?? skip.positionId}</span>
            <span className="progress-status">{skip.reason}</span>
          </li>
        ))}
      </ol>
      {error && <p className="progress-error">{error}</p>}
      <p className="faint small">
        If you stop or reject one, nothing is lost: those fees just stay unclaimed.
      </p>
      <div className="inline">
        {done ? (
          <button type="button" className="action-pill" onClick={onDone}>
            Done
          </button>
        ) : (
          <button type="button" className="action-pill" disabled={stopping} onClick={onStop}>
            Stop after this one
          </button>
        )}
      </div>
    </section>
  );
}
