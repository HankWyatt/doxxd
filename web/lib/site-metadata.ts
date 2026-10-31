import type { Metadata } from "next";
import { normalizeAddress } from "@/lib/address";

export const SITE_URL = "https://doxxd.io";
const SITE_TITLE = "Doxxd · The portfolio tracker for Solana";
const SITE_DESCRIPTION =
  "See what any Solana wallet holds (tokens, staking, lending and liquidity), follow the wallets that matter, and manage your own LP positions.";
const OG_IMAGE = {
  url: "/og.png",
  width: 1280,
  height: 640,
  alt: "Doxxd, the portfolio tracker for Solana",
};
const WALLET_DESCRIPTION =
  "Tokens, DeFi positions and activity for this Solana wallet on Doxxd.";

export const siteMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: "%s · Doxxd" },
  description: SITE_DESCRIPTION,
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    siteName: "Doxxd",
    url: "/",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
};

/** Static per-wallet tags. Never fetches; an invalid address keeps the site defaults. */
export function walletMetadata(
  address: string,
  kind: "portfolio" | "activity",
): Metadata {
  if (normalizeAddress(address) !== address) return {};
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  const title =
    kind === "activity"
      ? `Activity for wallet ${short} on Doxxd`
      : `Wallet ${short} on Doxxd`;
  const path =
    kind === "activity" ? `/wallet/${address}/activity` : `/wallet/${address}`;
  return {
    title: { absolute: title },
    description: WALLET_DESCRIPTION,
    alternates: { canonical: `/wallet/${address}` },
    openGraph: {
      type: "website",
      siteName: "Doxxd",
      url: path,
      title,
      description: WALLET_DESCRIPTION,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: WALLET_DESCRIPTION,
      images: ["/og.png"],
    },
  };
}
