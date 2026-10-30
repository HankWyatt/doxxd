/**
 * The homepage hero: one orchestrated moment, looping every 9 s. A shortened
 * address types into the bar, then the portfolio resolves below it (CSS only,
 * see `.pf-*` in app/home.css; static under prefers-reduced-motion).
 *
 * Every figure here is synthetic and the address is not a real wallet, so the
 * card never implies anyone's holdings.
 */
const SPLIT = [
  { label: "Wallet", value: "$1.25M", share: 44 },
  { label: "Kamino lending", value: "$625K", share: 22 },
  { label: "Staked SOL", value: "$455K", share: 16 },
  { label: "Raydium pools", value: "$312K", share: 11 },
  { label: "Meteora pools", value: "$199K", share: 7 },
];

export const PREVIEW_ADDRESS = "7xKX…9fQa";

export function PortfolioPreview() {
  return (
    <div
      className="pf"
      role="img"
      aria-label="Example portfolio with made-up numbers: a wallet address resolves into its net worth, holdings split and recent moves."
    >
      <div className="pf-bar" aria-hidden="true">
        <span>doxxd.io/wallet/</span>
        <span className="pf-addr">{PREVIEW_ADDRESS}</span>
        <span className="pf-example">Example</span>
      </div>
      <div className="pf-body" aria-hidden="true">
        <div className="pf-worth">
          <div>
            <div className="pf-label">Net worth</div>
            <div className="pf-value">$2,841,390</div>
          </div>
          <div className="pf-who">
            412 tokens
            <br />9 protocols
          </div>
        </div>
        <div className="pf-split">
          {SPLIT.map((part, i) => (
            <span key={part.label} className={`swatch-${i + 1}`} style={{ flex: part.share }} />
          ))}
        </div>
        <div className="pf-legend">
          {SPLIT.map((part, i) => (
            <div key={part.label}>
              <i className={`swatch-${i + 1}`} />
              {part.label}
              <b>{part.value}</b>
            </div>
          ))}
        </div>
        <div className="pf-moves">
          <span>
            <b>Bought</b> 18,400 JUP · 2h ago
          </span>
          <span>
            <b>Added</b> liquidity to SOL–USDC · 5h ago
          </span>
        </div>
      </div>
    </div>
  );
}
