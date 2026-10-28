"use client";
import type { Schemas } from "@/lib/dmnd/contracts";
import { formatAmount, atomsToUi } from "@/lib/decimal";
import { short, mintName } from "@/lib/portfolio/adapters/shared";
import { explorerHref } from "@/lib/safe-url";
import { CopyButton } from "../copy-button";
export function ChangeAmount({
  row,
  labels = {},
}: {
  row: Schemas["WalletActivityEntry"];
  labels?: Record<string, string>;
}) {
  const amount = row.ui_amount ?? row.delta;
  const negative = amount.startsWith("-");
  const label = row.mint
    ? (labels[row.mint] ?? mintName(row.mint))
    : row.kind === "native_sol_balance_change"
      ? "SOL"
      : "Unknown asset";
  return (
    <span className={negative ? "negative" : "positive"}>
      {!negative && amount !== "0" ? "+" : ""}
      {formatAmount(amount)}{" "}
      <span className="muted">
        {label}
        {row.ui_amount == null ? " raw atoms" : ""}
      </span>
    </span>
  );
}
export function TransactionDetail({
  row,
  labels,
  neutral = false,
}: {
  row: Schemas["WalletTransaction"];
  labels: Record<string, string>;
  neutral?: boolean;
}) {
  return (
    <div className="tx-detail">
      <div>
        <h4>Transaction</h4>
        <p className="mono">
          <a
            href={explorerHref("tx", row.signature)}
            target="_blank"
            rel="noreferrer"
          >
            {row.signature}
          </a>
          <CopyButton
            value={row.signature}
            label="Copy transaction signature"
          />
        </p>
        <p className="faint">
          Slot {row.slot} · {new Date(row.block_time).toISOString()}
        </p>
        <dl className="detail-grid">
          <div>
            <dt>Transaction index</dt>
            <dd>{row.transaction_index}</dd>
          </div>
        </dl>
        <h4>Observed net balance changes</h4>
        {row.changes.length ? (
          row.changes.map((change, i) => (
            <div key={i}>
              <p>
                <ChangeAmount row={change} labels={labels} />
              </p>
              <dl className="detail-grid">
                <div>
                  <dt>Observation kind</dt>
                  <dd className="mono">{change.kind}</dd>
                </div>
                <div>
                  <dt>Raw delta (atoms)</dt>
                  <dd className="mono">{change.delta}</dd>
                </div>
                <div>
                  <dt>Decimals</dt>
                  <dd>{change.decimals ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Source unit amount</dt>
                  <dd className="mono">{change.ui_amount ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Mint</dt>
                  <dd className="mono">
                    {change.mint ??
                      (change.kind === "native_sol_balance_change"
                        ? "Native SOL (no mint)"
                        : "Unknown")}
                  </dd>
                </div>
              </dl>
            </div>
          ))
        ) : (
          <p className="muted">No net changes are included in this response.</p>
        )}
        {row.changes_truncated && (
          <p className="badge partial">
            Additional balance changes may be outside this page.
          </p>
        )}
        <h4>Network fee / outcome</h4>
        <p>
          {row.fee
            ? formatAmount(atomsToUi(row.fee.lamports, 9), 9) +
              " SOL · " +
              (row.fee.succeeded ? "Succeeded" : "Failed")
            : "Unknown — fee evidence was not supplied for this wallet."}
        </p>
      </div>
      <div>
        {neutral ? (
          <>
            <h4>Balance-change feed</h4>
            <p className="muted">
              This source supplies observed balance changes. It does not
              classify protocol actions or provide fee and transfer evidence.
            </p>
          </>
        ) : (
          <>
            <h4>Indexed executions</h4>
            {row.observed_trades.length ? (
              row.observed_trades.map((trade, i) => (
                <p key={i}>
                  {trade.exchange.replaceAll("_", " ")} · {trade.side}{" "}
                  {formatAmount(trade.amount_tokens)}{" "}
                  {labels[trade.mint] ?? mintName(trade.mint)}
                  <br />
                  <span className="muted">
                    Quote: {formatAmount(trade.quote_amount)}{" "}
                    {labels[trade.quote_mint] ?? mintName(trade.quote_mint)}
                  </span>
                </p>
              ))
            ) : (
              <p className="muted">
                No matching executions are included in this response.
              </p>
            )}
            {row.trades_truncated && (
              <p className="badge partial">
                More executions were observed than are included here.
              </p>
            )}
            <p className="faint">
              Execution attribution varies by protocol. A fee-payer association
              does not prove ownership of the swapped assets.
            </p>
            <h4>Explicit transfers</h4>
            {row.observed_transfers.length ? (
              row.observed_transfers.map((transfer, i) => (
                <p key={i}>
                  {transfer.direction} ·{" "}
                  {transfer.kind === "native_sol"
                    ? formatAmount(atomsToUi(transfer.amount_atoms, 9), 9) +
                      " SOL"
                    : formatAmount(transfer.amount_atoms) + " raw atoms"}
                  <br />
                  {transfer.mint && (
                    <>
                      <span>
                        {labels[transfer.mint] ?? mintName(transfer.mint)}
                      </span>
                      <br />
                      <a
                        className="mono faint"
                        href={explorerHref("address", transfer.mint)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {transfer.mint}
                      </a>
                      <br />
                    </>
                  )}
                  <span className="mono faint">
                    {short(transfer.source_account)} →{" "}
                    {short(transfer.destination_account)}
                  </span>
                </p>
              ))
            ) : (
              <p className="muted">
                No matching transfers are included in this response.
              </p>
            )}
            {row.transfers_truncated && (
              <p className="badge partial">
                Additional transfers were observed but are not included.
              </p>
            )}
            <p className="faint">
              Transfer amounts are instructed quantities. Net SOL changes can
              also contain rent, fees, or tips.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
