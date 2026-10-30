"use client";
import { createContext, useContext, useState } from "react";
import { WSOL_MINT } from "@/lib/actions/programs";
import type { AmountView } from "@/lib/portfolio/model";
import { tokenImageCandidates } from "@/lib/safe-url";

/** Creator-supplied token labels by mint: searchable, never a trust signal. */
export type TokenMeta = { symbol?: string; name?: string; image?: string | null };
export type TokenMetaMap = Record<string, TokenMeta>;

/**
 * The wallet's holdings labels: the fallback for protocol legs, rewards and
 * fees that DMND sent without their own.
 */
export const HoldingsTokens = createContext<TokenMetaMap>({});

/**
 * A leg's name: DMND's symbol on the leg, then the holdings symbol, then the
 * adapter's label (the short mint, or SOL for wrapped SOL).
 */
export const legName = (a: AmountView, labels: Record<string, string>) =>
  a.mint ? (a.symbol ?? labels[a.mint] ?? a.label) : a.label;

function SolGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path fill="#80F5CF" d="M9 6h20l-6 5H3z" />
      <path fill="#A4A5F8" d="M3 13.5h20l6 5H9z" />
      <path fill="#B77BF3" d="M9 21h20l-6 5H3z" />
    </svg>
  );
}

/**
 * A token's picture: the SOL mark, else its image through the holdings URL
 * rules (credential-free HTTPS, IPFS gateways, next candidate on error, then
 * the fallback image), else the fallback (initials, or nothing).
 */
export function TokenImage({
  image,
  fallbackImage,
  sol = false,
  fallback,
  size = 24,
}: {
  image?: string | null;
  /** Tried after every candidate of `image` (the holdings image, for a leg). */
  fallbackImage?: string | null;
  sol?: boolean;
  fallback: string | null;
  size?: number;
}) {
  const candidates = [
    ...new Set([image, fallbackImage].flatMap(tokenImageCandidates)),
  ];
  const imageKey = candidates.join("\n");
  const [failed, setFailed] = useState({ key: "", urls: [] as string[] });
  const failures = failed.key === imageKey ? failed.urls : [];
  const src = candidates.find((candidate) => !failures.includes(candidate));
  if (sol) return <SolGlyph size={size} />;
  if (src)
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() =>
          setFailed((previous) => ({
            key: imageKey,
            urls: [...(previous.key === imageKey ? previous.urls : []), src],
          }))
        }
      />
    );
  return fallback;
}

/**
 * A leg's icon in a protocol card. `initials` keeps a letter when no image is
 * known (the pool pair); inline icons beside amounts show only real images.
 */
export function LegIcon({
  leg,
  name,
  initials = false,
}: {
  leg: AmountView;
  name: string;
  initials?: boolean;
}) {
  const holdings = useContext(HoldingsTokens);
  const sol = leg.mint === WSOL_MINT;
  // DMND's leg image first; an unsafe or failing one falls back to the holdings image.
  const image = leg.mint ? leg.image : null;
  const holdingsImage = leg.mint ? holdings[leg.mint]?.image : null;
  if (
    !initials &&
    !sol &&
    ![image, holdingsImage].flatMap(tokenImageCandidates).length
  )
    return null;
  return (
    <span
      className={initials ? "token-icon" : "token-icon inline-token-icon"}
      aria-hidden="true"
    >
      <TokenImage
        image={image}
        fallbackImage={holdingsImage}
        sol={sol}
        fallback={initials ? name.slice(0, 1) : null}
        size={initials ? 22 : 14}
      />
    </span>
  );
}
