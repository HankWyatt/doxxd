import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import { siteMetadata, walletMetadata } from "./site-metadata";
import { generateMetadata as portfolioMeta } from "@/app/wallet/[address]/page";
import { generateMetadata as activityMeta } from "@/app/wallet/[address]/activity/page";

const ADDRESS = bs58.encode(new Uint8Array(32).fill(7));
const short = `${ADDRESS.slice(0, 4)}…${ADDRESS.slice(-4)}`;

describe("site metadata", () => {
  it("carries Open Graph and Twitter preview tags", () => {
    expect(String(siteMetadata.metadataBase)).toBe("https://doxxd.io/");
    expect(siteMetadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: "/og.png", width: 1280, height: 640 }),
    ]);
    expect(siteMetadata.twitter).toMatchObject({
      card: "summary_large_image",
      images: ["/og.png"],
    });
    expect(siteMetadata.icons).toEqual({ icon: "/favicon.svg" });
  });
});

describe("wallet metadata", () => {
  it("titles a valid wallet and its activity with a canonical wallet URL", async () => {
    const p = await portfolioMeta({ params: Promise.resolve({ address: ADDRESS }) });
    expect(p.title).toEqual({ absolute: `Wallet ${short} on Doxxd` });
    expect(p.alternates?.canonical).toBe(`/wallet/${ADDRESS}`);
    expect(p.openGraph?.images).toEqual([
      expect.objectContaining({ url: "/og.png" }),
    ]);
    expect(p.twitter).toMatchObject({ card: "summary_large_image" });
    const a = await activityMeta({ params: Promise.resolve({ address: ADDRESS }) });
    expect(a.title).toEqual({ absolute: `Activity for wallet ${short} on Doxxd` });
    expect(a.alternates?.canonical).toBe(`/wallet/${ADDRESS}`);
    expect(a.openGraph?.url).toBe(`/wallet/${ADDRESS}/activity`);
  });
  it("falls back to the site defaults for an invalid address", async () => {
    expect(walletMetadata("not-an-address", "portfolio")).toEqual({});
    expect(await portfolioMeta({ params: Promise.resolve({ address: "O0Il" }) })).toEqual({});
  });
});
