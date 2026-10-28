"use client";
import { useEffect, useState } from "react";
import { Layers3 } from "lucide-react";
import { useWalletResource } from "@/lib/use-wallet-resource";
import { useWalletPositions } from "@/lib/use-wallet-positions";
import {
  LIVE_MODE,
  type WalletDataMode,
  type ResourceData,
  type ProtocolResource,
} from "@/lib/dmnd/contracts";
import { protocolResources, resources } from "@/lib/dmnd/resources";
import { formatUsd } from "@/lib/decimal";
import { ResourceState, LoadingRows } from "../resource-state";
import { WalletFrame, usePortfolioSummary } from "./frame";
import { Holdings } from "./holdings";
import { ProtocolSection } from "./protocol-section";
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
  const [showAll, setShowAll] = useState(false);
  const represented = protocolResources.filter((resource) =>
    summary?.components.some(
      (c) =>
        c.id === resources[resource].componentId,
    ),
  );
  // Financial inclusion does not determine whether a summary link has a target.
  const featured = represented.length
    ? represented
    : (["stake", "kamino", "orca"] satisfies ProtocolResource[]);
  const other = protocolResources.filter((r) => !featured.includes(r));
  // A receipt link reveals hidden protocol views, then follows the anchor once
  // its section is mounted.
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
  }, [target, showAll]);
  function showProtocol(resource: ProtocolResource) {
    if (!featured.includes(resource)) setShowAll(true);
    setTarget(resource);
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
          {summary.components.map((c) => {
            const resource = (
              Object.keys(resources) as (keyof typeof resources)[]
            ).find((r) => resources[r].componentId === c.id);
            return (
              <a
                className="protocol-pill"
                key={c.id}
                href={
                  resource === "overview"
                    ? "#holdings"
                    : resource
                      ? "#protocol-" + resource
                      : "#coverage"
                }
              >
                <span className="protocol-icon">
                  {resource ? resources[resource].label.slice(0, 2) : "·"}
                </span>
                <span>
                  <span className="small">
                    {resource
                      ? resources[resource].label
                      : c.id.replaceAll("_", " ")}
                  </span>
                  <strong className="numeric">
                    {formatUsd(c.known_net_value_usd)}
                  </strong>
                </span>
              </a>
            );
          })}
        </div>
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
      <div className="section-heading">
        <h2>
          <Layers3 size={16} />
          Protocol positions{" "}
          <span className="count">{protocolResources.length} views</span>
        </h2>
        <span className="faint small hide-mobile">
          Expand a protocol to inspect positions
        </span>
      </div>
      <div className="protocol-list">
        {featured.map((resource) => (
          <ProtocolSection
            key={address + resource}
            address={address}
            resource={resource}
            mode={mode}
            labels={labels}
            component={summary?.components.find(
              (c) => c.id === resources[resource].componentId,
            )}
          />
        ))}
        {showAll &&
          other.map((resource) => (
            <ProtocolSection
              key={address + resource}
              address={address}
              resource={resource}
              mode={mode}
              labels={labels}
              component={summary?.components.find(
                (c) => c.id === resources[resource].componentId,
              )}
            />
          ))}
      </div>
      {other.length > 0 && (
        <button
          type="button"
          className="button ghost"
          style={{ marginTop: 14, width: "100%" }}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll
            ? "Show fewer protocols"
            : "Additional protocol views (" + other.length + ")"}
        </button>
      )}
      <p className="small faint" style={{ lineHeight: 1.7, marginTop: 18 }}>
        Protocol availability and coverage vary. Unknown values stay unknown;
        receipt references and position details aren’t added to the headline.
      </p>
    </>
  );
}
