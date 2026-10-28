"use client";
import { createContext, useContext, useState } from "react";
import { Wallet, ArrowUpRight, RefreshCw, ChevronRight } from "lucide-react";
import {
  useWalletResource,
  WalletRefreshContext,
} from "@/lib/use-wallet-resource";
import {
  LIVE_MODE,
  type WalletDataMode,
  type ResourceData,
} from "@/lib/dmnd/contracts";
import { walletHref } from "@/lib/address";
import { explorerHref } from "@/lib/safe-url";
import { WalletSummary } from "./summary";
import { RecoveryNotice } from "./recovery-notice";
import { SaveWalletButton } from "../watchlist/watchlist";
import { CopyButton } from "../copy-button";
import { short } from "@/lib/portfolio/adapters/shared";
const SummaryContext = createContext<ResourceData["summary"] | null>(null);
export const usePortfolioSummary = () => useContext(SummaryContext);
export function WalletFrame({
  address,
  tab = "portfolio",
  mode = LIVE_MODE,
  children,
}: {
  address: string;
  tab?: "portfolio" | "activity";
  mode?: WalletDataMode;
  children: React.ReactNode;
}) {
  const [revision, setRevision] = useState(0);
  return (
    <WalletRefreshContext.Provider value={revision}>
      <FrameContent
        address={address}
        tab={tab}
        mode={mode}
        refresh={() => setRevision((n) => n + 1)}
      >
        {children}
      </FrameContent>
    </WalletRefreshContext.Provider>
  );
}
function FrameContent({
  address,
  tab,
  mode,
  refresh,
  children,
}: {
  address: string;
  tab: "portfolio" | "activity";
  mode: WalletDataMode;
  refresh: () => void;
  children: React.ReactNode;
}) {
  const summary = useWalletResource(address, "summary", {}, mode);
  const href = (next: "portfolio" | "activity") => walletHref(address, next);
  return (
    <main className="page">
      <div className="breadcrumb">
        <a href="/">Explorer</a>
        <ChevronRight size={11} />
        <span>Wallet</span>
      </div>
      <div className="wallet-topline">
        <div className="wallet-id">
          <span className="wallet-avatar">
            <Wallet size={21} />
          </span>
          <div>
            <h1>{short(address)}</h1>
            <div className="inline small muted">
              <span className="mono">{short(address)}</span>
              <CopyButton
                key={address}
                value={address}
                label="Copy wallet address"
              />
              <a
                className="icon-button"
                href={explorerHref("address", address)}
                target="_blank"
                rel="noreferrer"
                aria-label="View wallet on Solana Explorer"
              >
                <ArrowUpRight size={13} />
              </a>
            </div>
          </div>
        </div>
        <div className="wallet-actions">
          {mode.kind === "live" && <SaveWalletButton key={address} address={address} />}
        <button
          type="button"
          className="button"
          onClick={refresh}
          aria-label="Refresh wallet"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
        </div>
      </div>
      <details className="full-address">
        <summary>Full address</summary>
        <p className="mono break">{address}</p>
      </details>
      <WalletSummary
        result={summary.result}
        loading={summary.loading}
        retry={summary.refresh}
      />
      <RecoveryNotice state={summary.recovery} retained={Boolean(summary.refreshError)} retry={summary.refresh} />
      <nav className="tabs" aria-label="Wallet views">
        <a
          href={href("portfolio")}
          aria-current={tab === "portfolio" ? "page" : undefined}
        >
          Portfolio
        </a>
        <a
          href={href("activity")}
          aria-current={tab === "activity" ? "page" : undefined}
        >
          Activity
        </a>
        <span className="tab-meta">Solana mainnet</span>
      </nav>
      <SummaryContext.Provider
        value={summary.result?.ok ? summary.result.data : null}
      >
        {children}
      </SummaryContext.Provider>
      <footer className="footer">
        <span>Public wallet data · Read-only explorer</span>
        <a href="https://dmnd.dev" target="_blank" rel="noreferrer">
          Powered by DMND <ArrowUpRight size={11} />
        </a>
      </footer>
    </main>
  );
}
