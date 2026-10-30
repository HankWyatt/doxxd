"use client";
import { UnknownValue, orUnknown } from "@/components/unknown-value";
import type { PositionView, AmountView } from "@/lib/portfolio/model";
import { formatAmount, formatUsd } from "@/lib/decimal";
import { LegIcon, legName } from "./token-meta";
export function Amounts({
  values,
  labels = {},
  showSources = false,
}: {
  values: AmountView[];
  labels?: Record<string, string>;
  showSources?: boolean;
}) {
  if (!values.length) return <UnknownValue />;
  return (
    <div className="stack">
      {values.map((a, i) => (
        <div key={i}>
          <span className="numeric">{orUnknown(formatAmount(a.amount))}</span>{" "}
          <LegIcon leg={a} name={legName(a, labels)} />
          <span className="muted" title={a.mint}>
            {legName(a, labels)}
          </span>
          {a.qualifier && <span className="faint small"> · {a.qualifier}</span>}
          {showSources && a.sourceDetails && (
            <dl className="small faint">
              {a.sourceDetails.map((d, j) => (
                <div key={j}>
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}
export function PositionDetail({
  position,
  labels,
}: {
  position: PositionView;
  labels?: Record<string, string>;
}) {
  return (
    <>
      <dl className="detail-grid">
        <div>
          <dt>Supplied assets / principal</dt>
          <dd>
            <Amounts values={position.assets} labels={labels} showSources />
          </dd>
        </div>
        <div>
          <dt>Debt</dt>
          <dd>
            <Amounts values={position.debts} labels={labels} showSources />
          </dd>
        </div>
        <div>
          <dt>Rewards / fees</dt>
          <dd>
            <Amounts values={position.rewards} labels={labels} showSources />
          </dd>
        </div>
        {position.details.map((d, i) => (
          <div key={i}>
            <dt>{d.label}</dt>
            <dd>{d.value}</dd>
          </div>
        ))}
      </dl>
      <p className="small faint" style={{ marginBottom: 0 }}>
        Position value: {orUnknown(formatUsd(position.valueUsd))}. Unavailable quantities
        and valuations remain unknown.
      </p>
    </>
  );
}
