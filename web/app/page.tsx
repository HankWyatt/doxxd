import { ArrowDown, ArrowRight, ArrowUpRight, Check, Eye, Layers3, ScanLine } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AddressSearch } from "@/components/address-search";
import { PortfolioPreview } from "@/components/home/portfolio-preview";
import "./home.css";

export default function HomePage() {
  return (
    <div className="landing">
      <AppHeader />
      <main>
        <section className="landing-hero" aria-labelledby="home-title">
          <div className="hero-coordinate" aria-hidden="true">01 / EXPLORE</div>
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">
              <span className="solana-glyph" aria-hidden="true"><i /><i /><i /></span>
              A LITTLE MORE TRANSPARENCY. A LOT MORE SOLANA.
            </p>
            <h1 id="home-title">Every wallet.<br /><span>In plain sight.</span></h1>
            <p className="landing-intro">Your wallet. That whale. Any address.<br />Bring tokens, DeFi positions, and activity into focus.</p>
            <div className="landing-search" id="explore-wallet">
              <AddressSearch />
              <p className="landing-search-note">
                <span><Check size={13} /> No wallet connection.</span>
                <span><Check size={13} /> Just an address.</span>
              </p>
            </div>
          </div>
          <PortfolioPreview />
          <a className="landing-scroll" href="#a-better-view">THERE’S MORE TO A WALLET <ArrowDown size={13} /></a>
        </section>
        <section className="landing-protocols" aria-label="Supported protocol views">
          <p>ONE ADDRESS.<br /><strong>MORE OF THE ECOSYSTEM.</strong></p>
          <div className="protocol-wordmarks">
            <span><i className="protocol-orca" aria-hidden="true">◉</i> Orca</span>
            <span><i className="protocol-kamino" aria-hidden="true">K</i> Kamino</span>
            <span><i className="protocol-drift" aria-hidden="true">∿</i> Drift</span>
            <span><i className="protocol-raydium" aria-hidden="true">R</i> Raydium</span>
            <span><i className="protocol-meteora" aria-hidden="true">✳</i> Meteora</span>
          </div>
          <span className="protocol-scope-note">Coverage varies by protocol.</span>
        </section>
        <section className="landing-perspective" id="a-better-view" aria-labelledby="perspective-title">
          <div className="perspective-heading">
            <p className="landing-eyebrow"><span className="eyebrow-line" /> LESS TAB HOPPING. MORE CLARITY.</p>
            <h2 id="perspective-title">See how it<br /><span>all connects.</span></h2>
            <p>A wallet is more than its token balance.<br />Get a better view of what’s behind the address.</p>
            <a href="#explore-wallet">Explore a wallet <ArrowRight size={16} /></a>
          </div>
          <div className="perspective-list">
            <article>
              <span className="perspective-icon"><Eye size={22} strokeWidth={1.5} /></span>
              <div><span className="perspective-number">01</span><h3>The assets. The details.</h3><p>Native SOL, token holdings, and available values. From the big picture down to the raw amounts.</p></div>
              <ScanLine className="perspective-end" size={20} strokeWidth={1.3} />
            </article>
            <article>
              <span className="perspective-icon violet"><Layers3 size={22} strokeWidth={1.5} /></span>
              <div><span className="perspective-number">02</span><h3>Beyond the balance.</h3><p>Look inside staking, lending, and liquidity positions across supported Solana protocols.</p></div>
              <span className="perspective-end" aria-hidden="true">↗</span>
            </article>
            <article>
              <span className="perspective-icon peach"><ArrowUpRight size={24} strokeWidth={1.5} /></span>
              <div><span className="perspective-number">03</span><h3>Follow what happened.</h3><p>Explore observed activity and inspect what changed. Save interesting addresses to your watchlist.</p></div>
              <span className="activity-mini" aria-hidden="true"><i /><i /><i /><i /><i /></span>
            </article>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <a href="/" className="brand" aria-label="Doxxd home"><span className="brand-mark" aria-hidden="true">d</span>doxxd<span className="brand-dot">.</span></a>
        <p>Public wallets. Open possibilities.</p>
        <a className="landing-data-link" href="https://dmnd.dev" target="_blank" rel="noreferrer">Powered by <strong>DMND</strong><ArrowUpRight size={13} /></a>
      </footer>
    </div>
  );
}
