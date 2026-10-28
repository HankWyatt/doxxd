"use client";
import { useId, useState } from "react";
import { BookmarkCheck, BookmarkPlus, Pencil, Trash2, ArrowUpRight } from "lucide-react";
import { useWatchlist } from "@/lib/use-watchlist";
import { MAX_SAVED_WALLETS, MAX_WATCHLIST_LABEL_LENGTH, type SavedWallet, type WatchlistError, type WatchlistResult } from "@/lib/watchlist";
import { walletHref } from "@/lib/address";
import { short } from "@/lib/portfolio/adapters/shared";

const messages: Record<WatchlistError, string> = {
  storage_unavailable: "Browser storage could not be used. Check your browser settings or available space, then try again.",
  invalid_data: "Saved wallets could not be read. Existing saved data has been left untouched.",
  unsupported_version: "The saved-wallet format is not supported by this version. Existing saved data has been left untouched.",
  limit: `You can save up to ${MAX_SAVED_WALLETS} wallets.`,
  invalid_address: "Enter a valid Solana address.",
  invalid_label: `Use a label of up to ${MAX_WATCHLIST_LABEL_LENGTH} characters.`,
  duplicate: "That wallet is already saved.",
  not_found: "That wallet is no longer saved. Add it again to keep it here.",
};

export function SaveWalletButton({ address }: { address: string }) {
  const { ready, wallets, error, add, remove } = useWatchlist();
  const [actionError, setActionError] = useState<WatchlistError | null>(null);
  const errorId = useId();
  const saved = wallets.some((wallet) => wallet.address === address);
  const failure = error ?? actionError;
  return (
    <span className="save-wallet-control">
      <button
        className="button"
        type="button"
        disabled={!ready || error !== null}
        aria-pressed={saved}
        aria-label={saved ? "Remove wallet from watchlist" : "Save wallet"}
        aria-describedby={failure ? errorId : undefined}
        onClick={() => {
          const result = saved ? remove(address) : add(address);
          setActionError(result.ok ? null : result.reason);
        }}
      >
        {saved ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
        <span>{saved ? "Saved" : "Save wallet"}</span>
      </button>
      {failure && <span id={errorId} className="save-wallet-feedback small" role="alert">{messages[failure]}</span>}
    </span>
  );
}

type Actions = Pick<ReturnType<typeof useWatchlist>, "rename" | "remove">;
function SavedWalletRow({ wallet, actions, report }: {
  wallet: SavedWallet;
  actions: Actions;
  report: (result: WatchlistResult, success: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(wallet.label);
  const labelId = useId();
  return (
    <li className="saved-wallet-row">
      <div className="saved-wallet-identity">
        {editing ? (
          <form className="watchlist-label-form" onSubmit={(event) => {
            event.preventDefault();
            const result = actions.rename(wallet.address, draft);
            report(result, "Label saved.");
            if (result.ok) setEditing(false);
          }}>
            <label htmlFor={labelId}>Label</label>
            <input id={labelId} value={draft} autoFocus onChange={(event) => setDraft(event.target.value)} />
            <span className="inline">
              <button className="button" type="submit">Save label</button>
              <button className="button ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </span>
          </form>
        ) : <strong>{wallet.label || short(wallet.address)}</strong>}
        <span className="mono break small muted">{wallet.address}</span>
      </div>
      <div className="saved-wallet-actions">
        <a className="button ghost" href={walletHref(wallet.address, "portfolio")}>Portfolio <ArrowUpRight size={12} /></a>
        <a className="button ghost" href={walletHref(wallet.address, "activity")}>Activity <ArrowUpRight size={12} /></a>
        <button className="icon-button" type="button" aria-label={"Edit label for " + wallet.address} onClick={() => {
          setDraft(wallet.label);
          setEditing(true);
        }}><Pencil size={14} /></button>
        <button className="icon-button" type="button" aria-label={"Remove " + wallet.address} onClick={() => report(actions.remove(wallet.address), "Wallet removed.")}><Trash2 size={14} /></button>
      </div>
    </li>
  );
}

export function WatchlistManager() {
  const watchlist = useWatchlist();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const enabled = watchlist.ready && watchlist.error === null;
  function report(result: WatchlistResult, success: string) {
    setFeedback({ error: !result.ok, text: result.ok ? success : messages[result.reason] });
  }
  return (
    <main className="page watchlist-page">
      <div className="breadcrumb"><a href="/">Explorer</a><span>›</span><span>Watchlist</span></div>
      <div className="watchlist-heading">
        <div><p className="eyebrow">Your addresses</p><h1>Watchlist</h1></div>
        <span className="badge">Saved in this browser</span>
      </div>
      <p className="muted watchlist-intro">Keep public wallets handy. Open an address to load its portfolio or activity. No account or wallet connection needed.</p>
      {watchlist.error && (
        <div className="watchlist-storage-error panel" role="alert">
          <p>{messages[watchlist.error]}</p>
          <button className="button" type="button" onClick={() => { setFeedback(null); watchlist.reload(); }}>Try again</button>
        </div>
      )}
      <form className="panel watchlist-add" aria-label="Save a wallet" onSubmit={(event) => {
        event.preventDefault();
        if (!enabled) return;
        const result = watchlist.add(address, label);
        report(result, "Wallet saved.");
        if (result.ok) { setAddress(""); setLabel(""); }
      }}>
        <label className="watchlist-field">
          <span className="watchlist-field-label">Solana wallet address</span>
          <input value={address} disabled={!enabled} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Paste an address" onChange={(event) => { setAddress(event.target.value); setFeedback(null); }} />
        </label>
        <label className="watchlist-field">
          <span className="watchlist-field-label">Label <span className="faint">(optional)</span></span>
          <input value={label} disabled={!enabled} placeholder="A name you’ll recognize" onChange={(event) => { setLabel(event.target.value); setFeedback(null); }} />
        </label>
        <button className="button" type="submit" disabled={!enabled}><BookmarkPlus size={14} />Save wallet</button>
      </form>
      {feedback && <p className={feedback.error ? "search-error" : "watchlist-feedback small"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      <section aria-label="Saved wallets" className="watchlist-saved">
        <div className="section-heading"><h2>Saved wallets {watchlist.ready && !watchlist.error && <span className="count">{watchlist.wallets.length}</span>}</h2></div>
        <div className="panel">
          {!watchlist.ready ? <p className="empty-state" role="status">Loading saved wallets…</p> : watchlist.error ? <p className="empty-state">Saved wallets could not be loaded.</p> : watchlist.wallets.length ? (
            <ul className="saved-wallet-list">
              {watchlist.wallets.map((wallet) => <SavedWalletRow key={wallet.address} wallet={wallet} actions={watchlist} report={report} />)}
            </ul>
          ) : <div className="empty-state"><strong>No saved wallets yet</strong>Save an address above or from a wallet’s portfolio page.</div>}
        </div>
      </section>
      <p className="small faint watchlist-note">Labels are yours. Saved wallets stay in this browser and are removed if its saved site data is cleared.</p>
    </main>
  );
}
