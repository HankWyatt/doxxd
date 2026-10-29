"use client";
import { headerWalletState } from "@/lib/actions/header-state";
import { walletHref } from "@/lib/address";
import { useConnectedWallet } from "./provider";

/**
 * The wallet page's connection tag. `viewed` is the URL's address. Connecting
 * and disconnecting live in the site header (HeaderAccount); with no wallet
 * connected, or actions off, nothing renders here.
 */
export function HeaderWallet({ viewed }: { viewed: string }) {
  const wallet = useConnectedWallet();
  if (!wallet) return null;
  if (headerWalletState(viewed, wallet.address) === "own")
    return (
      <span className="pill">
        <span className="dot" aria-hidden="true" />
        Your wallet · {wallet.walletName}
      </span>
    );
  return (
    <span className="pill">
      Viewing another wallet ·{" "}
      <a className="pill-link" href={walletHref(wallet.address, "portfolio")}>
        Go to my wallet
      </a>
    </span>
  );
}
