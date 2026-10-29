"use client";
import { lazy, Suspense, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { pillAddress } from "@/lib/actions/account";
import { walletHref } from "@/lib/address";
import { LoadBoundary } from "../load-boundary";
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
  const connectButton = useRef<HTMLButtonElement>(null);
  // After Disconnect, focus moves to the Connect wallet button that replaces the pill.
  const focusConnect = useRef(false);
  useEffect(() => {
    if (connected || !focusConnect.current) return;
    focusConnect.current = false;
    connectButton.current?.focus();
  }, [connected]);
  if (!ready) return null;
  if (!connected)
    return (
      <ConnectButton
        buttonRef={connectButton}
        // Only a wallet the visitor picked, with the account it returned: a
        // silent reconnect or a later account switch never navigates.
        onChosen={(_name, address) => {
          if (window.location.pathname === "/")
            router.push(walletHref(address, "portfolio"));
        }}
      />
    );
  // The same pill, inert, while the card's code loads (or if it cannot).
  const placeholder = (
    <span className="account-pill" aria-hidden="true">
      <WalletIcon wallet={connected} size={20} />
      <span className="account-pill-address">{pillAddress(connected.address)}</span>
      <ChevronDown className="account-pill-chevron" size={14} aria-hidden="true" />
    </span>
  );
  return (
    <LoadBoundary fallback={placeholder}>
      <Suspense fallback={placeholder}>
        <AccountMenu
          wallet={connected}
          onDisconnect={() => {
            focusConnect.current = true;
          }}
        />
      </Suspense>
    </LoadBoundary>
  );
}
