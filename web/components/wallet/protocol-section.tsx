"use client";
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import type {
  ProtocolResource,
  ResourceData,
  ResourceError,
  WalletDataMode,
  Schemas,
} from "@/lib/dmnd/contracts";
import { resources, type ProtocolKind } from "@/lib/dmnd/resources";
import { useWalletResource } from "@/lib/use-wallet-resource";
import {
  toProtocolView,
  type AmountView,
  type PositionView,
  type ProtocolPayload,
  type ProtocolView,
} from "@/lib/portfolio/model";
import { chipValue, componentState } from "@/lib/portfolio/chips";
import { kindTag, manageLink } from "@/lib/portfolio/links";
import { compareDecimalDesc, formatAmount, formatUsd } from "@/lib/decimal";
import { short } from "@/lib/portfolio/adapters/shared";
import { loadAllPages } from "@/lib/actions/load-all-pages";
import type { ActionTarget } from "@/lib/actions/types";
import { ResourceState, LoadingRows } from "../resource-state";
import { Amounts, PositionDetail } from "./position-detail";
import { RecoveryNotice } from "./recovery-notice";
import { mintLookup, positionName, type MintLookup } from "./lp-actions/amounts";
import { ClaimProgress } from "./lp-actions/claim-progress";
import { RowActions, RowFees } from "./lp-actions/row-actions";
import { SelectionBar } from "./lp-actions/selection-bar";
import {
  isActionResource,
  useLpActions,
  type LpActions,
  type LpRun,
} from "./lp-actions/use-lp-actions";

/**
 * Reports a card's transient failure with a way to retry it, or null once it
 * loads or settles on a non-transient answer.
 */
export type ProtocolStatus = (
  resource: ProtocolResource,
  retry: (() => void) | null,
) => void;

// Every protocol resource declares a kind (links.test.ts checks it).
function kindOf(resource: ProtocolResource): ProtocolKind {
  const kind = resources[resource].kind;
  if (!kind) throw new Error("Protocol resource without a kind: " + resource);
  return kind;
}
// Only these may succeed on a retry; the rest are answers, not outages.
// "unavailable" is DMND's temporary 503.
const TRANSIENT: ResourceError["kind"][] = [
  "upstream",
  "timeout",
  "rate_limited",
  "unavailable",
];
// This deployment has not enabled, configured or supported this source.
const NOT_ENABLED: ResourceError["kind"][] = [
  "configuration",
  "not_enabled",
  "unsupported",
];
const plural = (count: number, noun: string) =>
  count + " " + noun + (count === 1 ? "" : "s");
const legName = (a: AmountView, labels: Record<string, string>) =>
  a.mint ? (labels[a.mint] ?? a.label) : a.label;

export function ProtocolSection({
  address,
  resource,
  mode,
  component,
  labels,
  defaultOpen,
  limit = 5,
  onStatus,
  reveal,
  onOpened,
}: {
  address: string;
  resource: ProtocolResource;
  mode: WalletDataMode;
  component?: Schemas["WalletPortfolioComponent"];
  labels: Record<string, string>;
  defaultOpen: boolean;
  /** Positions shown before "Show all". */
  limit?: number;
  onStatus?: ProtocolStatus;
  /** Each new value opens the card (a followed receipt link). */
  reveal?: number;
  /** The visitor opened the card (toggle or page-level retry). */
  onOpened?: (resource: ProtocolResource) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    setOpen(true);
  }
  // A card that becomes open by default (the summary arrived) opens, unless
  // the visitor has already toggled it; it is never closed from outside.
  const [initial, setInitial] = useState(defaultOpen);
  const [toggled, setToggled] = useState(false);
  if (defaultOpen !== initial) {
    setInitial(defaultOpen);
    if (defaultOpen && !toggled) setOpen(true);
  }
  // A failure outlives a collapse: it clears only when the card loads again.
  const [failed, setFailed] = useState(false);
  // The position whose Withdraw was clicked; the withdraw dialog reads it.
  const [, setWithdrawTarget] = useState<ActionTarget | null>(null);
  const definition = resources[resource];
  // DMND reports "0" for sources it has not finished: only a chip or a
  // confirmed-complete source has a total worth showing.
  const state = component ? componentState(component) : null;
  const totalKnown = state === "chip" || state === "empty";
  const isOpen = useRef(open);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const retryBody = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    isOpen.current = open;
  });
  const report = useCallback(
    (retry: (() => void) | null) => {
      retryBody.current = retry;
      setFailed(retry !== null);
      onStatus?.(
        resource,
        retry
          ? () => {
              // A collapsed card retries by opening, which loads it afresh.
              if (isOpen.current) retryBody.current?.();
              else {
                setOpen(true);
                onOpened?.(resource);
              }
            }
          : null,
      );
    },
    [resource, onStatus, onOpened],
  );
  // Unmounting (another wallet) withdraws this card's failure.
  useLayoutEffect(() => () => onStatus?.(resource, null), [resource, onStatus]);
  return (
    <section className="panel protocol-card" id={"protocol-" + resource}>
      <button
        ref={toggleButton}
        type="button"
        className="protocol-toggle"
        aria-expanded={open}
        aria-label={(open ? "Collapse " : "Expand ") + definition.label}
        onClick={() => {
          setToggled(true);
          setOpen(!open);
          if (!open) onOpened?.(resource);
        }}
      >
        <span className="protocol-icon" aria-hidden="true">
          {definition.label.slice(0, 2)}
        </span>
        <span className="protocol-title">
          <h3>{definition.label}</h3>
          <span className="kind-tag">{kindTag(kindOf(resource))}</span>
          {resource === "liquid-staking" && (
            <span className="faint small hide-mobile">
              Receipt references · overlaps holdings
            </span>
          )}
        </span>
        {component && !component.coverage_complete && (
          <span className="badge partial hide-mobile">Partial</span>
        )}
        <span className="protocol-value">
          {/* A failed load, or a source not yet checked, never shows a total. */}
          {failed || !totalKnown || !component ? "—" : formatUsd(chipValue(component))}
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
            limit={limit}
            report={report}
            onWithdraw={setWithdrawTarget}
            cardHeading={toggleButton}
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
  limit,
  report,
  onWithdraw,
  cardHeading,
}: {
  address: string;
  resource: ProtocolResource;
  mode: WalletDataMode;
  labels: Record<string, string>;
  limit: number;
  report: (retry: (() => void) | null) => void;
  onWithdraw: (target: ActionTarget) => void;
  /** Takes focus back when the progress panel closes without Claim all. */
  cardHeading: RefObject<HTMLButtonElement | null>;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const request = useWalletResource(
    address,
    resource,
    resource === "liquid-staking"
      ? {}
      : { limit: 50, ...(cursor ? { cursor } : {}) },
    mode,
  );
  let view: ProtocolView | null = null;
  if (request.result?.ok) {
    try {
      view = toProtocolView(
        { resource, data: request.result.data } as ProtocolPayload,
        { isContinuation: Boolean(cursor) },
      );
    } catch {
      view = null;
    }
  }
  // Null while loading: a reopened failed card stays failed until it settles.
  const failed = !request.result
    ? null
    : request.result.ok
      ? view === null
      : TRANSIENT.includes(request.result.kind);
  // The hook returns a new (equivalent) refresh each render; report a stable one.
  const refresh = useRef(request.refresh);
  useLayoutEffect(() => {
    refresh.current = request.refresh;
  });
  // Before paint, so the header never shows a total beside a failed load.
  useLayoutEffect(() => {
    if (failed !== null) report(failed ? () => refresh.current() : null);
  }, [failed, report]);
  const refreshNow = useCallback(() => refresh.current(), []);
  const actions = useLpActions(resource, view?.positions ?? [], {
    address,
    refresh: refreshNow,
  });
  function page(next: string | undefined) {
    setCursor(next);
    setExpanded(null);
    setShowAll(false);
  }
  // This card's run is going: the page stays put under it.
  const runGoing = actions.run !== null && actions.run.phase !== "done";
  const claimAllButton = useRef<HTMLButtonElement>(null);
  // Names and decimals for amounts in the action UI, from DMND's rows.
  const lookup = mintLookup(
    [
      ...(view?.positions ?? []).flatMap((p) => (p.action ? [p.action] : [])),
      ...(actions.run?.targets ?? []),
    ],
    labels,
  );
  // The live region stays mounted (first, in every state of the card) so the
  // panel's arrival is announced, and the panel survives loading and errors.
  const live =
    actions.active || actions.run ? (
      <div className="lp-live" aria-live="polite">
        {actions.run && (
          <RunProgress
            run={actions.run}
            actions={actions}
            lookup={lookup}
            onDone={() => {
              actions.dismiss();
              (claimAllButton.current ?? cardHeading.current)?.focus();
            }}
          />
        )}
      </div>
    ) : null;
  if (!request.result)
    return (
      <>
        {live}
        <LoadingRows />
      </>
    );
  if (
    !request.result.ok &&
    !cursor &&
    NOT_ENABLED.includes(request.result.kind) &&
    request.result.scope !== "wallet"
  )
    return (
      <>
        {live}
        <RecoveryNotice state={request.recovery} retained={Boolean(request.refreshError)} retry={request.refresh} />
        <div className="empty-state" role="status">
          <strong>Not available yet</strong>
          This protocol view isn’t enabled for this connection yet. Other
          wallet sections remain available.
        </div>
      </>
    );
  if (!request.result.ok)
    return (
      <>
        {live}
        <RecoveryNotice state={request.recovery} retained={Boolean(request.refreshError)} retry={request.refresh} />
        <ResourceState error={request.result} retry={request.refresh} />
        {cursor && (
          <div className="paging">
            <span>Start a fresh position page.</span>
            <button className="button" disabled={runGoing} onClick={() => page(undefined)}>
              First page
            </button>
          </div>
        )}
      </>
    );
  if (!view)
    return (
      <>
        {live}
        <ResourceState
          error={{ ok: false, kind: "upstream" }}
          retry={request.refresh}
        />
      </>
    );
  const kind = kindOf(resource);
  // Array.prototype.sort is stable: unvalued rows keep source order, last.
  const sorted = [...view.positions].sort((a, b) =>
    compareDecimalDesc(a.valueUsd, b.valueUsd),
  );
  const rows = showAll ? sorted : sorted.slice(0, limit);
  const toggle = (id: string) => setExpanded(expanded === id ? null : id);
  const table = {
    rows,
    resource,
    labels,
    expanded,
    toggle,
  };
  const claimable = view.positions.flatMap((p) =>
    actions.row(p)?.claim ? [p.action!] : [],
  );
  const firstPage = request.result.data;
  // The card holds every row only on an unpaged first page.
  const allLoaded = !cursor && !view.hasMore;
  const claimAll = () => {
    if (!isActionResource(resource)) return;
    if (allLoaded) actions.start("claim", claimable);
    else
      actions.start("claim", async (signal) =>
        (
          await loadAllPages(
            address,
            resource,
            cursor ? null : (firstPage as ResourceData[typeof resource]),
            signal,
          )
        ).filter(actions.canClaim),
      );
  };
  return (
    <>
      {live}
      <RecoveryNotice state={request.recovery} retained={Boolean(request.refreshError)} retry={request.refresh} />
      {kind === "liquidity" && actions.active && actions.claimSupported ? (
        <div className="card-summary lp-actions-head">
          <span>
            {plural(view.totalPositions ?? view.positions.length, "position") +
              " · fees to claim on " +
              claimable.length}
          </span>
          {/* Other pages may hold fees even when this one has none. */}
          {(claimable.length > 0 || !allLoaded) && (
            <span className="inline lp-actions-buttons">
              {claimable.length > 0 && (
                <button
                  type="button"
                  className="action-pill"
                  aria-pressed={actions.selecting}
                  onClick={() => actions.setSelecting(!actions.selecting)}
                >
                  Select
                </button>
              )}
              <button
                ref={claimAllButton}
                type="button"
                className="action-pill primary"
                disabled={actions.busy}
                onClick={claimAll}
              >
                {allLoaded ? `Claim all fees (${claimable.length})` : "Claim all fees"}
              </button>
            </span>
          )}
        </div>
      ) : (
        kind === "liquidity" &&
        view.totalPositions !== null && (
          <p className="card-summary">{plural(view.totalPositions, "position")}</p>
        )
      )}
      {view.positions.length > 0 ? (
        <div className="table-scroll">
          {kind === "liquidity" ? (
            <LiquidityTable
              {...table}
              actions={actions.tracksPending ? actions : null}
              lookup={lookup}
              onWithdraw={onWithdraw}
            />
          ) : kind === "lending" ? (
            <LegTable
              {...table}
              columns={["Token", "Balance"]}
              sections={["Supplied", "Borrowed"]}
            />
          ) : kind === "perps" ? (
            <LegTable
              {...table}
              columns={["Market", "Size"]}
              sections={[null, "Borrowed"]}
            />
          ) : (
            <PositionTable
              {...table}
              first={
                resource === "stake"
                  ? "Validator"
                  : kind === "staking"
                    ? "Token"
                    : "Position"
              }
              second={kind === "staking" ? "Amount" : "Balance"}
            />
          )}
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
      {sorted.length > rows.length && (
        <button
          type="button"
          className="show-all"
          onClick={() => setShowAll(true)}
        >
          Show all {sorted.length}
        </button>
      )}
      {!actions.run &&
        actions.active &&
        actions.selecting && (
          <SelectionBar
            selected={actions.selected}
            lookup={lookup}
            busy={actions.busy}
            onClear={actions.clear}
            onClaim={() => actions.start("claim", actions.selected)}
          />
        )}
      <details className="coverage-note">
        <summary>
          <span className="details-label">
            <Info size={12} aria-hidden="true" /> details
          </span>
          <span className={"badge " + view.coverage.state}>
            {view.coverage.label}
          </span>
          {view.pageValueUsd !== null && (
            <span className="numeric">
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
              <button className="button" disabled={runGoing} onClick={() => page(undefined)}>
                First page
              </button>
            )}
            {view.hasMore && !view.continuationUnavailable && view.cursor && (
              <button className="button" disabled={runGoing} onClick={() => page(view.cursor!)}>
                Next positions
              </button>
            )}
          </span>
        </div>
      )}
    </>
  );
}

function RunProgress({
  run,
  actions,
  lookup,
  onDone,
}: {
  run: LpRun;
  actions: LpActions;
  lookup: MintLookup;
  onDone: () => void;
}) {
  const names = Object.fromEntries(
    run.targets.map((t) => [t.id, positionName(t, lookup)]),
  );
  return (
    <ClaimProgress
      title={
        run.count === null
          ? "Claiming fees from all positions"
          : `Claiming fees from ${plural(run.count, "position")}`
      }
      walletName={run.walletName}
      steps={run.steps}
      skipped={run.skipped}
      names={names}
      lookup={lookup}
      waiting={
        run.phase === "loading"
          ? "Loading every position…"
          : run.phase === "building"
            ? "Checking live pool data…"
            : null
      }
      error={run.error}
      done={run.phase === "done"}
      stopping={run.stopping}
      autoFocus={actions.focusRun}
      onStop={actions.stop}
      onDone={onDone}
    />
  );
}

type TableProps = {
  rows: PositionView[];
  resource: ProtocolResource;
  labels: Record<string, string>;
  expanded: string | null;
  toggle: (id: string) => void;
};

function DetailsToggle({
  row,
  expanded,
  toggle,
}: Pick<TableProps, "expanded" | "toggle"> & { row: PositionView }) {
  return (
    <button
      type="button"
      className="details-toggle"
      aria-expanded={expanded === row.id}
      aria-label={row.label + " details"}
      onClick={() => toggle(row.id)}
    >
      <Info size={12} aria-hidden="true" /> details
    </button>
  );
}

function DetailRow({
  row,
  labels,
  span,
}: {
  row: PositionView;
  labels: Record<string, string>;
  span: number;
}) {
  return (
    <tr className="detail-row">
      <td colSpan={span}>
        <PositionDetail position={row} labels={labels} />
      </td>
    </tr>
  );
}

/** Claimable amounts; USD only when the source values them. */
function Claimable({
  values,
  labels,
}: {
  values: AmountView[];
  labels: Record<string, string>;
}) {
  if (!values.length) return <span className="faint">—</span>;
  return (
    <div className="stack">
      {values.map((a, i) => (
        <div key={i}>
          <span className="numeric">{formatAmount(a.amount)}</span>{" "}
          <span className="muted">{legName(a, labels)}</span>
          {a.valueUsd != null && (
            <span className="faint"> ({formatUsd(a.valueUsd)})</span>
          )}
          {a.qualifier?.startsWith("raw atoms") && (
            <span className="faint small"> · raw atoms</span>
          )}
        </div>
      ))}
    </div>
  );
}

function LiquidityTable({
  rows,
  resource,
  labels,
  expanded,
  toggle,
  actions = null,
  lookup,
  onWithdraw,
}: TableProps & {
  /** On-site actions, when this card offers them (see useLpActions). */
  actions?: LpActions | null;
  lookup?: MintLookup;
  onWithdraw?: (target: ActionTarget) => void;
}) {
  const selecting = Boolean(actions?.active && actions.selecting);
  return (
    <table>
      <thead>
        <tr>
          {selecting && (
            <th>
              <span className="sr-only">Select</span>
            </th>
          )}
          <th>Pool</th>
          <th>Balance</th>
          <th className="hide-mobile">Claimable fees</th>
          <th className="right">USD Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const legs = row.assets.map((a) => legName(a, labels));
          const manage = manageLink(resource, row.links);
          const state = actions?.row(row) ?? null;
          return (
            <Fragment key={row.id}>
              <tr className="data-row">
                {selecting && (
                  <td className="select-cell">
                    {state?.claim && (
                      <input
                        type="checkbox"
                        aria-label={"Select " + (legs.length ? legs.join(" + ") : row.label)}
                        checked={actions!.isSelected(state.target.id)}
                        disabled={actions!.busy}
                        onChange={() => actions!.toggle(state.target)}
                      />
                    )}
                  </td>
                )}
                <td>
                  <div className="pool-cell">
                    <span className="pair-icons" aria-hidden="true">
                      {legs.slice(0, 2).map((name, i) => (
                        <span className="token-icon" key={i}>
                          {name.slice(0, 1)}
                        </span>
                      ))}
                    </span>
                    <span className="stack">
                      <strong>{legs.length ? legs.join(" + ") : row.label}</strong>
                      <span className="pool-meta">
                        {row.locked && (
                          <span
                            className="lock-badge"
                            title="Part of this position's liquidity is permanently locked or vesting."
                          >
                            <span aria-hidden="true">🔒 </span>locked
                          </span>
                        )}
                        <DetailsToggle row={row} expanded={expanded} toggle={toggle} />
                      </span>
                    </span>
                  </div>
                </td>
                <td>
                  <Amounts values={row.assets} labels={labels} />
                  {state && actions && (
                    <RowActions
                      state={state}
                      interactive={actions.active}
                      busy={actions.busy}
                      onClaim={(target) => actions.start("claim", [target])}
                      onWithdraw={(target) => onWithdraw?.(target)}
                      onRefresh={actions.refresh}
                    />
                  )}
                  {manage && (
                    <a
                      className={"manage-link" + (actions?.active ? " secondary" : "")}
                      href={manage.href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {manage.label} <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </td>
                <td className="hide-mobile">
                  {/* Fees only: rewards and raw counters stay under details. */}
                  {/* Action wording on your own wallet; "—" wherever a row is pending. */}
                  {state && lookup && (actions?.active || state.pending) ? (
                    <RowFees state={state} lookup={lookup}>
                      <Claimable values={row.fees ?? []} labels={labels} />
                    </RowFees>
                  ) : (
                    <Claimable values={row.fees ?? []} labels={labels} />
                  )}
                </td>
                <td className="right numeric">{formatUsd(row.valueUsd)}</td>
              </tr>
              {expanded === row.id && (
                <DetailRow row={row} labels={labels} span={selecting ? 5 : 4} />
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function PositionTable({
  rows,
  resource,
  labels,
  expanded,
  toggle,
  first,
  second,
}: TableProps & { first: string; second: string }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{first}</th>
          <th>{second}</th>
          <th className="right">USD Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Fragment key={row.id}>
            <tr className="data-row">
              <td>
                <span className="stack">
                  <strong className={resource === "stake" ? "mono" : undefined}>
                    {resource === "stake"
                      ? row.validator
                        ? short(row.validator)
                        : "Unknown"
                      : row.label}
                  </strong>
                  <DetailsToggle row={row} expanded={expanded} toggle={toggle} />
                </span>
              </td>
              <td>
                <Amounts values={row.assets} labels={labels} />
              </td>
              <td className="right numeric">{formatUsd(row.valueUsd)}</td>
            </tr>
            {expanded === row.id && <DetailRow row={row} labels={labels} span={3} />}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** One block per position: its legs under labelled sections (assets, then debts). */
function LegTable({
  rows,
  labels,
  expanded,
  toggle,
  columns,
  sections,
}: TableProps & {
  columns: [string, string];
  sections: [string | null, string];
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>{columns[0]}</th>
          <th>{columns[1]}</th>
          <th className="right">USD Value</th>
        </tr>
      </thead>
      {rows.map((row) => (
        <tbody key={row.id}>
          <tr className="group-row">
            <td colSpan={2}>
              <span className="group-title">
                <strong>{row.label}</strong>
                <span className="mono faint">{short(row.id)}</span>
                <DetailsToggle row={row} expanded={expanded} toggle={toggle} />
              </span>
            </td>
            <td className="right numeric">{formatUsd(row.valueUsd)}</td>
          </tr>
          {expanded === row.id && <DetailRow row={row} labels={labels} span={3} />}
          {[row.assets, row.debts].map((legs, i) =>
            legs.length ? (
              <Fragment key={i}>
                {sections[i] && (
                  <tr className="section-row">
                    <th colSpan={3} scope="rowgroup" className="label-mono">
                      {sections[i]}
                    </th>
                  </tr>
                )}
                {legs.map((leg, j) => (
                  <tr className="leg-row" key={j}>
                    <td>
                      {legName(leg, labels)}
                      {leg.qualifier && (
                        <span className="faint small"> · {leg.qualifier}</span>
                      )}
                    </td>
                    <td className="numeric">{formatAmount(leg.amount)}</td>
                    <td className="right numeric">{formatUsd(leg.valueUsd)}</td>
                  </tr>
                ))}
              </Fragment>
            ) : null,
          )}
        </tbody>
      ))}
    </table>
  );
}
