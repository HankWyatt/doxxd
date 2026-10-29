import type { Page } from "@playwright/test";
import bs58 from "bs58";

export type MockWalletOptions = {
  address: string;
  signBehavior: "sign" | "reject";
};

// Registers a Wallet Standard wallet named "Mock" before any page script runs,
// through the standard register-wallet / app-ready window events (no wallet
// library is imported inside the page). Test-only: `window.__mockWallet` lets a
// test change account. The signature it writes is a fixed 64-byte pattern.
//
// A page reload keeps the wallet "authorized" (localStorage), like a real
// wallet, so a silent connect restores the account.
export async function installMockWallet(page: Page, options: MockWalletOptions) {
  await page.addInitScript(
    ({ publicKey, address, signBehavior }) => {
      const AUTH_KEY = "__mockWalletAuthorized";
      const authorizedAddress = () => {
        try {
          return window.localStorage.getItem(AUTH_KEY);
        } catch {
          return null;
        }
      };
      type Account = {
        address: string;
        publicKey: Uint8Array;
        chains: string[];
        features: string[];
      };
      const makeAccount = (addr: string, key: number[]): Account => ({
        address: addr,
        publicKey: Uint8Array.from(key),
        chains: ["solana:mainnet"],
        features: ["solana:signTransaction"],
      });
      const listeners = new Set<(p: { accounts?: Account[] }) => void>();
      let accounts: Account[] = [];
      let currentKey = publicKey;
      const emit = () => listeners.forEach((l) => l({ accounts }));
      const state = { signCalls: [] as number[] };
      const wallet = {
        version: "1.0.0",
        name: "Mock",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScyMCcgaGVpZ2h0PScyMCc+PHJlY3Qgd2lkdGg9JzIwJyBoZWlnaHQ9JzIwJyByeD0nNScgZmlsbD0nIzk5NDVmZicvPjwvc3ZnPg==",
        chains: ["solana:mainnet"],
        get accounts() {
          return accounts;
        },
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async (input?: { silent?: boolean }) => {
              if (input?.silent && !authorizedAddress()) return { accounts: [] };
              try {
                window.localStorage.setItem(AUTH_KEY, address);
              } catch {
                /* ignore */
              }
              accounts = [makeAccount(authorizedAddress() ?? address, currentKey)];
              emit();
              return { accounts };
            },
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect: async () => {
              try {
                window.localStorage.removeItem(AUTH_KEY);
              } catch {
                /* ignore */
              }
              accounts = [];
              emit();
            },
          },
          "standard:events": {
            version: "1.0.0",
            on: (_event: string, listener: (p: { accounts?: Account[] }) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) => {
              state.signCalls.push(inputs.length);
              if (signBehavior === "reject") throw new Error("User rejected the request.");
              return inputs.map(({ transaction }) => {
                const signed = Uint8Array.from(transaction);
                // Signature slot 0 sits right after the compact-u16 signature count.
                for (let i = 0; i < 64; i++) signed[1 + i] = (i * 3 + 1) & 0xff;
                return { signedTransaction: signed };
              });
            },
          },
        },
      };
      (window as unknown as { __mockWallet: unknown }).__mockWallet = {
        state,
        switchAccount(addr: string | null, key: number[] = []) {
          if (addr === null) {
            accounts = [];
          } else {
            currentKey = key;
            accounts = [makeAccount(addr, key)];
            try {
              window.localStorage.setItem(AUTH_KEY, addr);
            } catch {
              /* ignore */
            }
          }
          emit();
        },
      };
      // The Wallet Standard registration handshake, in both orders.
      const register = (api: { register(w: unknown): void }) => api.register(wallet);
      try {
        window.dispatchEvent(
          new CustomEvent("wallet-standard:register-wallet", { detail: register }),
        );
      } catch {
        /* ignore */
      }
      window.addEventListener("wallet-standard:app-ready", ((e: CustomEvent) =>
        register(e.detail)) as EventListener);
    },
    {
      publicKey: Array.from(bs58.decode(options.address)),
      address: options.address,
      signBehavior: options.signBehavior,
    },
  );
}

/** Emits a Wallet Standard account change, as if the user switched account in the wallet. */
export async function switchMockWalletAccount(page: Page, address: string | null) {
  const key = address === null ? [] : Array.from(bs58.decode(address));
  await page.evaluate(
    ([addr, bytes]) =>
      (window as unknown as {
        __mockWallet: { switchAccount(a: string | null, k: number[]): void };
      }).__mockWallet.switchAccount(addr as string | null, bytes as number[]),
    [address, key] as const,
  );
}
