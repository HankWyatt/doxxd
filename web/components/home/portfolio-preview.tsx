import { Activity, ArrowDownLeft, ArrowUpRight, Layers3, Wallet } from "lucide-react";

function SolanaMark() {
  return <span className="solana-glyph" aria-hidden="true"><i /><i /><i /></span>;
}

export function PortfolioPreview() {
  return (
    <div className="portfolio-scene" role="img" aria-label="Public wallet explorer illustration: one Solana address brings holdings, protocol positions, and activity into view.">
      <div aria-hidden="true">
        <div className="scene-orbit orbit-one" /><div className="scene-orbit orbit-two" />
        <div className="scene-cross cross-one">+</div><div className="scene-cross cross-two">+</div>
        <div className="scene-token token-sol"><SolanaMark /></div>
        <div className="scene-token token-usdc">$</div>
        <div className="scene-token token-jito">J</div>
        <div className="preview-window">
          <div className="preview-chrome">
            <div className="window-dots"><i /><i /><i /></div>
            <span>doxxd<span className="preview-url"> / wallet</span></span>
            <span className="preview-network"><i /> SOLANA</span>
          </div>
          <div className="preview-body">
            <div className="preview-wallet">
              <span className="preview-avatar"><Wallet size={19} strokeWidth={1.5} /></span>
              <div><strong>An address. A clearer picture.</strong><span>PUBLIC WALLET EXPLORER</span></div>
              <span className="preview-access">READ ONLY</span>
            </div>
            <div className="preview-focus">
              <div><p>Your wallet. Any wallet.</p><strong>One address.<br /><span>Every angle.</span></strong></div>
              <div className="preview-ring"><div><SolanaMark /></div><span className="ring-orbit-dot" /></div>
            </div>
            <div className="preview-tabs"><span>Portfolio <i /></span><span>Activity</span></div>
            <div className="preview-scope"><span className="scope-symbol"><Wallet size={17} /></span><div><strong>Wallet holdings</strong><span>Tokens, balances, and available values</span></div><ArrowUpRight size={13} /></div>
            <div className="preview-scope"><span className="scope-symbol violet"><Layers3 size={17} /></span><div><strong>Protocol positions</strong><span>Staking, lending, and liquidity</span></div><ArrowUpRight size={13} /></div>
            <div className="preview-scope"><span className="scope-symbol peach"><Activity size={17} /></span><div><strong>On-chain activity</strong><span>Transfers, trades, and what changed</span></div><ArrowUpRight size={13} /></div>
          </div>
        </div>
        <div className="scene-activity">
          <span className="activity-indicator"><ArrowDownLeft size={17} /></span>
          <div><strong>A closer look at every move.</strong><span>Transfers, trades, and what changed.</span></div>
          <span className="activity-trail">↗</span>
        </div>
        <p className="scene-caption"><span /> PUBLIC ADDRESSES · ONE CLEARER VIEW</p>
        <span className="scene-coordinate">SOL / 001</span>
      </div>
    </div>
  );
}
