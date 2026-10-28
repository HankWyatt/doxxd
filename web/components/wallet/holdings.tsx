"use client";
import { Fragment, useRef, useState } from "react";
import { ChevronDown, Wallet } from "lucide-react";
import type { ProtocolResource, Schemas } from "@/lib/dmnd/contracts";
import { protocolResources, resources } from "@/lib/dmnd/resources";
import {
  formatAmount,
  formatUsd,
  formatPrice,
  compareDecimalDesc,
  atomsToUi,
} from "@/lib/decimal";
import { tokenImageUrl, explorerHref } from "@/lib/safe-url";
import { short } from "@/lib/portfolio/adapters/shared";
const PAGE_SIZE = 20;
type Row = {
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
  metadata: string | null;
};
// An LP position NFT is a receipt for a protocol position: it is never valued
// here, and its token metadata is creator-supplied rather than a trust signal.
function positionReceipt(asset: Schemas["WalletAsset"]): Receipt | null {
  if (!asset.position) return null;
  const { protocol } = asset.position;
  const resource = protocolResources.find(
    (r) => resources[r].componentId === protocol,
  );
  const metadata = [asset.symbol, asset.name]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(" · ");
  return {
    label: resource ? resources[resource].label : protocol.replaceAll("_", " "),
    resource,
    position: asset.position.position ?? null,
    pool: asset.position.pool ?? null,
    metadata: metadata || null,
  };
}
function AssetIcon({ row }: { row: Row }) {
  const [failed, setFailed] = useState(false);
  const image = tokenImageUrl(row.image);
  return (
    <span className="asset-icon">
      {image && !failed ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        row.symbol.slice(0, 2)
      )}
    </span>
  );
}
export function Holdings({
  overview,
}: {
  overview: Schemas["WalletOverview"];
}) {
  return <HoldingsTable key={overview.wallet} overview={overview} />;
}
function HoldingsTable({ overview }: { overview: Schemas["WalletOverview"] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
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
  rows.sort((a, b) => compareDecimalDesc(a.value, b.value));
  const search = query.trim().toLowerCase();
  const matches = search
    ? rows.filter((row) =>
        [row.symbol, row.name, row.mint, row.id].some((value) =>
          value?.toLowerCase().includes(search),
        ),
      )
    : rows;
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  // Adjust during render so refreshed data never commits an out-of-range page.
  if (page !== currentPage) {
    setPage(currentPage);
    setOpen(null);
  }
  const start = currentPage * PAGE_SIZE;
  const visibleRows = matches.slice(start, start + PAGE_SIZE);
  function changeQuery(value: string) {
    setQuery(value);
    setPage(0);
    setOpen(null);
  }
  function changePage(value: number) {
    setPage(value);
    setOpen(null);
  }
  return (
    <section id="holdings">
      <div className="section-heading">
        <h2>
          <Wallet size={16} />
          Wallet holdings <span className="count">{rows.length}</span>
        </h2>
        <span className="small numeric muted">
          {formatUsd(overview.known_value_usd)}{" "}
          <span className="faint">known</span>
        </span>
      </div>
      <div className="panel">
        {rows.length > 0 && (
          <div className="holdings-search">
            <label>
              <span>Search observed holdings</span>
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
                Clear search
              </button>
            )}
          </div>
        )}
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
        ) : matches.length === 0 ? (
          <div className="empty-state">No observed holdings match this search.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="token-col">Asset</th>
                  <th className="right hide-mobile price-col">Price</th>
                  <th className="right hide-mobile amount-col">Balance</th>
                  <th className="right">Value</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <Fragment key={row.id}>
                    <tr className="data-row">
                      <td>
                        <button
                          className="row-expander"
                          aria-label={"Inspect " + row.symbol + " holding"}
                          aria-expanded={open === row.id}
                          onClick={() =>
                            setOpen(open === row.id ? null : row.id)
                          }
                        >
                          <AssetIcon row={row} />
                          <span className="asset stack">
                            <strong>{row.symbol}</strong>
                            <small>{row.name}</small>
                          </span>
                          <ChevronDown size={12} className="expand-icon" />
                        </button>
                      </td>
                      <td className="right hide-mobile numeric muted">
                        {formatPrice(row.price)}
                      </td>
                      <td className="right hide-mobile numeric">
                        {formatAmount(row.amount)}
                      </td>
                      <td className="right numeric">
                        {row.value == null && row.estimate != null ? (
                          <span className="muted">
                            {formatUsd(row.estimate)}{" "}
                            <span className="badge">estimate</span>
                          </span>
                        ) : (
                          formatUsd(row.value)
                        )}
                      </td>
                    </tr>
                    {open === row.id && (
                      <tr className="detail-row">
                        <td colSpan={4}>
                          <dl className="detail-grid">
                            <div>
                              <dt>Token / address</dt>
                              <dd className="mono break">
                                {row.mint ? (
                                  <a
                                    href={explorerHref("address", row.mint)}
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
                            {row.receipt && <ReceiptDetail receipt={row.receipt} />}
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 && (
          <nav className="paging holdings-paging" aria-label="Holdings pages">
            <span role="status">
              Showing {matches.length ? start + 1 : 0}
              {matches.length > 0 && "–" + (start + visibleRows.length)} of{" "}
              {matches.length}{" "}
              {search
                ? "matching observed holdings (" + rows.length + " observed holdings total)"
                : "observed holdings"}
            </span>
            <div className="holdings-page-buttons">
              <button
                type="button"
                className="button"
                aria-label="Previous holdings"
                disabled={currentPage === 0}
                onClick={() => changePage(currentPage - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="button"
                aria-label="Next holdings"
                disabled={currentPage === lastPage}
                onClick={() => changePage(currentPage + 1)}
              >
                Next
              </button>
            </div>
          </nav>
        )}
        <details className="coverage-note">
          <summary>
            {overview.coverage.complete
              ? "Token snapshot observed"
              : "Token coverage is incomplete"}
            {overview.unpriced_asset_count > 0
              ? " · " + overview.unpriced_asset_count + " unpriced"
              : ""}
          </summary>
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
function ReceiptDetail({ receipt }: { receipt: Receipt }) {
  const unidentified = receipt.position === null || receipt.pool === null;
  return (
    <>
      <div>
        <dt>Protocol position</dt>
        <dd>
          {receipt.resource ? (
            <a href={"#protocol-" + receipt.resource}>{receipt.label}</a>
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
          positions. It has no price or value of its own; the position&apos;s
          principal is reported in its protocol section.
          {unidentified &&
            " The source does not identify a single position before the wallet’s first completed position scan, or when one NFT backs several positions."}
        </dd>
      </div>
      {receipt.metadata && (
        <div>
          <dt>Token metadata</dt>
          <dd>{receipt.metadata} (creator-supplied, not verified)</dd>
        </div>
      )}
    </>
  );
}
