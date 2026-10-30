"use client";
import { orUnknown } from "@/components/unknown-value";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Layers3 } from "lucide-react";
import { useWalletResource } from "@/lib/use-wallet-resource";
import { useWalletPositions } from "@/lib/use-wallet-positions";
import {
  LIVE_MODE,
  type WalletDataMode,
  type ProtocolResource,
} from "@/lib/dmnd/contracts";
import { protocolResources, resources } from "@/lib/dmnd/resources";
import { formatUsd } from "@/lib/decimal";
import { chipModel, componentState } from "@/lib/portfolio/chips";
import { ResourceState, LoadingRows } from "../resource-state";
import {
  WalletFrame,
  usePortfolioSummary,
  usePortfolioSummaryStatus,
} from "./frame";
import { Holdings } from "./holdings";
import { ProtocolSection, type ProtocolStatus } from "./protocol-section";
import { RecoveryNotice } from "./recovery-notice";
import { HoldingsTokens, type TokenMetaMap } from "./token-meta";
import { WSOL_MINT } from "@/lib/actions/programs";
export function Portfolio({
  address,
  mode = LIVE_MODE,
}: {
  address: string;
  mode?: WalletDataMode;
}) {
  return (
    <WalletFrame address={address} mode={mode}>
      <PortfolioContent address={address} mode={mode} />
    </WalletFrame>
  );
}
function PortfolioContent({
  address,
  mode,
}: {
  address: string;
  mode: WalletDataMode;
}) {
  const overview = useWalletResource(address, "overview", {}, mode);
  const trading = useWalletPositions(address, mode);
  const summary = usePortfolioSummary();
  const summaryStatus = usePortfolioSummaryStatus();
  const chips = chipModel(summary?.components ?? []);
  const ready = summaryStatus === "ready";
  const summaryFailed = summaryStatus === "failed";
  const chipCards = chips.chips.flatMap((chip) =>
    chip.resource && chip.resource !== "overview" ? [chip.resource] : [],
  );
  const receiptCards: ProtocolResource[] = [];
  if (overview.result?.ok)
    for (const asset of overview.result.data.assets) {
      const protocol = asset.position?.protocol;
      const resource = protocolResources.find(
        (r) => protocol && resources[r].componentId === protocol,
      );
      if (resource) receiptCards.push(resource);
    }
  // Cards the visitor opened or revealed stay mounted whatever the summary says.
  const [kept, setKept] = useState<ProtocolResource[]>([]);
  const keep = useCallback((resource: ProtocolResource) => {
    setKept((current) =>
      current.includes(resource) ? current : [...current, resource],
    );
  }, []);
  // Main cards: every protocol when the summary failed (collapsed, lazy);
  // otherwise chip protocols in chip order, then receipt protocols. While the
  // summary loads only receipt cards mount, collapsed, so links have targets.
  // A ready summary's pending, unavailable or absent protocols wait collapsed
  // in a "Not checked yet" group; complete and empty ones are not shown.
  const main: ProtocolResource[] = [];
  const unchecked: ProtocolResource[] = [];
  const add = (list: ProtocolResource[], resource: ProtocolResource) => {
    if (!main.includes(resource) && !unchecked.includes(resource))
      list.push(resource);
  };
  if (summaryFailed) for (const r of protocolResources) add(main, r);
  for (const r of [...chipCards, ...receiptCards, ...kept]) add(main, r);
  if (ready)
    for (const r of protocolResources) {
      const c = summary?.components.find(
        (component) => component.id === resources[r].componentId,
      );
      const state = c ? componentState(c) : undefined;
      if (!c || state === "pending" || state === "unavailable") add(unchecked, r);
    }
  const cards = [...main, ...unchecked];
  // Chip and receipt cards open (and load) once the summary has loaded.
  const openByDefault = (resource: ProtocolResource) =>
    ready && (chipCards.includes(resource) || receiptCards.includes(resource));
  // Cards whose positions failed to load, each with its retry.
  const [failures, setFailures] = useState<
    Partial<Record<ProtocolResource, () => void>>
  >({});
  const onStatus = useCallback<ProtocolStatus>((resource, retry) => {
    setFailures((current) => {
      if (current[resource] === retry || (!retry && !(resource in current)))
        return current;
      const next = { ...current };
      if (retry) next[resource] = retry;
      else delete next[resource];
      return next;
    });
  }, []);
  const failed = Object.values(failures);
  // A receipt link opens its card, then follows the card's anchor.
  const [target, setTarget] = useState<ProtocolResource | null>(null);
  const [reveals, setReveals] = useState<
    Partial<Record<ProtocolResource, number>>
  >({});
  useEffect(() => {
    if (!target) return;
    const id = "protocol-" + target;
    const element = document.getElementById(id);
    if (!element) return;
    setTarget(null);
    if (window.location.hash === "#" + id) element.scrollIntoView?.();
    else window.location.hash = id;
    // Keep keyboard order at the section, including on a repeated follow.
    element
      .querySelector<HTMLButtonElement>(".protocol-toggle")
      ?.focus({ preventScroll: true });
  }, [target]);
  function showProtocol(resource: ProtocolResource) {
    if (!cards.includes(resource)) return;
    keep(resource);
    setReveals((current) => ({
      ...current,
      [resource]: (current[resource] ?? 0) + 1,
    }));
    setTarget(resource);
  }
  // A link from another page (the header's "Claim LP fees") can name a card
  // before the summary has mounted it; follow the anchor once, when it does.
  const arrival = useRef<string | null | undefined>(undefined);
  const [, followHash] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // A link on this page (that card on your own portfolio, or a chip) only
    // changes the hash. A hash showProtocol set itself already has the focus
    // inside its card, so it is not followed twice.
    const onHash = () => {
      const id = window.location.hash.slice(1);
      if (document.getElementById(id)?.contains(document.activeElement)) return;
      arrival.current = id || null;
      followHash();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (arrival.current === undefined)
      arrival.current = window.location.hash.slice(1) || null;
    const resource = cards.find((r) => "protocol-" + r === arrival.current);
    if (!resource) return;
    arrival.current = null;
    showProtocol(resource);
  });
  const card = (resource: ProtocolResource) => (
    <ProtocolSection
      key={address + resource}
      address={address}
      resource={resource}
      mode={mode}
      labels={labels}
      defaultOpen={openByDefault(resource)}
      onStatus={onStatus}
      onOpened={keep}
      reveal={reveals[resource]}
      component={summary?.components.find(
        (c) => c.id === resources[resource].componentId,
      )}
    />
  );
  // Holdings labels by mint: the fallback for legs DMND sent without labels.
  // Wrapped SOL in a protocol position always reads as SOL.
  const tokens: TokenMetaMap = {};
  const labels: Record<string, string> = { [WSOL_MINT]: "SOL" };
  if (overview.result?.ok)
    for (const a of overview.result.data.assets) {
      if (a.mint === WSOL_MINT || a.position) continue;
      const symbol = a.symbol?.trim();
      tokens[a.mint] = {
        ...(symbol ? { symbol } : {}),
        ...(a.name?.trim() ? { name: a.name.trim() } : {}),
        image: a.image_url ?? null,
      };
      if (symbol) labels[a.mint] = symbol;
    }
  return (
    <>
      {summary && (
        <div className="protocol-strip" aria-label="Portfolio sources">
          {chips.chips.map((chip) => (
            <a className="protocol-pill" key={chip.id} href={chip.href}>
              <span className="protocol-icon" aria-hidden="true">
                {chip.initials}
              </span>
              <span>
                <span className="small">{chip.label}</span>
                <strong className="numeric">{orUnknown(formatUsd(chip.valueUsd))}</strong>
              </span>
            </a>
          ))}
          {chips.nothingFound > 0 && (
            <span className="chip-note">
              +{chips.nothingFound}{" "}
              {chips.nothingFound === 1 ? "protocol" : "protocols"} checked ·
              nothing found
            </span>
          )}
          {chips.notAvailable > 0 && (
            <span className="chip-note">
              {chips.notAvailable} not available yet
            </span>
          )}
        </div>
      )}
      {failed.length > 0 && (
        <p className="chip-note protocol-failures" role="status">
          {failed.length} {failed.length === 1 ? "protocol" : "protocols"}{" "}
          couldn’t load ·{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => failed.forEach((retry) => retry())}
          >
            retry
          </button>
        </p>
      )}
      <RecoveryNotice state={overview.recovery} retained={Boolean(overview.refreshError)} retry={overview.refresh} />
      {!overview.result ? (
        <div className="panel">
          <LoadingRows />
        </div>
      ) : overview.result.ok ? (
        <Holdings
          key={address}
          overview={overview.result.data}
          showProtocol={showProtocol}
          trading={trading}
        />
      ) : (
        <div className="panel">
          <ResourceState error={overview.result} retry={overview.refresh} />
        </div>
      )}
      {cards.length > 0 && (
        <>
          <div className="section-heading">
            <h2>
              <Layers3 size={16} />
              Protocol positions{" "}
              {summaryFailed ? (
                // Every registered protocol is listed, none yet checked.
                <span className="count">not checked</span>
              ) : (
                main.length > 0 && (
                  <span className="count">
                    {main.length} {main.length === 1 ? "protocol" : "protocols"}
                  </span>
                )
              )}
            </h2>
          </div>
          {summaryFailed && (
            <p className="small faint protocol-unsummarised">
              Portfolio summary unavailable. Open a protocol to check it.
            </p>
          )}
          {/* One keyed list, so a card keeps its state when it changes group. */}
          <HoldingsTokens.Provider value={tokens}>
            <div className="protocol-list">
              {[
                ...main.map(card),
                ...(unchecked.length
                  ? [
                      <p className="small faint protocol-group-note" key="unchecked">
                        Not checked yet · {unchecked.length}{" "}
                        {unchecked.length === 1 ? "protocol" : "protocols"} still
                        updating or not available. Open one to check it.
                      </p>,
                    ]
                  : []),
                ...unchecked.map(card),
              ]}
            </div>
          </HoldingsTokens.Provider>
        </>
      )}
      <p className="small faint" style={{ lineHeight: 1.7, marginTop: 18 }}>
        Protocol availability and coverage vary. Unknown values stay unknown;
        receipt references and position details aren’t added to the headline.
      </p>
    </>
  );
}
