import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import bs58 from "bs58";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { pillAddress } from "@/lib/actions/account";
import { createFakeWallet } from "./fake-wallet.test-util";
import { HeaderAccount } from "./header-account";
import { HeaderWallet } from "./header-wallet";
import { useConnectedWallet, useCurrentAddress, WalletConnectProvider } from "./provider";

const VIEWED = bs58.encode(new Uint8Array(32).fill(7));
const OTHER = bs58.encode(new Uint8Array(32).fill(8));
const STORAGE_KEY = "doxxd.wallet.v1";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Radix measures the account menu's anchor; jsdom has no ResizeObserver.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis))
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
});

const cleanup: Array<() => void> = [];
function track<T extends ReturnType<typeof createFakeWallet>>(fake: T): T {
  fake.add();
  cleanup.push(fake.remove);
  return fake;
}
function Shell({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  return (
    <ActionsAvailabilityProvider enabled={enabled}>
      <WalletConnectProvider>{children}</WalletConnectProvider>
    </ActionsAvailabilityProvider>
  );
}
function renderHeader(viewed = VIEWED, enabled = true) {
  return render(
    <Shell enabled={enabled}>
      <HeaderAccount />
      <HeaderWallet viewed={viewed} />
    </Shell>,
  );
}
beforeEach(() => {
  window.localStorage.clear();
  // The account card loads the connected wallet's summary; it is not under test here.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});
async function disconnectFromMenu(address: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `Connected wallet ${pillAddress(address)}` }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
}
const otherTag = "Viewing another wallet · Go to my wallet";

describe("HeaderWallet with the header account control", () => {
  it("renders nothing when actions are disabled", () => {
    track(createFakeWallet({ address: VIEWED }));
    const { container } = renderHeader(VIEWED, false);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Connect wallet, then lists only Solana signing wallets", async () => {
    track(createFakeWallet({ name: "Good", address: VIEWED }));
    track(createFakeWallet({ name: "NoSign", signs: false }));
    track(createFakeWallet({ name: "Evm", chains: ["eip155:1"] }));
    renderHeader();
    const button = await screen.findByRole("button", { name: "Connect wallet" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByRole("button", { name: /Good/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /NoSign/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Evm/ })).toBeNull();
  });

  it("offers Phantom when no Solana wallet is installed", async () => {
    renderHeader();
    const button = await screen.findByRole("button", { name: "Connect wallet" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(screen.getByText("No Solana wallet found")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Phantom/ });
    expect(link).toHaveAttribute("href", "https://phantom.com/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows the own state, then disconnects", async () => {
    const fake = track(createFakeWallet({ name: "Phantom", address: VIEWED }));
    renderHeader();
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: /Phantom/ }));
    expect(await screen.findByText("Your wallet · Phantom")).toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain("Phantom");
    // The page itself offers no Connect or Disconnect button any more.
    await screen.findByRole("button", { name: `Connected wallet ${pillAddress(VIEWED)}` });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      `Connected wallet ${pillAddress(VIEWED)}`,
    ]);
    await disconnectFromMenu(VIEWED);
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    expect(screen.queryByText(/Your wallet/)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(fake.wallet.accounts).toEqual([]);
  });

  it("shows the other state with a link to the connected wallet", async () => {
    track(createFakeWallet({ name: "Phantom", address: OTHER }));
    renderHeader();
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: /Phantom/ }));
    const link = await screen.findByRole("link", { name: "Go to my wallet" });
    expect(link.closest(".pill")).toHaveTextContent(otherTag);
    expect(link).toHaveAttribute(
      "href",
      `/wallet/${OTHER}`,
    );
  });

  it("reconnects silently to the remembered wallet and never prompts", async () => {
    const fake = track(
      createFakeWallet({ name: "Phantom", address: VIEWED, authorized: false }),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Phantom" }));
    renderHeader();
    await waitFor(() => expect(fake.connectCalls).toEqual([{ silent: true }]));
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    // Disconnected: the page shows no tag at all.
    expect(screen.queryByText(/Your wallet|Viewing another wallet/)).toBeNull();
  });

  it("restores an authorized remembered wallet without a prompt", async () => {
    const fake = track(
      createFakeWallet({ name: "Phantom", address: VIEWED, authorized: true }),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Phantom" }));
    renderHeader();
    expect(await screen.findByText("Your wallet · Phantom")).toBeInTheDocument();
    expect(fake.connectCalls.every((c) => c?.silent === true)).toBe(true);
  });

  it("does nothing, not even a silent connect, when actions are disabled", async () => {
    const fake = track(
      createFakeWallet({
        name: "Phantom",
        address: VIEWED,
        authorized: true,
        accountsOnLoad: false,
      }),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Phantom" }));
    const { result } = renderHook(() => useConnectedWallet(), {
      wrapper: ({ children }) => <Shell enabled={false}>{children}</Shell>,
    });
    // Give any (wrongly) mounted wallet logic time to run its effects.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fake.connectCalls).toEqual([]);
    expect(result.current).toBeNull();
  });

  it("works when localStorage throws", async () => {
    track(createFakeWallet({ name: "Phantom", address: VIEWED }));
    const original = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      renderHeader();
      await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
      await userEvent.click(await screen.findByRole("button", { name: /Phantom/ }));
      expect(await screen.findByText("Your wallet · Phantom")).toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = original;
      Storage.prototype.setItem = originalSet;
    }
  });

  it("follows an account switch in the wallet", async () => {
    const fake = track(createFakeWallet({ name: "Phantom", address: VIEWED }));
    renderHeader();
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: /Phantom/ }));
    expect(await screen.findByText("Your wallet · Phantom")).toBeInTheDocument();
    act(() => fake.switchAccount(OTHER));
    expect(await screen.findByText(/Viewing another wallet/)).toBeInTheDocument();
    act(() => fake.switchAccount(null));
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
  });
});

describe("useConnectedWallet", () => {
  it("is null with no provider or when actions are disabled", () => {
    expect(renderHook(() => useConnectedWallet()).result.current).toBeNull();
    const { result } = renderHook(() => useConnectedWallet(), {
      wrapper: ({ children }) => <Shell enabled={false}>{children}</Shell>,
    });
    expect(result.current).toBeNull();
  });

  it("reports the wallet's current account immediately, before React re-renders", async () => {
    const fake = track(
      createFakeWallet({ name: "Phantom", address: VIEWED, authorized: true }),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Phantom" }));
    const { result } = renderHook(
      () => ({ wallet: useConnectedWallet(), current: useCurrentAddress() }),
      { wrapper: Shell },
    );
    await waitFor(() => expect(result.current.wallet?.address).toBe(VIEWED));
    const current = result.current.current;
    expect(current()).toBe(VIEWED);
    // No act(), no awaiting effects: the getter must already see the new account.
    fake.switchAccount(OTHER);
    expect(current()).toBe(OTHER);
    fake.switchAccount(null);
    expect(current()).toBeNull();
    await waitFor(() => expect(result.current.wallet).toBeNull());
  });

  it("signs all transactions in one wallet call", async () => {
    const fake = track(
      createFakeWallet({ name: "Phantom", address: VIEWED, authorized: true }),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: "Phantom" }));
    const { result } = renderHook(() => useConnectedWallet(), { wrapper: Shell });
    await waitFor(() => expect(result.current).not.toBeNull());
    const wallet = result.current!;
    expect(wallet).toMatchObject({
      address: VIEWED,
      walletName: "Phantom",
      supportsBatch: true,
    });
    const signed = await wallet.signTransactions([
      Uint8Array.of(1, 2),
      Uint8Array.of(3),
    ]);
    expect(fake.signCalls).toHaveLength(1);
    expect(fake.signCalls[0]).toHaveLength(2);
    expect(signed).toEqual([Uint8Array.of(1, 2, 9), Uint8Array.of(3, 9)]);
  });
});
