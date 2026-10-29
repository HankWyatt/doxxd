// Pure helpers for the Wallet Standard connection. No React and no wallet
// libraries here, so the tests and the lazy action chunk can share them.

export const SOLANA_MAINNET = "solana:mainnet";
export const SIGN_TRANSACTION = "solana:signTransaction";
export const STANDARD_CONNECT = "standard:connect";
export const STANDARD_DISCONNECT = "standard:disconnect";
export const WALLET_STORAGE_KEY = "doxxd.wallet.v1";

export type ConnectedWallet = {
  address: string;
  walletName: string;
  walletIcon: string | null;
  supportsBatch: boolean;
  signTransactions(txs: Uint8Array[]): Promise<Uint8Array[]>;
  disconnect(): Promise<void>;
};

/** A wallet that can sign Solana mainnet transactions. */
export function isSolanaSigner(wallet: {
  chains: readonly string[];
  features: readonly string[];
}): boolean {
  return (
    wallet.chains.includes(SOLANA_MAINNET) &&
    wallet.features.includes(SIGN_TRANSACTION) &&
    wallet.features.includes(STANDARD_CONNECT)
  );
}

// Storage can be missing or throw (private windows, blocked site data); the
// connection must still work for the current page.
export function readRememberedWallet(): string | null {
  try {
    const raw = window.localStorage.getItem(WALLET_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const name = (parsed as { name?: unknown } | null)?.name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}
export function rememberWallet(name: string): void {
  try {
    window.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify({ name }));
  } catch {
    // Not remembered; the visitor reconnects next visit.
  }
}
export function forgetWallet(): void {
  try {
    window.localStorage.removeItem(WALLET_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

type SignFn = (
  ...inputs: Array<{ transaction: Uint8Array }>
) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;

/**
 * Signs serialized transactions. With batching every transaction goes to the
 * wallet in ONE call (one prompt); otherwise they are signed one at a time.
 */
export async function signTransactionBytes(
  sign: SignFn,
  txs: Uint8Array[],
  supportsBatch: boolean,
): Promise<Uint8Array[]> {
  if (txs.length === 0) return [];
  const outputs = supportsBatch
    ? await sign(...txs.map((transaction) => ({ transaction })))
    : await signOneByOne(sign, txs);
  if (outputs.length !== txs.length)
    throw new Error("The wallet returned the wrong number of signed transactions.");
  return outputs.map((o) => new Uint8Array(o.signedTransaction));
}
async function signOneByOne(sign: SignFn, txs: Uint8Array[]) {
  const outputs: Array<{ signedTransaction: Uint8Array }> = [];
  for (const transaction of txs) {
    const [out] = await sign({ transaction });
    if (!out) throw new Error("The wallet returned no signed transaction.");
    outputs.push(out);
  }
  return outputs;
}
