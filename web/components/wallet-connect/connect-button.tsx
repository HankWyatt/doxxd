"use client";
import { useEffect, useRef, useState } from "react";
import { useConnect, useWallets, type UiWallet } from "@wallet-standard/react-core";
import { isSolanaSigner } from "@/lib/actions/wallet-session";
import { useWalletConnectControls } from "./provider";

export function ConnectButton() {
  const { ready } = useWalletConnectControls();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && root.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
    };
  }, [open]);
  return (
    <span className="wallet-connect" ref={root}>
      <button
        type="button"
        className="button primary"
        disabled={!ready}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        Connect wallet
      </button>
      {open && <WalletPicker onDone={() => setOpen(false)} />}
    </span>
  );
}

function WalletPicker({ onDone }: { onDone(): void }) {
  const wallets = useWallets().filter(isSolanaSigner);
  return (
    <div className="wallet-picker" role="group" aria-label="Choose a Solana wallet">
      {wallets.length === 0 ? (
        <div className="wallet-picker-empty">
          <span>No Solana wallet found</span>
          <a href="https://phantom.com/" target="_blank" rel="noopener noreferrer">
            Get Phantom
          </a>
        </div>
      ) : (
        wallets.map((wallet) => (
          <WalletOption key={wallet.name} wallet={wallet} onDone={onDone} />
        ))
      )}
    </div>
  );
}

function WalletOption({ wallet, onDone }: { wallet: UiWallet; onDone(): void }) {
  const { choose } = useWalletConnectControls();
  const [connecting, connect] = useConnect(wallet);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        className="wallet-option"
        disabled={connecting}
        onClick={async () => {
          setFailed(false);
          try {
            const accounts = await connect();
            if (accounts.length === 0) return setFailed(true);
            choose(wallet.name);
            onDone();
          } catch {
            setFailed(true);
          }
        }}
      >
        {/* Wallet icons are data URIs supplied by the wallet; next/image cannot optimize them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {wallet.icon && <img src={wallet.icon} alt="" width={20} height={20} />}
        <span>{wallet.name}</span>
      </button>
      {failed && (
        <span className="wallet-picker-error" role="alert">
          {wallet.name} did not connect. Try again.
        </span>
      )}
    </>
  );
}
