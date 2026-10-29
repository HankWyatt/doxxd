"use client";
import { lazy, Suspense, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { pillAddress } from "@/lib/actions/account";
import { walletHref } from "@/lib/address";
import { ConnectButton } from "./connect-button";
import { useWalletConnectControls } from "./provider";
import { WalletIcon } from "./wallet-icon";

// The card (Radix Popover and its positioning code) loads only once a wallet
// is connected, so pages with actions off or no wallet never fetch it. The
// Worker gets a stub (see lib/actions/ssr-stub-plugin.ts).
const AccountMenu = lazy(() =>
  import("./account-menu").then((m) => ({ default: m.AccountMenu })),
);

/**
 * The connected-wallet control at the right of the site header. Nothing
 * renders on the server, during hydration or when actions are off.
 */
export function HeaderAccount() {
  const { ready, connected } = useWalletConnectControls();
  const router = useRouter();
  // Set when the visitor picks a wallet on the homepage; a silent reconnect
  // never picks one, so it never navigates.
  const goToPortfolio = useRef(false);
  useEffect(() => {
    if (!connected || !goToPortfolio.current) return;
    goToPortfolio.current = false;
    router.push(walletHref(connected.address, "portfolio"));
  }, [connected, router]);
  if (!ready) return null;
  if (!connected)
    return (
      <ConnectButton
        onChosen={() => {
          goToPortfolio.current = window.location.pathname === "/";
        }}
      />
    );
  // The same pill, inert, while the card's code loads.
  const placeholder = (
    <span className="account-pill" aria-hidden="true">
      <WalletIcon wallet={connected} size={20} />
      <span className="account-pill-address">{pillAddress(connected.address)}</span>
      <ChevronDown className="account-pill-chevron" size={14} aria-hidden="true" />
    </span>
  );
  return (
    <Suspense fallback={placeholder}>
      <AccountMenu wallet={connected} />
    </Suspense>
  );
}
