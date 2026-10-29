"use client";
import { useCallback, useEffect, useState } from "react";
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
import { chipModel } from "@/lib/portfolio/chips";
import { ResourceState, LoadingRows } from "../resource-state";
import { WalletFrame, usePortfolioSummary } from "./frame";
import { Holdings } from "./holdings";
import { ProtocolSection, type ProtocolStatus } from "./protocol-section";
import { RecoveryNotice } from "./recovery-notice";
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
  const chips = chipModel(summary?.components ?? []);
  // A card for every protocol with a chip (in chip order), then for every
  // protocol a holdings receipt names, so each chip and receipt link has a target.
  const cards: ProtocolResource[] = [];
  for (const chip of chips.chips)
    if (chip.resource && chip.resource !== "overview" && !cards.includes(chip.resource))
      cards.push(chip.resource);
  if (overview.result?.ok)
    for (const asset of overview.result.data.assets) {
      const protocol = asset.position?.protocol;
      const resource = protocolResources.find(
        (r) => protocol && resources[r].componentId === protocol,
      );
      if (resource && !cards.includes(resource)) cards.push(resource);
    }
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
  // A receipt link follows the anchor of its mounted card.
  const [target, setTarget] = useState<ProtocolResource | null>(null);
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
    if (cards.includes(resource)) setTarget(resource);
  }
  const labels: Record<string, string> = {
    So11111111111111111111111111111111111111112: "WSOL",
  };
  if (overview.result?.ok)
    for (const a of overview.result.data.assets)
      if (a.symbol) labels[a.mint] = a.symbol;
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
                <strong className="numeric">{formatUsd(chip.valueUsd)}</strong>
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
              <span className="count">
                {cards.length} {cards.length === 1 ? "protocol" : "protocols"}
              </span>
            </h2>
          </div>
          <div className="protocol-list">
            {cards.map((resource) => (
              <ProtocolSection
                key={address + resource}
                address={address}
                resource={resource}
                mode={mode}
                labels={labels}
                defaultOpen
                onStatus={onStatus}
                component={summary?.components.find(
                  (c) => c.id === resources[resource].componentId,
                )}
              />
            ))}
          </div>
        </>
      )}
      <p className="small faint" style={{ lineHeight: 1.7, marginTop: 18 }}>
        Protocol availability and coverage vary. Unknown values stay unknown;
        receipt references and position details aren’t added to the headline.
      </p>
    </>
  );
}
