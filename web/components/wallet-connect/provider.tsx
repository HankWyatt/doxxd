"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  getWalletFeature,
  useWallets,
  type UiWallet,
  type UiWalletAccount,
} from "@wallet-standard/react-core";
import { useSignTransactions } from "@solana/react";
import { useActionsEnabled } from "@/lib/actions/availability";
import {
  SIGN_TRANSACTION,
  SOLANA_MAINNET,
  STANDARD_CONNECT,
  STANDARD_DISCONNECT,
  forgetWallet,
  isSolanaSigner,
  readRememberedWallet,
  rememberWallet,
  signTransactionBytes,
  type ConnectedWallet,
} from "@/lib/actions/wallet-session";

type Controls = {
  /** True once the wallet logic has mounted in the browser. */
  ready: boolean;
  connected: ConnectedWallet | null;
  /** Remember `name` as the visitor's wallet. */
  choose(name: string): void;
  /** The connected address right now, for checks that must not use a stale render. */
  currentAddress(): string | null;
};
const idle: Controls = {
  ready: false,
  connected: null,
  choose: () => {},
  currentAddress: () => null,
};
const WalletConnectContext = createContext<Controls>(idle);

export function useWalletConnectControls(): Controls {
  return useContext(WalletConnectContext);
}
/** The connected wallet, or null when none is connected (or actions are off). */
export function useConnectedWallet(): ConnectedWallet | null {
  return useContext(WalletConnectContext).connected;
}
/** A getter for the connected address that always reflects the latest account. */
export function useCurrentAddress(): () => string | null {
  return useContext(WalletConnectContext).currentAddress;
}

const subscribeNever = () => () => {};

// The wallet logic mounts after hydration: the server and the first client
// render both see "nothing connected", so registered wallets never cause a
// hydration mismatch.
export function WalletConnectProvider({ children }: { children: ReactNode }) {
  const enabled = useActionsEnabled();
  // False on the server and during hydration, true afterwards.
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  // Never rendered into markup, so reading storage here cannot cause a mismatch.
  const [chosen, setChosen] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readRememberedWallet(),
  );
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const addressRef = useRef<string | null>(null);
  useEffect(() => {
    addressRef.current = connected?.address ?? null;
  }, [connected]);
  const ready = mounted && enabled;
  const choose = useCallback((name: string) => {
    rememberWallet(name);
    setChosen(name);
  }, []);
  const forget = useCallback(() => {
    forgetWallet();
    setChosen(null);
  }, []);
  const currentAddress = useCallback(() => addressRef.current, []);
  const value = useMemo<Controls>(
    () => ({
      ready,
      connected: enabled ? connected : null,
      choose,
      currentAddress,
    }),
    [ready, enabled, connected, choose, currentAddress],
  );
  return (
    <WalletConnectContext.Provider value={value}>
      {children}
      {ready && (
        <WalletRuntime chosen={chosen} onConnected={setConnected} onForget={forget} />
      )}
    </WalletConnectContext.Provider>
  );
}

type ConnectFeature = {
  connect(input?: { silent?: boolean }): Promise<unknown>;
};
type DisconnectFeature = { disconnect(): Promise<void> };

function WalletRuntime({
  chosen,
  onConnected,
  onForget,
}: {
  chosen: string | null;
  onConnected(wallet: ConnectedWallet | null): void;
  onForget(): void;
}) {
  const wallets = useWallets();
  const uiWallet = chosen
    ? wallets.find((w) => w.name === chosen && isSolanaSigner(w))
    : undefined;
  const silentTried = useRef(new Set<string>());
  useEffect(() => {
    if (!uiWallet || uiWallet.accounts.length > 0) return;
    if (silentTried.current.has(uiWallet.name)) return;
    silentTried.current.add(uiWallet.name);
    // Silent only: a page load never opens a wallet prompt.
    const feature = getWalletFeature(uiWallet, STANDARD_CONNECT) as ConnectFeature;
    feature.connect({ silent: true }).catch(() => {});
  }, [uiWallet]);
  const account = uiWallet?.accounts[0];
  if (
    !uiWallet ||
    !account ||
    !account.chains.includes(SOLANA_MAINNET) ||
    !account.features.includes(SIGN_TRANSACTION)
  )
    return null;
  return (
    <SignerBridge
      key={`${uiWallet.name}:${account.address}`}
      uiWallet={uiWallet}
      account={account}
      onConnected={onConnected}
      onForget={onForget}
    />
  );
}

// Holds the signing hook for the current account and publishes the result.
function SignerBridge({
  uiWallet,
  account,
  onConnected,
  onForget,
}: {
  uiWallet: UiWallet;
  account: UiWalletAccount;
  onConnected(wallet: ConnectedWallet | null): void;
  onForget(): void;
}) {
  const sign = useSignTransactions(account, SOLANA_MAINNET);
  const connected = useMemo<ConnectedWallet>(
    () => ({
      address: account.address,
      walletName: uiWallet.name,
      walletIcon: uiWallet.icon || null,
      supportsBatch: true,
      signTransactions: (txs) => signTransactionBytes(sign, txs, true),
      disconnect: async () => {
        onForget();
        if (!uiWallet.features.includes(STANDARD_DISCONNECT)) return;
        try {
          const feature = getWalletFeature(uiWallet, STANDARD_DISCONNECT) as DisconnectFeature;
          await feature.disconnect();
        } catch {
          // The wallet refused; Doxxd has already forgotten it.
        }
      },
    }),
    [account.address, uiWallet, sign, onForget],
  );
  useEffect(() => {
    onConnected(connected);
    return () => onConnected(null);
  }, [connected, onConnected]);
  return null;
}
