"use client";
import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  LogOut,
  WalletCards,
} from "lucide-react";
import {
  claimFeesTarget,
  pillAddress,
  readHideAmounts,
  writeHideAmounts,
} from "@/lib/actions/account";
import type { ConnectedWallet } from "@/lib/actions/wallet-session";
import { walletHref } from "@/lib/address";
import { formatHeadline, headlineLabel } from "@/lib/portfolio/headline";
import { toSummary } from "@/lib/portfolio/model";
import { useWalletResource } from "@/lib/use-wallet-resource";
import { WalletIcon } from "./wallet-icon";

/** The connected wallet's pill and its account card. Loaded lazily by HeaderAccount. */
export function AccountMenu({
  wallet,
  onDisconnect,
}: {
  wallet: ConnectedWallet;
  onDisconnect?(): void;
}) {
  const [open, setOpen] = useState(false);
  const label = pillAddress(wallet.address);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="account-pill" aria-label={`Connected wallet ${label}`}>
        <WalletIcon wallet={wallet} size={20} />
        <span className="account-pill-address">{label}</span>
        <ChevronDown className="account-pill-chevron" size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="account-card"
          aria-label="Wallet account"
          align="end"
          sideOffset={10}
          collisionPadding={16}
        >
          <AccountCard
            wallet={wallet}
            close={() => setOpen(false)}
            onDisconnect={onDisconnect}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AccountCard({
  wallet,
  close,
  onDisconnect,
}: {
  wallet: ConnectedWallet;
  close(): void;
  onDisconnect?(): void;
}) {
  // Mounted only while open, in the browser: storage cannot cause a mismatch.
  const [hidden, setHidden] = useState(readHideAmounts);
  const summary = useWalletResource(wallet.address, "summary");
  const result = summary.result;
  const view = result?.ok ? toSummary(result.data) : null;
  const claim = claimFeesTarget(result?.ok ? result.data.components : null);
  const portfolio = walletHref(wallet.address, "portfolio");
  return (
    <>
        <div className="account-card-head">
          <WalletIcon wallet={wallet} size={28} />
          <span className="account-card-address numeric">{pillAddress(wallet.address)}</span>
        </div>
        <div className="account-worth">
          <div className="label-mono">{view ? headlineLabel(view) : "Net worth"}</div>
          <div className="account-worth-row">
            {!result ? (
              <span
                className="skeleton account-worth-skeleton"
                role="status"
                aria-label="Loading net worth"
              />
            ) : (
              <span className="account-worth-value numeric">
                {hidden ? "••••" : formatHeadline(view?.valueUsd ?? null)}
              </span>
            )}
            <button
              type="button"
              className="icon-button account-eye"
              aria-label="Hide amounts"
              aria-pressed={hidden}
              onClick={() => {
                writeHideAmounts(!hidden);
                setHidden(!hidden);
              }}
            >
              {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
        <div className="account-actions">
          <a className="account-action" href={portfolio} onClick={close}>
            <span className="account-action-icon" aria-hidden="true">
              <WalletCards size={17} />
            </span>
            <span>Portfolio</span>
          </a>
          <CopyAction value={wallet.address} />
          <button
            type="button"
            className="account-action"
            onClick={() => {
              onDisconnect?.();
              close();
              void wallet.disconnect();
            }}
          >
            <span className="account-action-icon" aria-hidden="true">
              <LogOut size={17} />
            </span>
            <span>Disconnect</span>
          </button>
        </div>
        {claim && (
          <div className="account-opportunities">
            <div className="label-mono">Opportunities</div>
            <a className="account-opportunity" href={`${portfolio}#protocol-${claim}`} onClick={close}>
              <span>Claim LP fees</span>
              <ChevronRight size={15} aria-hidden="true" />
            </a>
          </div>
        )}
    </>
  );
}

function CopyAction({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <>
    <button
      type="button"
      className="account-action"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      <span className="account-action-icon" aria-hidden="true">
        {state === "copied" ? <Check size={17} /> : <Copy size={17} />}
      </span>
      <span>{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
    {/* Out of the button, so the announcement never becomes part of its name. */}
    <span className="sr-only" role="status" aria-live="polite">
      {state === "copied" ? "Address copied" : state === "failed" ? "Could not copy the address" : ""}
    </span>
    </>
  );
}
