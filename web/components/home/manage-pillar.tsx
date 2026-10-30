"use client";
import { Wallet } from "lucide-react";
import { useActionsEnabled } from "@/lib/actions/availability";
import { walletHref } from "@/lib/address";
import { useWalletConnectControls } from "../wallet-connect/provider";

/**
 * Opens the site header's wallet picker, the one connect flow (which also
 * takes a homepage visitor to their portfolio once a wallet is chosen).
 */
function openHeaderConnect() {
  const button = document.querySelector<HTMLButtonElement>(
    ".site-header .wallet-connect > button[aria-haspopup]",
  );
  if (!button) return;
  window.scrollTo({ top: 0 });
  if (button.getAttribute("aria-expanded") !== "true") button.click();
  button.focus();
}

/**
 * The third homepage pillar. With wallet actions on, it promises claim and
 * withdraw and offers the connect flow; with them off it is a plain "your own
 * wallet" pillar that promises nothing the site cannot do.
 */
export function ManagePillar() {
  const enabled = useActionsEnabled();
  const { ready, connected } = useWalletConnectControls();
  if (!enabled)
    return (
      <article className="pillar" aria-labelledby="pillar-own">
        <Wallet size={24} strokeWidth={1.6} aria-hidden="true" />
        <h2 id="pillar-own">Your own wallet</h2>
        <p>
          Paste your own address to see your whole Solana portfolio in one place, the same way you
          would look at anyone else&apos;s.
        </p>
        <div className="pillar-mini" aria-hidden="true">
          <div className="pillar-row">
            <span>SOL–USDC fees</span>
            <span className="muted">0.42 SOL</span>
          </div>
          <div className="pillar-row">
            <span>JUP–SOL fees</span>
            <span className="muted">0.08 SOL</span>
          </div>
        </div>
        <a className="pillar-more" href="#explore-wallet">
          Look up your wallet
        </a>
      </article>
    );
  return (
    <article className="pillar" aria-labelledby="pillar-manage">
      <Wallet size={24} strokeWidth={1.6} aria-hidden="true" />
      <h2 id="pillar-manage">Manage your own</h2>
      <p>
        Connect your wallet to claim LP fees and withdraw from Meteora and Raydium pools right
        here. Your wallet signs; Doxxd never holds your keys.
      </p>
      <div className="pillar-mini" aria-hidden="true">
        <div className="pillar-row">
          <span>SOL–USDC fees</span>
          <span className="muted">0.42 SOL</span>
          <span className="pillar-claim">Claim</span>
        </div>
        <div className="pillar-row">
          <span>JUP–SOL fees</span>
          <span className="muted">0.08 SOL</span>
          <span className="pillar-claim">Claim</span>
        </div>
      </div>
      {connected ? (
        <a className="pillar-more" href={walletHref(connected.address, "portfolio")}>
          Go to your wallet
        </a>
      ) : (
        <button type="button" className="pillar-more" disabled={!ready} onClick={openHeaderConnect}>
          Connect wallet
        </button>
      )}
    </article>
  );
}
