"use client";
import { useRef, useState } from "react";
import { ChevronDown, Info, Layers3 } from "lucide-react";
import type { ProtocolResource, Schemas } from "@/lib/dmnd/contracts";
import { protocolResources, resources } from "@/lib/dmnd/resources";
import {
  formatCompactAmount,
  formatUsd,
  formatPrice,
  compareDecimalDesc,
  atomsToUi,
  isAtLeast,
} from "@/lib/decimal";
import { tokenImageCandidates, explorerHref } from "@/lib/safe-url";
import { short } from "@/lib/portfolio/adapters/shared";
import {
  indexedPnl,
  formatSignedUsd,
  pnlTone,
  type HoldingsTradingDetails,
} from "@/lib/indexed-trading";
// Priced tokens listed before the "Show all" control; the rest stay one click away.
const TOP_TOKENS = 10;
// Balances worth less than a cent collapse with the unpriced ones.
const TINY_VALUE = "0.01";
export type Row = {
  id: string;
  mint?: string;
  symbol: string;
  name: string;
  image?: string | null;
  amount: string | null;
  raw: string;
  price?: string | null;
  value?: string | null;
  estimate?: string | null;
  priceAt?: string | null;
  accountCount?: number;
  balanceSlot?: number | null;
  receipt?: Receipt;
};
type Receipt = {
  label: string;
  resource?: ProtocolResource;
  position: string | null;
  pool: string | null;
  // Creator-supplied token metadata: searchable, never a trust signal.
  tokenSymbol: string | null;
  tokenName: string | null;
};
type ShowProtocol = (resource: ProtocolResource) => void;
// An LP position NFT is a receipt for a protocol position: it is never valued
// here, and its token metadata is creator-supplied rather than a trust signal.
function positionReceipt(asset: Schemas["WalletAsset"]): Receipt | null {
  if (!asset.position) return null;
  const { protocol } = asset.position;
  const resource = protocolResources.find(
    (r) => resources[r].componentId === protocol,
  );
  return {
    label: resource ? resources[resource].label : protocol.replaceAll("_", " "),
    resource,
    position: asset.position.position ?? null,
    pool: asset.position.pool ?? null,
    tokenSymbol: asset.symbol?.trim() || null,
    tokenName: asset.name?.trim() || null,
  };
}
// A priced token ranks and collapses by its known value, else its estimate.
function effectiveValue(row: Row) {
  return row.value ?? row.estimate;
}
/**
 * Splits the card's rows. Receipts (LP position NFTs) never list as rows; a
 * token with no value or estimate, or one below a cent, collapses; the rest
 * sort by value (or estimate) descending.
 */
export function splitRows(rows: Row[]): {
  shown: Row[];
  collapsed: Row[];
  receipts: Row[];
} {
  const sorted = [...rows].sort((a, b) =>
    compareDecimalDesc(effectiveValue(a), effectiveValue(b)),
  );
  const receipts = sorted.filter((row) => row.receipt);
  const tokens = sorted.filter((row) => !row.receipt);
  const priced = (row: Row) => isAtLeast(effectiveValue(row), TINY_VALUE);
  return {
    shown: tokens.filter(priced),
    collapsed: tokens.filter((row) => !priced(row)),
    receipts,
  };
}
// One summary line per protocol, in the order the receipts first appear.
function receiptGroups(receipts: Row[]) {
  const groups = new Map<
    string,
    { key: string; label: string; resource?: ProtocolResource; count: number }
  >();
  for (const { receipt } of receipts) {
    if (!receipt) continue;
    const key = receipt.resource ?? receipt.label;
    const group = groups.get(key);
    if (group) group.count++;
    else
      groups.set(key, {
        key,
        label: receipt.label,
        resource: receipt.resource,
        count: 1,
      });
  }
  return [...groups.values()];
}
function AssetIcon({ row }: { row: Row }) {
  const candidates = tokenImageCandidates(row.image);
  const imageKey = candidates.join("\n");
  const [failed, setFailed] = useState({ key: "", urls: [] as string[] });
  const failures = failed.key === imageKey ? failed.urls : [];
  const image = candidates.find((candidate) => !failures.includes(candidate));
  return (
    <span className="asset-icon">
      {row.id === "native-sol" ? (
        <svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
          <path fill="#80F5CF" d="M9 6h20l-6 5H3z" />
          <path fill="#A4A5F8" d="M3 13.5h20l6 5H9z" />
          <path fill="#B77BF3" d="M9 21h20l-6 5H3z" />
        </svg>
      ) : image ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((previous) => ({
            key: imageKey,
            urls: [...(previous.key === imageKey ? previous.urls : []), image],
          }))}
        />
      ) : (
        row.symbol.slice(0, 2)
      )}
    </span>
  );
}
function TradeTotal({
  total,
  side,
}: {
  total: Schemas["HolderTradeTotals"];
  side: "buy" | "sell";
}) {
  return (
    <span className="holding-trade-total">
      <span className={total.usd == null ? "muted" : "holding-trade-" + side}>
        {formatUsd(total.usd)}
      </span>
      <small>{total.count.toLocaleString()} {total.count === 1 ? "trade" : "trades"}</small>
    </span>
  );
}
function TradeTime({ value, includeYear = false }: { value: string; includeYear?: boolean }) {
  const date = new Date(value);
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } as const : {}) })}
    </time>
  );
}
function TradingCoverage({ trading }: { trading: HoldingsTradingDetails }) {
  return (
    <div className="holdings-trading-footer" aria-label="Trading data coverage">
      <div>
        <p role="status">
          {trading.loading ? "Loading indexed trading details…" : "Indexed trading details"}
          {" · "}{trading.loadedCount.toLocaleString()}
          {trading.positionCount == null ? " tokens loaded" : " of " + trading.positionCount.toLocaleString() + " tokens loaded"}
        </p>
        {trading.positionsSince && (
          <p>Indexed since <TradeTime value={trading.positionsSince} includeYear />.</p>
        )}
        {trading.positionsTracked === false && (
          <p>Trade tracking is unavailable for this wallet. Recorded trading details may be incomplete.</p>
        )}
        {trading.error && (
          <p role="status">Trading details couldn’t load. Available holdings remain visible.</p>
        )}
        {trading.continuationUnavailable && (
          <p>More indexed tokens exist, but continuation is unavailable. Reload trading details to start again.</p>
        )}
      </div>
      <div className="holdings-trading-actions">
        {trading.hasMore && (
          <button className="button" type="button" disabled={trading.loading} onClick={trading.loadMore}>
            Load more trading details
          </button>
        )}
        {(trading.error || trading.continuationUnavailable) && (
          <button className="button" type="button" disabled={trading.loading} onClick={trading.reload}>
            Reload trading details
          </button>
        )}
      </div>
    </div>
  );
}
export function Holdings({
  overview,
  showProtocol,
  trading,
}: {
  overview: Schemas["WalletOverview"];
  /** Reveals and scrolls to a protocol section; without it receipts are not linked. */
  showProtocol?: ShowProtocol;
  trading?: HoldingsTradingDetails;
}) {
  return (
    <HoldingsTable
      key={overview.wallet}
      overview={overview}
      showProtocol={showProtocol}
      trading={trading}
    />
  );
}
function plural(count: number, noun: string) {
  return count + " " + noun + (count === 1 ? "" : "s");
}
function HoldingsTable({
  overview,
  showProtocol,
  trading,
}: {
  overview: Schemas["WalletOverview"];
  showProtocol?: ShowProtocol;
  trading?: HoldingsTradingDetails;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  // Search results page separately so clearing a search restores the list.
  const [showAllMatches, setShowAllMatches] = useState(false);
  const [showCollapsed, setShowCollapsed] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const rows: Row[] = overview.assets.map((a) => {
    const row: Row = {
      id: a.mint,
      mint: a.mint,
      symbol: a.symbol?.trim() ? a.symbol : short(a.mint),
      name: a.name?.trim() ? a.name : "Unknown token",
      image: a.image_url,
      amount: a.ui_amount ?? null,
      raw: a.amount,
      price: a.price_usd,
      value: a.value_usd,
      estimate: a.estimated_value_usd,
      priceAt: a.price_updated_at,
      accountCount: a.account_count,
      balanceSlot: a.last_slot,
    };
    const receipt = positionReceipt(a);
    return receipt
      ? {
          ...row,
          symbol: receipt.label + " position",
          name: "LP position receipt",
          image: null,
          price: null,
          value: null,
          estimate: null,
          priceAt: null,
          receipt,
        }
      : row;
  });
  const receiptCount = rows.filter((row) => row.receipt).length;
  if (
    overview.native_sol_lamports !== null &&
    overview.native_sol_lamports !== undefined
  )
    rows.push({
      id: "native-sol",
      symbol: "SOL",
      name: "Solana",
      amount: atomsToUi(overview.native_sol_lamports, 9),
      raw: overview.native_sol_lamports,
      price: overview.sol_price_usd,
      value: overview.native_sol_value_usd,
      priceAt: overview.sol_price_updated_at,
      balanceSlot: overview.native_sol_slot,
    });
  if (overview.wrapped_sol_lamports && overview.wrapped_sol_lamports !== "0")
    rows.push({
      id: "wrapped-sol",
      mint: "So11111111111111111111111111111111111111112",
      symbol: "WSOL",
      name: "Wrapped SOL",
      amount: atomsToUi(overview.wrapped_sol_lamports, 9),
      raw: overview.wrapped_sol_lamports,
      price: overview.sol_price_usd,
      value: overview.wrapped_sol_value_usd,
      priceAt: overview.sol_price_updated_at,
      balanceSlot: overview.wrapped_sol_slot,
    });
  rows.sort((a, b) =>
    compareDecimalDesc(effectiveValue(a), effectiveValue(b)),
  );
  const search = query.trim().toLowerCase();
  const matches = search
    ? rows.filter((row) =>
        [
          row.symbol,
          row.name,
          row.mint,
          row.id,
          row.receipt?.tokenSymbol,
          row.receipt?.tokenName,
        ].some((value) =>
          value?.toLowerCase().includes(search),
        ),
      )
    : rows;
  const { shown, collapsed, receipts } = splitRows(rows);
  // A search lists every match, collapsed or not; otherwise only the top
  // priced tokens show until the reader asks for more.
  const pool = search ? matches : shown;
  const expanded = search ? showAllMatches : showAll;
  const listed = expanded ? pool : pool.slice(0, TOP_TOKENS);
  const visibleRows = search
    ? listed
    : showCollapsed
      ? [...listed, ...collapsed]
      : listed;
  const receiptLines = receiptGroups(receipts);
  function changeQuery(value: string) {
    setQuery(value);
    setShowAllMatches(false);
    setOpen(null);
  }
  return (
    <section id="holdings">
      <div className="panel">
        <div className="holdings-head">
          <span className="protocol-icon" aria-hidden="true">W</span>
          <h2>Wallet</h2>
          <span className="holdings-total numeric">
            {formatUsd(overview.known_value_usd)}{" "}
            <span className="faint">known</span>
          </span>
          {rows.length > 0 && (
            <div className="holdings-search">
              <label>
                <span className="sr-only">Search observed holdings</span>
                <input
                  ref={searchInput}
                  type="search"
                  placeholder="Token name, symbol or mint"
                  value={query}
                  onChange={(event) => changeQuery(event.target.value)}
                />
              </label>
              {query.length > 0 && (
                <button
                  type="button"
                  className="button"
                  aria-label="Clear holdings search"
                  onClick={() => {
                    changeQuery("");
                    searchInput.current?.focus();
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
        {overview.coverage.snapshot_status === "failed" && (
          <p className="coverage-note" role="status">
            Wallet refresh failed. Showing available holdings; some balances may be missing or out of date.
          </p>
        )}
        <p className="holdings-search-status" role="status">
          {search
            ? matches.length + " of " + rows.length + " observed holdings match"
            : ""}
        </p>
        {(overview.native_sol_lamports == null ||
          overview.wrapped_sol_lamports == null) && (
          <p
            className="small muted"
            style={{ padding: "14px 18px", margin: 0 }}
          >
            {overview.native_sol_lamports == null && (
              <span>Native SOL balance: Unknown</span>
            )}
            {overview.native_sol_lamports == null &&
              overview.wrapped_sol_lamports == null &&
              " · "}
            {overview.wrapped_sol_lamports == null && (
              <span>Wrapped SOL balance: Unknown</span>
            )}
          </p>
        )}
        {!rows.length ? (
          <div className="empty-state">
            <strong>
              {overview.coverage.complete
                ? "No token balances in the available snapshot"
                : "Token balances aren’t available yet"}
            </strong>
            {overview.coverage.complete
              ? "This describes the token-account snapshot only. Native SOL, wrapped SOL and protocol positions have independent coverage."
              : "A missing or incomplete snapshot does not establish an empty wallet."}
          </div>
        ) : search && matches.length === 0 ? (
          <div className="empty-state">No observed holdings match this search.</div>
        ) : (
          <>
            {visibleRows.length > 0 && (
              <div className="table-scroll">
                <table className="holdings-table">
                  <thead>
                    <tr>
                      <th className="token-col">Token</th>
                      <th className="right hide-mobile price-col">Price</th>
                      <th className="right hide-mobile amount-col">Amount</th>
                      <th className="right hide-mobile holding-trading-col">
                        P&amp;L{" "}
                        <span className="info-tip">
                          <button
                            type="button"
                            className="info-button"
                            aria-label="estimate"
                            aria-describedby="holdings-pnl-note"
                          >
                            <Info size={12} aria-hidden="true" />
                          </button>
                          <span role="tooltip" id="holdings-pnl-note" aria-hidden="true">
                            Indexed average-cost estimate; partial history, opening balances, transfers and fees can affect actual results.
                          </span>
                        </span>
                      </th>
                      <th className="right">USD Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <HoldingRow
                        key={row.id}
                        row={row}
                        open={open === row.id}
                        toggle={() => setOpen(open === row.id ? null : row.id)}
                        showProtocol={showProtocol}
                        trading={trading}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="holdings-more">
              {pool.length > TOP_TOKENS && (
                <button
                  type="button"
                  className="holdings-toggle"
                  aria-expanded={expanded}
                  onClick={() => {
                    if (search) setShowAllMatches(!showAllMatches);
                    else setShowAll(!showAll);
                    setOpen(null);
                  }}
                >
                  {expanded
                    ? "Show fewer"
                    : search
                      ? "Show all " + pool.length + " matches"
                      : "Show all " + pool.length + " tokens"}
                </button>
              )}
              {!search && collapsed.length > 0 && (
                <button
                  type="button"
                  className="holdings-toggle"
                  aria-expanded={showCollapsed}
                  onClick={() => {
                    setShowCollapsed(!showCollapsed);
                    setOpen(null);
                  }}
                >
                  {showCollapsed
                    ? "Hide " + plural(collapsed.length, "token") + " with no price or tiny balances"
                    : "+" + plural(collapsed.length, "token") + " with no price or tiny balances · show"}
                </button>
              )}
              {!search &&
                receiptLines.map((line) => (
                  <p className="holdings-note" key={line.key}>
                    <Layers3 size={13} aria-hidden="true" />
                    <span>
                      <strong>{plural(line.count, "LP position NFT")}</strong>
                      {" — "}
                      {line.resource && showProtocol ? (
                        <>
                          shown in{" "}
                          <a
                            href={"#protocol-" + line.resource}
                            onClick={(event) => {
                              event.preventDefault();
                              showProtocol(line.resource!);
                            }}
                          >
                            {line.label}
                          </a>{" "}
                          below
                        </>
                      ) : line.resource ? (
                        line.label
                      ) : (
                        line.label + " (no protocol view)"
                      )}
                    </span>
                  </p>
                ))}
            </div>
          </>
        )}
        {trading && <TradingCoverage trading={trading} />}
        <details className="coverage-note">
          <summary>
            <Info size={12} aria-hidden="true" />{" "}
            {overview.coverage.complete
              ? "Token snapshot observed"
              : "Token coverage is incomplete"}
            {overview.unpriced_asset_count > 0
              ? " · " + overview.unpriced_asset_count + " unpriced"
              : ""}
          </summary>
          {trading && (
            <p className="holdings-trading-note">
              Trading history is partial. P&amp;L is an indexed average-cost estimate and does not account for all opening balances, transfers or fees.
              {" "}Buy/sell USD totals include priced indexed fills; counts include all indexed trades. Missing trading details are not zero.
            </p>
          )}
          <p>
            Native SOL, wrapped SOL, and token observations may have independent
            source clocks. Unpriced quantities are retained; unknown value is
            not zero.
          </p>
          {receiptCount > 0 && (
            <p>
              {receiptCount === 1
                ? "1 LP position receipt overlaps protocol positions and has no price or value here."
                : receiptCount +
                  " LP position receipts overlap protocol positions and have no price or value here."}
            </p>
          )}
          <p>
            Snapshot status:{" "}
            {overview.coverage.snapshot_status.replaceAll("_", " ")}. Token
            slot: {overview.coverage.token_snapshot_slot ?? "Unknown"}.
          </p>
        </details>
      </div>
    </section>
  );
}
function HoldingRow({
  row,
  open,
  toggle,
  showProtocol,
  trading,
}: {
  row: Row;
  open: boolean;
  toggle: () => void;
  showProtocol?: ShowProtocol;
  trading?: HoldingsTradingDetails;
}) {
  // An LP receipt overlaps a protocol position; its NFT mint never
  // carries per-token trading results here.
  const position = row.mint && !row.receipt ? trading?.positions.get(row.mint) : undefined;
  const pnl = position ? indexedPnl(position) : null;
  const unavailable = row.id === "native-sol"
    ? "Native SOL has no per-token trading position in this feed."
    : row.receipt
      ? "LP position receipts have no per-token trading position here."
      : "Trading details are unavailable for this mint in the loaded indexed history.";
  const fullBalance = row.amount == null ? "Unknown balance" : row.amount + " " + row.symbol;
  return (
    <>
      <tr className="data-row">
        <td>
          <button
            className="row-expander"
            aria-label={"Inspect " + row.symbol + " holding"}
            aria-expanded={open}
            onClick={toggle}
          >
            <AssetIcon row={row} />
            <span className="asset stack">
              <strong>{row.symbol}</strong>
              <small>{row.name}</small>
              <span className="holding-balance-mobile numeric" title={fullBalance}>
                Balance {formatCompactAmount(row.amount)}
              </span>
            </span>
            <ChevronDown size={12} className="expand-icon" />
          </button>
        </td>
        <td className="right hide-mobile numeric muted">
          {formatPrice(row.price)}
        </td>
        <td className="right hide-mobile numeric">
          <span title={fullBalance}>{formatCompactAmount(row.amount)}</span>
        </td>
        <td className="right hide-mobile numeric" title={pnl?.unavailableReason ?? (!position ? unavailable : undefined)}>
          <span className={pnlTone(pnl?.total)}>{formatSignedUsd(pnl?.total)}</span>
        </td>
        <td className="right numeric">
          {row.value == null && row.estimate != null ? (
            <span className="muted">
              {formatUsd(row.estimate)}{" "}
              <span className="badge">estimate</span>
            </span>
          ) : (
            <span className={row.value == null ? "muted" : "holdings-value"}>
              {formatUsd(row.value)}
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={5}>
            <dl className="detail-grid">
              <div>
                <dt>Token / address</dt>
                <dd className="mono break">
                  {row.mint ? (
                    <a
                      href={explorerHref("token", row.mint)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.mint}
                    </a>
                  ) : (
                    "Native SOL"
                  )}
                </dd>
              </div>
              <div>
                <dt>Balance</dt>
                <dd>
                  {row.amount ?? "Unknown"} {row.symbol}
                </dd>
              </div>
              <div>
                <dt>Raw atoms</dt>
                <dd className="mono">{row.raw}</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>{formatPrice(row.price)}</dd>
              </div>
              <div>
                <dt>Balance observation slot</dt>
                <dd className="numeric">
                  {row.balanceSlot ?? "Unknown"}
                </dd>
              </div>
              <div>
                <dt>Price observation</dt>
                <dd>
                  {row.priceAt
                    ? new Date(row.priceAt).toLocaleString()
                    : "Unknown"}
                </dd>
              </div>
              <div>
                <dt>Token accounts</dt>
                <dd>{row.accountCount ?? "Native balance"}</dd>
              </div>
              {row.receipt && (
                <ReceiptDetail
                  receipt={row.receipt}
                  showProtocol={showProtocol}
                />
              )}
              {position ? (
                <>
                  <div>
                    <dt>Indexed total P&amp;L estimate</dt>
                    <dd className={pnlTone(pnl?.total)}>{formatSignedUsd(pnl?.total)}</dd>
                  </div>
                  <div>
                    <dt>Indexed realized P&amp;L estimate</dt>
                    <dd className={pnlTone(pnl?.realized)}>{formatSignedUsd(pnl?.realized)}</dd>
                  </div>
                  <div>
                    <dt>Indexed unrealized P&amp;L estimate</dt>
                    <dd className={pnlTone(pnl?.unrealized)}>{formatSignedUsd(pnl?.unrealized)}</dd>
                  </div>
                  <div>
                    <dt>Average indexed buy price</dt>
                    <dd>{formatPrice(position.avg_buy_price_usd)}</dd>
                  </div>
                  <div>
                    <dt>Average indexed sell price</dt>
                    <dd>{formatPrice(position.avg_sell_price_usd)}</dd>
                  </div>
                  <div>
                    <dt>Recorded buys</dt>
                    <dd><TradeTotal total={position.bought} side="buy" /></dd>
                  </div>
                  <div>
                    <dt>Recorded sells</dt>
                    <dd><TradeTotal total={position.sold} side="sell" /></dd>
                  </div>
                  <div>
                    <dt>Recorded tokens bought</dt>
                    <dd>{position.bought.amount ?? "Unknown"} {row.symbol}</dd>
                  </div>
                  <div>
                    <dt>Recorded tokens sold</dt>
                    <dd>{position.sold.amount ?? "Unknown"} {row.symbol}</dd>
                  </div>
                  <div>
                    <dt>First indexed trade</dt>
                    <dd>{new Date(position.first_trade_at).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Last indexed trade</dt>
                    <dd>{new Date(position.last_trade_at).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Unpriced indexed trades</dt>
                    <dd>{position.unpriced_trades.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>P&amp;L estimate basis</dt>
                    <dd>{pnl?.unavailableReason ?? "Indexed average cost with partial history; opening balances, transfers and fees are not fully accounted for."}</dd>
                  </div>
                </>
              ) : trading ? (
                <div>
                  <dt>Trading details</dt>
                  <dd>{unavailable}</dd>
                </div>
              ) : null}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}
function ReceiptDetail({
  receipt,
  showProtocol,
}: {
  receipt: Receipt;
  showProtocol?: ShowProtocol;
}) {
  const { resource } = receipt;
  const unidentified = receipt.position === null || receipt.pool === null;
  const metadata = [receipt.tokenSymbol, receipt.tokenName]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <div>
        <dt>Protocol position</dt>
        <dd>
          {resource && showProtocol ? (
            <a
              href={"#protocol-" + resource}
              onClick={(event) => {
                event.preventDefault();
                showProtocol(resource);
              }}
            >
              {receipt.label}
            </a>
          ) : (
            receipt.label
          )}
        </dd>
      </div>
      <div>
        <dt>Position account</dt>
        <dd className="mono break">{receipt.position ?? "Not reported"}</dd>
      </div>
      <div>
        <dt>Pool</dt>
        <dd className="mono break">{receipt.pool ?? "Not reported"}</dd>
      </div>
      <div>
        <dt>Receipt reference</dt>
        <dd>
          This NFT is a receipt for an LP position and overlaps protocol
          positions. It has no price or value of its own here.
          {resource
            ? " Look for this position in the " +
              receipt.label +
              " protocol section; that section reports its own coverage."
            : " Doxxd has no protocol view for this receipt, so its position is not shown."}
          {unidentified &&
            " The source does not identify a single position when the wallet’s position scan is disabled or has not had a first completed position scan, or when one NFT backs several positions."}
        </dd>
      </div>
      {metadata && (
        <div>
          <dt>Token metadata</dt>
          <dd>{metadata} (creator-supplied, not verified)</dd>
        </div>
      )}
    </>
  );
}
