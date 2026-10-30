import { Layers, Search } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AddressSearch } from "@/components/address-search";
import { HOME_PROTOCOLS, TRY_WHALE_ADDRESS } from "@/components/home/constants";
import { ManagePillar } from "@/components/home/manage-pillar";
import { PortfolioPreview } from "@/components/home/portfolio-preview";
import { SiteFooter } from "@/components/site-footer";
import { walletHref } from "@/lib/address";
import "./home.css";

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
      <SiteFooter />
    </div>
  );
}
