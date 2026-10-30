import { Layers, Search } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AddressSearch } from "@/components/address-search";
import { GITHUB_URL, HOME_PROTOCOLS, TRY_WHALE_ADDRESS } from "@/components/home/constants";
import { ManagePillar } from "@/components/home/manage-pillar";
import { PortfolioPreview } from "@/components/home/portfolio-preview";
import { walletHref } from "@/lib/address";
import "./home.css";

// The GitHub mark (Primer Octicons "mark-github", MIT). lucide-react 1.x has no brand icons.
function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <div className="landing">
      <AppHeader />
      <main>
        <section className="landing-hero" aria-labelledby="home-title">
          <div className="landing-hero-copy">
            <h1 id="home-title">
              Every wallet.
              <br />
              <span>In plain sight.</span>
            </h1>
            <p className="landing-intro">
              The portfolio tracker for Solana. See what any wallet holds, from tokens to staking,
              lending and liquidity, and follow the ones that matter to you.
            </p>
            <div className="landing-search" id="explore-wallet">
              <AddressSearch />
              <p className="landing-try">
                No wallet needed to look. Not sure where to start?
                <a href={walletHref(TRY_WHALE_ADDRESS, "portfolio")}>Try a whale</a>
              </p>
            </div>
          </div>
          <PortfolioPreview />
        </section>
        <section className="landing-protocols" aria-label="Supported protocols">
          <span className="landing-protocols-lead">Positions from</span>
          <ul>
            {HOME_PROTOCOLS.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
        <section className="landing-pillars" aria-label="What Doxxd does">
          <article className="pillar" aria-labelledby="pillar-track">
            <Search size={24} strokeWidth={1.6} aria-hidden="true" />
            <h2 id="pillar-track">Track any wallet</h2>
            <p>
              Whales, funds, friends, your own. Paste an address and see everything it holds and
              every move it makes.
            </p>
            <div className="pillar-mini" aria-hidden="true">
              <div className="pillar-row">
                <span>Whale 3</span>
                <span className="positive">+4.2% today</span>
              </div>
              <div className="pillar-row">
                <span>Fund wallet</span>
                <span className="negative">−1.1% today</span>
              </div>
              <div className="pillar-row">
                <span>My main</span>
                <span className="positive">+0.8% today</span>
              </div>
            </div>
            <a className="pillar-more" href="/watchlist">
              Open your watchlist
            </a>
          </article>
          <article className="pillar" aria-labelledby="pillar-inside">
            <Layers size={24} strokeWidth={1.6} aria-hidden="true" />
            <h2 id="pillar-inside">See inside every position</h2>
            <p>
              Staking, lending, borrowing and liquidity pools, each with its tokens, values and
              fees, in one view instead of ten tabs.
            </p>
            <div className="pillar-mini" aria-hidden="true">
              <div className="pillar-row">
                <span>Kamino · supplied</span>
                <span>$625K</span>
              </div>
              <div className="pillar-row">
                <span>Staked SOL</span>
                <span>$455K</span>
              </div>
              <div className="pillar-row">
                <span>SOL–USDC pool</span>
                <span>$88K</span>
              </div>
            </div>
          </article>
          <ManagePillar />
        </section>
      </main>
      <footer className="landing-footer">
        <a href="/" className="brand" aria-label="Doxxd home">
          <span className="brand-mark" aria-hidden="true">d</span>doxxd<span className="brand-dot">.</span>
        </a>
        <p>Public wallets. Open possibilities.</p>
        <div className="landing-footer-links">
          <a className="landing-github" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            <GitHubMark />
            Open source on GitHub
          </a>
          <a className="landing-data-link" href="https://dmnd.dev" target="_blank" rel="noreferrer">
            Powered by <strong>DMND</strong>
          </a>
        </div>
      </footer>
    </div>
  );
}
