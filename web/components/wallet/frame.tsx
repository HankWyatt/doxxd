"use client";
import { createContext, useContext, useState } from "react";
import { RefreshCw, ChevronRight } from "lucide-react";
import { SiteFooter } from "../site-footer";
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
import { SolscanMark } from "@/components/solscan-mark";
import { WalletSummary } from "./summary";
import { RecoveryNotice } from "./recovery-notice";
import { SaveWalletButton } from "../watchlist/watchlist";
import { HeaderWallet } from "../wallet-connect/header-wallet";
import { CopyButton } from "../copy-button";
import { avatarStyle } from "@/lib/portfolio/headline";
const SummaryContext = createContext<ResourceData["summary"] | null>(null);
export const usePortfolioSummary = () => useContext(SummaryContext);
/** Whether the summary is still loading, loaded, or failed to load. */
const SummaryStatusContext = createContext<"loading" | "ready" | "failed">(
  "loading",
);
export const usePortfolioSummaryStatus = () => useContext(SummaryStatusContext);
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
      <WalletSummary
        result={summary.result}
        loading={summary.loading}
        retry={summary.refresh}
        identity={
          <div className="wallet-id">
            <span className="wallet-avatar" style={avatarStyle(address)} aria-hidden="true" />
            <div>
              <h1 className="wallet-address">{address}</h1>
              <div className="inline small muted">
                <CopyButton
                  key={address}
                  value={address}
                  label="Copy wallet address"
                />
                <a
                  className="icon-button"
                  href={explorerHref("account", address)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View wallet on Solscan"
                >
                  <SolscanMark />
                </a>
              </div>
            </div>
          </div>
        }
        actions={
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
            <HeaderWallet viewed={address} />
          </div>
        }
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
        <SummaryStatusContext.Provider
          value={
            !summary.result ? "loading" : summary.result.ok ? "ready" : "failed"
          }
        >
          {children}
        </SummaryStatusContext.Provider>
      </SummaryContext.Provider>
      <SiteFooter />
    </main>
  );
}
