"use client";
// The withdraw dialog: a live quote for a share of one position's withdrawable
// part, the price-move limit, and "Review in wallet", which rebuilds from
// fresh reads and runs through the page's one run (./run-store.ts). During and
// after the run the body is the progress panel; the run outlives the dialog.
//
// web3.js and the SDKs load only through `await import("@/lib/actions/build")`
// (ruling R-P4).
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ActionRpc } from "@/lib/actions/rpc";
import type { TokenAmount, WithdrawQuote } from "@/lib/actions/build/quote";
import { WSOL_MINT } from "@/lib/actions/programs";
import type { ActionTarget } from "@/lib/actions/types";
import type { ConnectedWallet } from "@/lib/actions/wallet-session";
import { useCurrentAddress } from "@/components/wallet-connect/provider";
import { UnknownValue, orUnknown } from "@/components/unknown-value";
import { formatAtoms, mintLookup, positionName, type MintLookup } from "./amounts";
import { ClaimProgress } from "./claim-progress";
import {
  dismissRun,
  startWithdrawRun,
  stopRun,
  useLpRunStore,
  withdrawErrorText,
  WITHDRAW_FOOTNOTE,
  WITHDRAW_POOL_CHANGED,
  WRAPPED_SOL_NOTE,
} from "./run-store";

type Actions = typeof import("@/lib/actions/build");

const SHARE_PRESETS = [2_500, 5_000, 7_500, 10_000];
// Price-move limit (Global Constraints): 0.5%, 1% (default), 2%, or custom up to 5%.
const SLIPPAGE_PRESETS = [50, 100, 200];
const DEFAULT_SLIPPAGE_BPS = 100;
const MAX_SLIPPAGE_BPS = 500;
// Presets and the custom percent re-quote from reads this fresh (ruling R-P5).
const QUOTE_CACHE_MS = 30_000;
const BASE_FEE_LAMPORTS = 5_000;
// The fee estimate's compute: a typical withdrawal. The runner sets the real
// limit from simulation, so the fee it pays is usually lower.
const ESTIMATED_UNITS = 200_000;
const MICRO = 1_000_000;

const SHARE_ERROR = "Enter a whole percent from 1 to 100";
const SLIPPAGE_ERROR = "Enter a price move above 0% and up to 5%";
const NOTHING_YET = "Nothing to withdraw yet";
const DUST = "Less than 0.01% of this position can be withdrawn right now.";
const TOO_SMALL = "Amount too small to withdraw";

type Choice = { preset: number } | { custom: string };

/** A custom whole percent 1–100 as bps of the withdrawable part, or null. */
function shareBps(choice: Choice): number | null {
  if ("preset" in choice) return choice.preset;
  const text = choice.custom.trim();
  if (!/^\d+$/.test(text)) return null;
  const percent = Number(text);
  return percent >= 1 && percent <= 100 ? percent * 100 : null;
}

/**
 * A custom price move of 0.01–5.00% (at most two decimals once normalised,
 * so "5e-1" is 0.5%) as bps, or null.
 */
function slippageBps(choice: Choice): number | null {
  if ("preset" in choice) return choice.preset;
  const text = choice.custom.trim();
  // Plain decimal numbers, with an optional exponent; no hex, signs or words.
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text) * 100;
  const bps = Math.round(value);
  if (!Number.isFinite(value) || Math.abs(value - bps) > 1e-9) return null;
  return bps >= 1 && bps <= MAX_SLIPPAGE_BPS ? bps : null;
}

const percent = (bps: number) => String(Number((bps / 100).toFixed(2)));

/**
 * What the live quote says about the part that can't be withdrawn now
 * (ruling R-T12c): still vesting, locked for good, or both.
 */
function lockNote(quote: WithdrawQuote): string | null {
  const y = percent(quote.withdrawableBps);
  // From the quote, never by subtraction: the floored shares need not sum to 10,000.
  const lockedBps = quote.lockedBps;
  const x = percent(quote.vestingBps);
  const z = percent(lockedBps);
  if (quote.vestingBps > 0 && lockedBps === 0)
    return `${x}% is still vesting. You can withdraw up to ${y}% now; the rest unlocks over time.`;
  if (quote.vestingBps > 0)
    return `${x}% is still vesting and ${z}% is locked for good. You can withdraw up to ${y}% now.`;
  if (lockedBps > 0) return `${z}% of this position is locked for good. You can withdraw up to ${y}% now.`;
  return null;
}

/** Every minimum is zero: the build would refuse it. */
const tooSmall = (quote: WithdrawQuote) =>
  quote.minimums.length > 0 && quote.minimums.every((m) => !/[1-9]/.test(m.atoms));

/** The accounts a withdrawal writes that best predict its priority fee. */
function feeAccounts(target: ActionTarget): string[] {
  if ("lpAccount" in target) return [target.pool, target.lpAccount].filter((a): a is string => a !== null);
  return [target.pool, target.position];
}

const legMints = (target: ActionTarget) =>
  "legs" in target ? target.legs.map((l) => l.mint) : [target.tokenA.mint, target.tokenB.mint];

export function WithdrawDialog({
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
  const title = `Withdraw from ${positionName(target, lookup)}`;
  const currentAddress = useCurrentAddress();
  const store = useLpRunStore();

  const [share, setShare] = useState<Choice>({ preset: 10_000 });
  const [slippage, setSlippage] = useState<Choice>({ preset: DEFAULT_SLIPPAGE_BPS });
  // Bumped to re-quote the same inputs: `attempt` after a failure; `epoch`
  // with fresh reads, after the pool changed.
  const [attempt, setAttempt] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [result, setResult] = useState<{ key: string; quote: WithdrawQuote | null; error: string | null } | null>(null);
  // µlamports per compute unit; undefined while loading, null if unknown.
  const [unitPrice, setUnitPrice] = useState<number | null | undefined>(undefined);
  const [changed, setChanged] = useState(false);
  const [runId, setRunId] = useState<number | null>(null);
  // Whether the dialog is still open when the store reports a pool change.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const shareId = useId();
  const slippageId = useId();

  const bps = shareBps(share);
  const slip = slippageBps(slippage);
  const key = bps !== null && slip !== null ? `${bps}|${slip}|${epoch}|${attempt}` : null;

  // One module and uncached rpc per dialog; one read cache per epoch.
  const live = useRef<Promise<{ actions: Actions; rpc: ActionRpc }> | null>(null);
  const cache = useRef<{ epoch: number; rpc: ActionRpc } | null>(null);
  const load = () => {
    if (!live.current) {
      const loading = (async () => {
        const actions = await import("@/lib/actions/build");
        return { actions, rpc: actions.createActionRpc(new URL("/api/rpc", window.location.origin).href) };
      })();
      live.current = loading;
      loading.catch(() => {
        if (live.current === loading) live.current = null;
      });
    }
    return live.current;
  };
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const { actions, rpc } = await loadRef.current();
        const fees = await rpc.priorityFees(feeAccounts(target));
        if (current) setUnitPrice(actions.computeUnitPrice(fees));
      } catch {
        if (current) setUnitPrice(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [target]);

  useEffect(() => {
    if (key === null || bps === null || slip === null) return;
    let current = true;
    void (async () => {
      let actions: Actions | undefined;
      try {
        const loaded = await loadRef.current();
        actions = loaded.actions;
        if (cache.current?.epoch !== epoch)
          cache.current = { epoch, rpc: actions.cachedReads(loaded.rpc, QUOTE_CACHE_MS) };
        const quote = await actions.quoteWithdraw(cache.current.rpc, wallet.address, target, bps, slip);
        if (current) setResult({ key, quote, error: null });
      } catch (error) {
        if (current) setResult({ key, quote: null, error: withdrawErrorText(error, actions?.isRpcBusy) });
      }
    })();
    return () => {
      current = false;
    };
  }, [key, bps, slip, epoch, wallet.address, target]);

  const run = store.run !== null && store.run.id === runId ? store.run : null;
  const prompting = run?.steps.some((s) => s.status === "awaiting-approval") ?? false;
  const loading = key !== null && result?.key !== key;
  // No amounts for an invalid or emptied input: the last quote was for another share.
  const quote = key === null ? null : (result?.quote ?? null);
  // Refusals the quote implies without throwing (the build would throw).
  const refusal =
    quote === null
      ? null
      : quote.withdrawableBps <= 0
        ? quote.dust
          ? DUST
          : NOTHING_YET
        : tooSmall(quote)
          ? TOO_SMALL
          : null;
  const error = !loading && result?.key === key ? (result.error ?? refusal) : null;
  const busy = store.run !== null && store.run.phase !== "done";
  const canReview =
    key !== null && !loading && quote !== null && refusal === null && !busy && runId === null;

  const chooseShare = (choice: Choice) => {
    if ("preset" in choice && "preset" in share && share.preset === choice.preset && error) setAttempt((a) => a + 1);
    setShare(choice);
  };
  const chooseSlippage = (choice: Choice) => {
    if ("preset" in choice && "preset" in slippage && slippage.preset === choice.preset && error) setAttempt((a) => a + 1);
    setSlippage(choice);
  };

  const reviewInWallet = () => {
    if (!canReview || bps === null || slip === null || !quote) return;
    const id = startWithdrawRun({
      wallet,
      resource: target.protocol,
      target,
      bps,
      slippageBps: slip,
      closes: quote.closes,
      currentAddress,
      onChanged: () => {
        if (!mounted.current) return false;
        setRunId(null);
        setChanged(true);
        setEpoch((e) => e + 1);
        return true;
      },
    });
    if (id === null) return;
    setRunId(id);
    setChanged(false);
  };

  // Names from the page, decimals from the live quote.
  const show = (amounts: TokenAmount[]) =>
    amounts
      .map((a) => formatAtoms(a.mint, a.atoms, (mint) => ({ decimals: a.decimals, name: lookup(mint).name })))
      .join(" + ");
  const sol = (lamports: bigint) => formatAtoms(WSOL_MINT, lamports.toString(), lookup);
  const networkFee =
    quote && typeof unitPrice === "number" && /^\d+$/.test(quote.rentLamports)
      ? "~" +
        sol(
          BigInt(BASE_FEE_LAMPORTS) +
            BigInt(Math.ceil((unitPrice * ESTIMATED_UNITS) / MICRO)) +
            BigInt(quote.rentLamports),
        )
      : null;
  const note = quote && quote.withdrawableBps > 0 ? lockNote(quote) : null;
  const wrappedSol = legMints(target).includes(WSOL_MINT);
  // An emptied field waits quietly; anything else out of range says why.
  const shareInvalid = "custom" in share && share.custom.trim() !== "" && bps === null;
  const slippageInvalid = "custom" in slippage && slippage.custom.trim() !== "" && slip === null;

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
              nothingLine="Nothing was withdrawn"
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
              <div className="withdraw-presets" role="group" aria-label="Share to withdraw">
                {SHARE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={"preset" in share && share.preset === preset}
                    onClick={() => chooseShare({ preset })}
                  >
                    {percent(preset)}%
                  </button>
                ))}
              </div>
              <div className="withdraw-custom faint small">
                <label htmlFor={shareId}>or type a percent of the withdrawable part</label>
                <input
                  id={shareId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  step={1}
                  aria-invalid={shareInvalid}
                  aria-describedby={shareInvalid ? shareId + "-error" : undefined}
                  value={"custom" in share ? share.custom : ""}
                  onChange={(e) => chooseShare({ custom: e.target.value })}
                />
                <span aria-hidden="true">%</span>
              </div>
              {shareInvalid && (
                <p id={shareId + "-error"} className="withdraw-invalid" role="alert">
                  {SHARE_ERROR}
                </p>
              )}
              {note && <p className="withdraw-note">{note}</p>}
              <dl className={"withdraw-rows" + (loading ? " loading" : "")} aria-busy={loading}>
                <div>
                  <dt>You receive (about)</dt>
                  <dd className="numeric">{quote ? show(quote.receive) : <UnknownValue reason="No quote yet" />}</dd>
                </div>
                <div>
                  <dt>Includes fees</dt>
                  <dd className="numeric">
                    {!quote ? <UnknownValue reason="No quote yet" /> : quote.fees.length ? show(quote.fees) : "Included in your LP tokens"}
                  </dd>
                </div>
                {quote?.closes && (
                  <div>
                    <dt>Closes position, returns deposit</dt>
                    <dd className="numeric">
                      {quote.depositRefundLamports && /^\d+$/.test(quote.depositRefundLamports)
                        ? "+" + sol(BigInt(quote.depositRefundLamports))
                        : <UnknownValue reason="Refund unavailable" />}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Minimum you&apos;ll accept</dt>
                  <dd className="numeric">
                    {quote ? show(quote.minimums) : <UnknownValue reason="No quote yet" />}
                    <span className="withdraw-chips" role="group" aria-label="Price move limit">
                      {SLIPPAGE_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          aria-pressed={"preset" in slippage && slippage.preset === preset}
                          onClick={() => chooseSlippage({ preset })}
                        >
                          {percent(preset)}%
                        </button>
                      ))}
                      <input
                        id={slippageId}
                        type="number"
                        inputMode="decimal"
                        min={0.01}
                        max={5}
                        step={0.01}
                        placeholder="up to 5"
                        aria-invalid={slippageInvalid}
                        aria-describedby={slippageInvalid ? slippageId + "-error" : undefined}
                        value={"custom" in slippage ? slippage.custom : ""}
                        onChange={(e) => chooseSlippage({ custom: e.target.value })}
                      />
                      <label htmlFor={slippageId} className="faint">
                        % price move
                      </label>
                    </span>
                    {slippageInvalid && (
                      <span id={slippageId + "-error"} className="withdraw-invalid" role="alert">
                        {SLIPPAGE_ERROR}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Network fee</dt>
                  <dd className="numeric">{orUnknown(networkFee, "Fee estimate unavailable")}</dd>
                </div>
              </dl>
              {wrappedSol && <p className="withdraw-note">{WRAPPED_SOL_NOTE}</p>}
              {changed && (
                <p className="withdraw-note" role="status">
                  {WITHDRAW_POOL_CHANGED}
                </p>
              )}
              {error && (
                <p className="withdraw-error" role="alert">
                  {error}
                </p>
              )}
              <div className="withdraw-actions">
                <Dialog.Close asChild>
                  <button type="button" className="action-pill">
                    Cancel
                  </button>
                </Dialog.Close>
                <button type="button" className="action-pill primary" disabled={!canReview} onClick={reviewInWallet}>
                  Review in wallet
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
