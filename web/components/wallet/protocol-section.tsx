"use client";
import { Fragment, useState } from "react";
import { ChevronDown, ChevronUp, Layers3 } from "lucide-react";
import type {
  ProtocolResource,
  ResourceData,
  WalletDataMode,
  Schemas,
} from "@/lib/dmnd/contracts";
import { resources } from "@/lib/dmnd/resources";
import { useWalletResource } from "@/lib/use-wallet-resource";
import {
  toProtocolView,
  type ProtocolPayload,
  type ProtocolView,
} from "@/lib/portfolio/model";
import { formatUsd } from "@/lib/decimal";
import { short } from "@/lib/portfolio/adapters/shared";
import { ResourceState, LoadingRows } from "../resource-state";
import { Amounts, PositionDetail } from "./position-detail";
import { RecoveryNotice } from "./recovery-notice";
export function ProtocolSection({
  address,
  resource,
  mode,
  component,
  labels,
}: {
  address: string;
  resource: ProtocolResource;
  mode: WalletDataMode;
  component?: Schemas["WalletPortfolioComponent"];
  labels: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const definition = resources[resource];
  return (
    <section className="panel" id={"protocol-" + resource}>
      <button
        type="button"
        className="protocol-toggle"
        aria-expanded={open}
        aria-label={(open ? "Collapse " : "Expand ") + definition.label}
        onClick={() => setOpen(!open)}
      >
        <span className="protocol-icon">{definition.label.slice(0, 2)}</span>
        <span>
          <h3>{definition.label}</h3>
          <span className="faint" style={{ fontSize: 10 }}>
            {resource === "liquid-staking"
              ? "Receipt references · overlaps holdings"
              : resource === "stake"
                ? "Native stake accounts"
                : resource.includes("raydium") ||
                    ["orca", "meteora", "meteora-damm-v2"].includes(resource)
                  ? "Liquidity positions"
                  : resource === "drift" || resource === "velocity"
                    ? "Trading accounts"
                    : "Deposits & borrowing"}
          </span>
        </span>
        {component && !component.coverage_complete && (
          <span className="badge partial hide-mobile">Partial</span>
        )}
        <span className="protocol-value">
          {formatUsd(component?.known_net_value_usd)}
        </span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="protocol-open">
          <ProtocolBody
            address={address}
            resource={resource}
            mode={mode}
            labels={labels}
          />
        </div>
      )}
    </section>
  );
}
function ProtocolBody({
  address,
  resource,
  mode,
  labels,
}: {
  address: string;
  resource: ProtocolResource;
  mode: WalletDataMode;
  labels: Record<string, string>;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const request = useWalletResource(
    address,
    resource,
    resource === "liquid-staking"
      ? {}
      : { limit: 50, ...(cursor ? { cursor } : {}) },
    mode,
  );
  if (!request.result) return <LoadingRows />;
  if (!request.result.ok)
    return (
      <>
        <RecoveryNotice state={request.recovery} retained={Boolean(request.refreshError)} retry={request.refresh} />
        <ResourceState error={request.result} retry={request.refresh} />
        {cursor && (
          <div className="paging">
            <span>Start a fresh position page.</span>
            <button
              className="button"
              onClick={() => {
                setCursor(undefined);
                setExpanded(null);
              }}
            >
              First page
            </button>
          </div>
        )}
      </>
    );
  let view: ProtocolView;
  try {
    view = toProtocolView(
      { resource, data: request.result.data } as ProtocolPayload,
      { isContinuation: Boolean(cursor) },
    );
  } catch {
    return (
      <ResourceState
        error={{ ok: false, kind: "upstream" }}
        retry={request.refresh}
      />
    );
  }
  return (
    <>
      <RecoveryNotice state={request.recovery} retained={Boolean(request.refreshError)} retry={request.refresh} />
      {view.positions.length > 0 ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th className="hide-mobile">Assets / principal</th>
                <th className="hide-mobile">Debt</th>
                <th className="right">Value</th>
              </tr>
            </thead>
            <tbody>
              {view.positions.map((row) => (
                <Fragment key={row.id}>
                  <tr className="data-row">
                    <td>
                      <button
                        className="row-expander"
                        aria-expanded={expanded === row.id}
                        onClick={() =>
                          setExpanded(expanded === row.id ? null : row.id)
                        }
                      >
                        <Layers3 size={15} className="faint" />
                        <span className="stack">
                          <strong>{row.label}</strong>
                          <span className="mono faint">{short(row.id)}</span>
                        </span>
                        <ChevronDown size={12} className="expand-icon" />
                      </button>
                    </td>
                    <td className="hide-mobile">
                      <Amounts values={row.assets} labels={labels} />
                    </td>
                    <td className="hide-mobile">
                      <Amounts values={row.debts} labels={labels} />
                    </td>
                    <td className="right numeric">{formatUsd(row.valueUsd)}</td>
                  </tr>
                  {expanded === row.id && (
                    <tr className="detail-row">
                      <td colSpan={4}>
                        <PositionDetail position={row} labels={labels} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <strong>
            {view.coverage.state === "ready"
              ? "No positions on this page"
              : view.coverage.label}
          </strong>
          {view.coverage.state === "empty"
            ? "No positions were found in this supported scope."
            : view.coverage.state === "ready"
              ? "An empty page does not establish an empty supported scope."
              : view.coverage.detail}
        </div>
      )}
      <details className="coverage-note">
        <summary>
          <span className={"badge " + view.coverage.state}>
            {view.coverage.label}
          </span>
          {view.pageValueUsd !== null && (
            <span className="numeric" style={{ marginLeft: 10 }}>
              This page: {formatUsd(view.pageValueUsd)}
            </span>
          )}
        </summary>
        <p>{view.coverage.detail}</p>
        {view.totalPositions !== null && (
          <p>Source snapshot positions: {view.totalPositions}.</p>
        )}
        {view.coverage.observedAt && (
          <p>Observed {new Date(view.coverage.observedAt).toLocaleString()}.</p>
        )}
        {view.coverage.snapshotSlot != null && (
          <p>Source slot: {view.coverage.snapshotSlot}.</p>
        )}
        {view.coverageClocks.length > 0 && (
          <dl className="detail-grid">
            {view.coverageClocks.map((clock) => (
              <div key={clock.label}>
                <dt>{clock.label}</dt>
                <dd>{clock.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </details>
      {(view.hasMore || cursor) && (
        <div className="paging">
          <span>
            {view.continuationUnavailable
              ? "More positions are reported, but the continuation cursor is unavailable."
              : "Position pages preserve the source snapshot."}
          </span>
          <span className="inline">
            {view.continuationUnavailable && (
              <button
                className="button"
                disabled={request.loading}
                onClick={request.refresh}
              >
                Retry positions page
              </button>
            )}
            {cursor && (
              <button
                className="button"
                onClick={() => {
                  setCursor(undefined);
                  setExpanded(null);
                }}
              >
                First page
              </button>
            )}
            {view.hasMore && !view.continuationUnavailable && view.cursor && (
              <button
                className="button"
                onClick={() => {
                  setCursor(view.cursor!);
                  setExpanded(null);
                }}
              >
                Next positions
              </button>
            )}
          </span>
        </div>
      )}
    </>
  );
}
