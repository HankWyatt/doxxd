"use client";
// The close dialog: confirms closing one empty position and what comes back
// (its deposit), then runs through the page's one run (./run-store.ts). The
// close is built from fresh reads when the visitor confirms; during and after
// the run the body is the progress panel, and the run outlives the dialog.
//
// web3.js and the SDKs load only through `await import("@/lib/actions/build")`
// (ruling R-P4).
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { WSOL_MINT } from "@/lib/actions/programs";
import type { ActionTarget } from "@/lib/actions/types";
import type { ConnectedWallet } from "@/lib/actions/wallet-session";
import { useCurrentAddress } from "@/components/wallet-connect/provider";
import { formatAtoms, mintLookup, positionName, type MintLookup } from "./amounts";
import { ClaimProgress } from "./claim-progress";
import {
  dismissRun,
  startCloseRun,
  stopRun,
  useLpRunStore,
  withdrawErrorText,
  WITHDRAW_FOOTNOTE,
  WRAPPED_SOL_NOTE,
} from "./run-store";

type Actions = typeof import("@/lib/actions/build");

export function CloseDialog({
  target,
  wallet,
  lookup: pageLookup,
  onClose,
  onDone,
}: {
  target: ActionTarget;
  wallet: ConnectedWallet;
  /** Token names from the page; defaults to the target's own symbols. */
  lookup?: MintLookup;
  /** Cancel, Esc or ✕. A run going on carries on in the card. */
  onClose(): void;
  /** Done after a finished run. */
  onDone(): void;
}) {
  const lookup = pageLookup ?? mintLookup([target], {});
  const title = `Close ${positionName(target, lookup)}`;
  const currentAddress = useCurrentAddress();
  const store = useLpRunStore();
  const [runId, setRunId] = useState<number | null>(null);
  // What closing returns, from a build over live state (null while loading).
  const [check, setCheck] = useState<{ refundLamports: string | null; error: string | null } | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      let actions: Actions | undefined;
      try {
        actions = await import("@/lib/actions/build");
        const rpc = actions.createActionRpc(new URL("/api/rpc", window.location.origin).href);
        const built = await actions.buildCloseGroups(rpc, wallet.address, target);
        if (current) setCheck({ refundLamports: built.refundLamports, error: null });
      } catch (error) {
        if (current) setCheck({ refundLamports: null, error: withdrawErrorText(error, actions?.isRpcBusy) });
      }
    })();
    return () => {
      current = false;
    };
  }, [target, wallet.address]);

  const run = store.run !== null && store.run.id === runId ? store.run : null;
  const prompting = run?.steps.some((s) => s.status === "awaiting-approval") ?? false;
  const busy = store.run !== null && store.run.phase !== "done";
  const canClose = check !== null && check.error === null && !busy && runId === null;
  const refund =
    check?.refundLamports && /^\d+$/.test(check.refundLamports)
      ? formatAtoms(WSOL_MINT, check.refundLamports, lookup)
      : null;

  const confirm = () => {
    if (!canClose) return;
    const id = startCloseRun({ wallet, resource: target.protocol, target, currentAddress });
    if (id !== null) setRunId(id);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !prompting) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="withdraw-overlay" />
        <Dialog.Content
          className="withdraw-dialog"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Never close over an open wallet prompt.
            if (prompting) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (prompting) event.preventDefault();
          }}
        >
          <div className="withdraw-head">
            <Dialog.Title className={run ? "sr-only" : undefined}>{title}</Dialog.Title>
            {!prompting && (
              <Dialog.Close className="withdraw-close" aria-label="Close">
                <X size={14} aria-hidden="true" />
              </Dialog.Close>
            )}
          </div>
          {run ? (
            <ClaimProgress
              title={title}
              walletName={run.walletName}
              steps={run.steps}
              lookup={lookup}
              waiting={run.phase === "building" ? "Checking live pool data…" : null}
              error={run.error}
              done={run.phase === "done"}
              stopping={run.stopping}
              autoFocus
              nothingLine="Nothing was closed"
              note={run.wrappedSol ? WRAPPED_SOL_NOTE : null}
              footnote={WITHDRAW_FOOTNOTE}
              onStop={stopRun}
              onDone={() => {
                dismissRun(run.id);
                onDone();
              }}
            />
          ) : (
            <>
              <p className={"withdraw-note" + (check === null ? " loading" : "")} aria-busy={check === null}>
                {refund
                  ? `Close this empty position? Its deposit (about ${refund}) comes back to your wallet.`
                  : "Close this empty position? Its deposit comes back to your wallet."}
              </p>
              {check?.error && (
                <p className="withdraw-error" role="alert">
                  {check.error}
                </p>
              )}
              <div className="withdraw-actions">
                <Dialog.Close asChild>
                  <button type="button" className="action-pill">
                    Cancel
                  </button>
                </Dialog.Close>
                <button type="button" className="action-pill primary" disabled={!canClose} onClick={confirm}>
                  Close position
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
