"use client";
import { useActionsEnabled } from "@/lib/actions/availability";
import { headerWalletState } from "@/lib/actions/header-state";
import { walletHref } from "@/lib/address";
import { short } from "@/lib/portfolio/adapters/shared";
import { ConnectButton } from "./connect-button";
import { useConnectedWallet } from "./provider";

/** Connect / connected state for the wallet page header. `viewed` is the URL's address. */
export function HeaderWallet({ viewed }: { viewed: string }) {
  const enabled = useActionsEnabled();
  const wallet = useConnectedWallet();
  if (!enabled) return null;
  const state = headerWalletState(viewed, wallet?.address ?? null);
  if (state === "disconnected" || !wallet) return <ConnectButton />;
  const disconnect = (
    <button
      type="button"
      className="button ghost wallet-connect-small"
      onClick={() => void wallet.disconnect()}
    >
      Disconnect
    </button>
  );
  if (state === "own")
    return (
      <>
        <span className="pill">
          <span className="dot" aria-hidden="true" />
          Your wallet · {wallet.walletName}
        </span>
        {disconnect}
      </>
    );
  return (
    <>
      <span className="pill">
        Connected as {short(wallet.address)} · viewing another wallet
      </span>
      <a className="button wallet-connect-small" href={walletHref(wallet.address, "portfolio")}>
        Go to my wallet
      </a>
      {disconnect}
    </>
  );
}
