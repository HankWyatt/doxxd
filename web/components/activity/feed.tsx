"use client";
import { Fragment, useState } from "react";
import {
  Activity as ActivityIcon,
  ArrowLeftRight,
  ChevronDown,
  ArrowUpRight,
} from "lucide-react";
import { WalletFrame } from "../wallet/frame";
import { ResourceState, LoadingRows } from "../resource-state";
import { useWalletResource } from "@/lib/use-wallet-resource";
import {
  LIVE_MODE,
  type WalletDataMode,
  type Schemas,
  type ResourceData,
} from "@/lib/dmnd/contracts";
import { toTransactionView } from "@/lib/activity/model";
import { activityHref, type ActivityWindow } from "@/lib/activity/window";
import { short } from "@/lib/portfolio/adapters/shared";
import { explorerHref } from "@/lib/safe-url";
import { DateFilter } from "./date-filter";
import { TransactionDetail, ChangeAmount } from "./transaction-detail";
type Props = {
  address: string;
  window?: ActivityWindow;
  cursor?: string;
  mode?: WalletDataMode;
  source?: "transactions" | "activity";
};
export function Activity({
  address,
  window = {},
  cursor,
  mode = LIVE_MODE,
  source = "transactions",
}: Props) {
  return (
    <WalletFrame address={address} tab="activity" mode={mode}>
      {source === "activity" ? (
        <BalanceFeed
          address={address}
          window={window}
          cursor={cursor}
          mode={mode}
        />
      ) : (
        <GroupedFeed
          address={address}
          window={window}
          cursor={cursor}
          mode={mode}
        />
      )}
    </WalletFrame>
  );
}
type FeedProps = {
  address: string;
  window: ActivityWindow;
  cursor?: string;
  mode: WalletDataMode;
};
function GroupedFeed(props: FeedProps) {
  const request = useWalletResource(
    props.address,
    "transactions",
    {
      ...props.window,
      ...(props.cursor ? { cursor: props.cursor } : {}),
      limit: 25,
    },
    props.mode,
  );
  if (
    request.result &&
    !request.result.ok &&
    request.result.kind === "unsupported"
  )
    return <BalanceFeed {...props} cursor={undefined} />;
  return <FeedBody {...props} source="transactions" request={request} />;
}
function BalanceFeed(props: FeedProps) {
  const request = useWalletResource(
    props.address,
    "activity",
    {
      ...props.window,
      ...(props.cursor ? { cursor: props.cursor } : {}),
      limit: 50,
    },
    props.mode,
  );
  return <FeedBody {...props} source="activity" request={request} />;
}
function neutralCards(
  data: ResourceData["activity"],
): Schemas["WalletTransaction"][] {
  const cards = new Map<string, Schemas["WalletTransaction"]>();
  for (const row of data.data) {
    const key = row.signature + ":" + row.slot + ":" + row.transaction_index;
    let card = cards.get(key);
    if (!card) {
      card = {
        signature: row.signature,
        slot: row.slot,
        transaction_index: row.transaction_index,
        block_time: row.block_time,
        fee: null,
        change_count: 0,
        changes_truncated: data.has_more,
        changes: [],
        trade_count: 0,
        trades_truncated: false,
        observed_trades: [],
        transfer_count: 0,
        transfers_truncated: false,
        observed_transfers: [],
      };
      cards.set(key, card);
    }
    card.changes.push(row);
    card.change_count++;
  }
  return [...cards.values()];
}
function FeedBody({
  address,
  window,
  cursor,
  mode,
  source,
  request,
}: {
  address: string;
  window: ActivityWindow;
  cursor?: string;
  mode: WalletDataMode;
  source: "transactions" | "activity";
  request: ReturnType<typeof useWalletResource<"transactions" | "activity">>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const overview = useWalletResource(address, "overview", {}, mode);
  const labels: Record<string, string> = {};
  if (overview.result?.ok)
    for (const asset of overview.result.data.assets)
      if (asset.symbol) labels[asset.mint] = asset.symbol;
  const header = (
    <div className="activity-toolbar">
      <h2 className="inline">
        <ActivityIcon size={16} />
        {source === "activity" ? "Balance-change feed" : "Wallet activity"}
      </h2>
      <DateFilter
        key={JSON.stringify(window)}
        address={address}
        window={window}
        mode={mode}
        source={source}
      />
    </div>
  );
  if (!request.result)
    return (
      <>
        {header}
        <div className="panel">
          <LoadingRows />
        </div>
      </>
    );
  if (!request.result.ok)
    return (
      <>
        {header}
        <div className="panel">
          <ResourceState error={request.result} retry={request.refresh} />
          {cursor && (
            <div className="paging">
              <a
                href={activityHref(address, window, undefined, mode, source)}
              >
                Newest activity
              </a>
            </div>
          )}
        </div>
      </>
    );
  const data = request.result.data;
  const rows =
    source === "activity"
      ? neutralCards(data as ResourceData["activity"])
      : (data as ResourceData["transactions"]).data;
  const unique = [
    ...new Map(
      rows.map((row) => [
        row.signature + ":" + row.slot + ":" + row.transaction_index,
        row,
      ]),
    ).values(),
  ];
  const coverage = data.coverage;
  const fullCapture =
    coverage.complete_since_slot && coverage.native_sol_complete_since_slot;
  const hasMore = data.has_more;
  const usableCursor =
    typeof data.cursor === "string" && data.cursor.trim().length > 0
      ? data.cursor
      : null;
  const continuationUnavailable = hasMore && !usableCursor;
  const pageScopedEmpty = continuationUnavailable || !!cursor;
  const next = hasMore && usableCursor
    ? activityHref(address, window, usableCursor, mode, source)
    : "";
  return (
    <>
      {header}
      <div className="panel">
        {unique.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th className="hide-mobile">Time (UTC)</th>
                  <th className="right">Net changes</th>
                  <th className="right hide-mobile">Explorer</th>
                </tr>
              </thead>
              <tbody>
                {unique.map((row) => {
                  const view = toTransactionView(row);
                  const key =
                    row.signature +
                    ":" +
                    row.slot +
                    ":" +
                    row.transaction_index;
                  return (
                    <Fragment key={key}>
                      <tr className="data-row">
                        <td>
                          <button
                            className="row-expander"
                            aria-label={
                              "Inspect transaction " + short(row.signature)
                            }
                            aria-expanded={expanded === key}
                            onClick={() =>
                              setExpanded(expanded === key ? null : key)
                            }
                          >
                            <span className="tx-icon">
                              <ArrowLeftRight size={14} />
                            </span>
                            <span className="transaction-main">
                              <strong>{view.label}</strong>
                              <span className="mono faint">
                                {short(row.signature)}
                              </span>
                            </span>
                            <ChevronDown className="expand-icon" size={12} />
                          </button>
                        </td>
                        <td className="hide-mobile small muted">
                          <time
                            dateTime={row.block_time}
                            title={row.block_time}
                          >
                            {new Date(row.block_time).toLocaleString("en-US", {
                              timeZone: "UTC",
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: false,
                            })}
                          </time>
                        </td>
                        <td className="right tx-amount numeric">
                          {row.changes.length ? (
                            row.changes.slice(0, 2).map((change, i) => (
                              <div key={i}>
                                <ChangeAmount row={change} labels={labels} />
                              </div>
                            ))
                          ) : (
                            <span className="faint">Not supplied</span>
                          )}
                          {row.changes.length > 2 && (
                            <span className="faint small">
                              +{row.changes.length - 2} more
                            </span>
                          )}
                        </td>
                        <td className="right hide-mobile">
                          <a
                            className="icon-button"
                            href={explorerHref("tx", row.signature)}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="View transaction on Solana Explorer"
                          >
                            <ArrowUpRight size={13} />
                          </a>
                        </td>
                      </tr>
                      {expanded === key && (
                        <tr className="detail-row">
                          <td colSpan={4}>
                            <TransactionDetail
                              row={row}
                              labels={labels}
                              neutral={source === "activity"}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <strong>
              {pageScopedEmpty
                ? "No matches on this page"
                : hasMore
                  ? "Another page is available"
                  : fullCapture
                  ? "No observed transactions in this window"
                  : "No indexed activity is available yet"}
            </strong>
            {continuationUnavailable
              ? "The source reports more observed history, so this page does not establish an empty activity window."
              : hasMore
                ? "This page has no matches. Continue to the next page of the observed history."
                : cursor
                  ? "This page has no matches. Earlier pages may contain observed activity."
                  : "Earlier or unindexed activity may still be missing."}
          </div>
        )}
        <details className="coverage-note">
          <summary>
            <span className={"badge " + (fullCapture ? "" : "partial")}>
              {fullCapture ? "Observed capture window" : "Partial history"}
            </span>
            <span style={{ marginLeft: 10 }}>About this activity</span>
          </summary>
          <p>
            Token and native SOL history have independent capture windows.
            Earlier history may be unavailable, and missing rows do not prove a
            transaction did not happen.
          </p>
          <dl className="detail-grid">
            <div>
              <dt>Token capture start slot</dt>
              <dd>{coverage.since_slot ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Token capture complete since start</dt>
              <dd>{coverage.complete_since_slot ? "Complete" : "Incomplete"}</dd>
            </div>
            <div>
              <dt>Token capture reason</dt>
              <dd className="mono">{coverage.reason}</dd>
            </div>
            <div>
              <dt>Native SOL capture start slot</dt>
              <dd>{coverage.native_sol_since_slot ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Native SOL capture complete since start</dt>
              <dd>
                {coverage.native_sol_complete_since_slot ? "Complete" : "Incomplete"}
              </dd>
            </div>
            <div>
              <dt>Native SOL capture reason</dt>
              <dd className="mono">{coverage.native_sol_reason}</dd>
            </div>
            <div>
              <dt>First unindexed slot</dt>
              <dd>{coverage.first_unindexed_slot ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Latest observed slot</dt>
              <dd>{coverage.live_slot ?? "Unknown"}</dd>
            </div>
          </dl>
          {source === "transactions" && (
            <p>
              Transfers and ownership attribution have separate coverage. Net
              balance changes are not classified staking or DeFi actions.
            </p>
          )}
        </details>
        {continuationUnavailable && (
          <p
            className="coverage-note"
            role="status"
            aria-label="Activity continuation"
          >
            Continuation unavailable. The source reports more activity, but did
            not provide a usable cursor.
          </p>
        )}
        {(hasMore || cursor) && (
          <div className="paging">
            <a
              href={activityHref(address, window, undefined, mode, source)}
            >
              Newest activity
            </a>
            {next && <a href={next}>Load more →</a>}
            {continuationUnavailable && (
              <button
                type="button"
                className="button"
                onClick={request.refresh}
                disabled={request.loading}
              >
                Retry activity page
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
