import bs58 from "bs58";

// A minimal in-memory Wallet Standard wallet for jsdom tests. It registers
// through the same window-event protocol real wallets use, so the code under
// test needs no test hooks.
type Listener = (properties: { accounts?: unknown[] }) => void;
export type FakeWalletOptions = {
  name?: string;
  address?: string | null;
  chains?: string[];
  features?: string[];
  // Whether a `silent` connect already returns the account.
  authorized?: boolean;
  // With `authorized`, whether accounts are already listed before any connect (default true).
  accountsOnLoad?: boolean;
  signs?: boolean;
};

export function createFakeWallet(options: FakeWalletOptions = {}) {
  const listeners = new Set<Listener>();
  let accounts: unknown[] = [];
  const connectCalls: Array<{ silent?: boolean } | undefined> = [];
  const signCalls: unknown[][] = [];
  let authorized = options.authorized ?? false;
  const accountFor = (address: string) => ({
    address,
    publicKey: bs58.decode(address),
    chains: options.chains ?? ["solana:mainnet"],
    features: options.signs === false ? [] : ["solana:signTransaction"],
  });
  const emit = () => listeners.forEach((l) => l({ accounts }));
  const set = (address: string | null) => {
    if (!address) authorized = false;
    accounts = address ? [accountFor(address)] : [];
    emit();
  };
  if (authorized && options.address && options.accountsOnLoad !== false) accounts = [accountFor(options.address)];
  const features: Record<string, unknown> = {
    "standard:connect": {
      version: "1.0.0",
      connect: async (input?: { silent?: boolean }) => {
        connectCalls.push(input);
        if (input?.silent && !authorized) return { accounts: [] };
        authorized = true;
        if (options.address) set(options.address);
        return { accounts };
      },
    },
    "standard:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        authorized = false;
        set(null);
      },
    },
    "standard:events": {
      version: "1.0.0",
      on: (_event: string, listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  if (options.signs !== false)
    features["solana:signTransaction"] = {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) => {
        signCalls.push(inputs);
        return inputs.map((input) => ({
          signedTransaction: Uint8Array.from([...input.transaction, 9]),
        }));
      },
    };
  const wallet = {
    version: "1.0.0",
    name: options.name ?? "Mock",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: options.chains ?? ["solana:mainnet"],
    features,
    get accounts() {
      return accounts;
    },
  };
  let unregister: (() => void) | undefined;
  const register = (api: { register(w: unknown): () => void }) => {
    unregister = api.register(wallet);
  };
  const add = () => {
    window.dispatchEvent(
      new CustomEvent("wallet-standard:register-wallet", { detail: register }),
    );
    window.addEventListener("wallet-standard:app-ready", onAppReady);
  };
  const onAppReady = ((e: CustomEvent) => register(e.detail)) as EventListener;
  return {
    wallet,
    connectCalls,
    signCalls,
    switchAccount: set,
    add,
    remove: () => {
      window.removeEventListener("wallet-standard:app-ready", onAppReady);
      unregister?.();
    },
  };
}
