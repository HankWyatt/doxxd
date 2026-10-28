import {
  ArrowUpRight,
  Layers3,
  Activity,
  Coins,
  ArrowRight,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AddressSearch } from "@/components/address-search";
export default function HomePage() {
  return (
    <>
      <AppHeader />
      <main className="home">
        <p className="eyebrow">
          <span className="network">
            <i />
          </span>
          Solana wallet explorer
        </p>
        <h1>
          A clearer view
          <br />
          of any wallet.
        </h1>
        <p className="intro">
          Your assets tell a bigger story.
          <br />
          Explore tokens, DeFi positions, and on-chain activity in one place.
        </p>
        <AddressSearch />
        <div className="search-note">
          <span>Public addresses. No wallet connection needed.</span>
          <a className="demo-link" href="/demo">
            Explore the demo <ArrowUpRight size={13} />
          </a>
        </div>
        <section className="feature-grid" aria-label="What you can explore">
          <article>
            <Coins size={20} />
            <h2>Every asset in view</h2>
            <p>
              Token balances, native SOL, and the values available for your
              holdings.
            </p>
          </article>
          <article>
            <Layers3 size={20} />
            <h2>Beyond the wallet</h2>
            <p>
              Liquidity, staking, lending, and positions across supported
              protocols.
            </p>
          </article>
          <article>
            <Activity size={20} />
            <h2>Follow the activity</h2>
            <p>Explore observed transactions and inspect what changed.</p>
          </article>
        </section>
        <footer className="footer">
          <span>Built for the Solana ecosystem</span>
          <a href="https://dmnd.dev" target="_blank" rel="noreferrer">
            Data by DMND <ArrowRight size={11} />
          </a>
        </footer>
      </main>
    </>
  );
}
