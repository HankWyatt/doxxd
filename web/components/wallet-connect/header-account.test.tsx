import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import bs58 from "bs58";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { HIDE_AMOUNTS_KEY, pillAddress } from "@/lib/actions/account";
import type { Schemas } from "@/lib/dmnd/contracts";
import { DEMO_ADDRESS, readFixture } from "@/lib/fixtures/wallet";
import { createFakeWallet } from "./fake-wallet.test-util";
import { HeaderAccount } from "./header-account";
import { WalletConnectProvider } from "./provider";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const OTHER = bs58.encode(new Uint8Array(32).fill(8));
const WALLET_KEY = "doxxd.wallet.v1";

// Radix measures the popover anchor; jsdom has no ResizeObserver.
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
type Summary = Schemas["WalletPortfolioSummary"];
function summaryWith(edit?: (s: Summary) => void) {
  const result = readFixture("summary", "complete");
  if (!result.ok) throw new Error("fixture");
  edit?.(result.data);
  return result;
}
function serveSummary(body: unknown | (() => Promise<unknown>)) {
  const fetch = vi.fn(async () => {
    const payload = typeof body === "function" ? await (body as () => Promise<unknown>)() : body;
    return new Response(JSON.stringify(payload));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function remember(name: string) {
  window.localStorage.setItem(WALLET_KEY, JSON.stringify({ name }));
}
async function connectedPill(address = DEMO_ADDRESS) {
  return screen.findByRole("button", { name: `Connected wallet ${pillAddress(address)}` });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/watchlist");
  push.mockClear();
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
});

describe("HeaderAccount", () => {
  it("renders nothing and never connects when actions are off", async () => {
    const fake = track(
      createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true, accountsOnLoad: false }),
    );
    remember("Phantom");
    const { container } = render(
      <Shell enabled={false}>
        <HeaderAccount />
      </Shell>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container).toBeEmptyDOMElement();
    expect(fake.connectCalls).toEqual([]);
  });

  it("offers Connect wallet with the existing picker when disconnected", async () => {
    track(createFakeWallet({ name: "Good", address: DEMO_ADDRESS }));
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: /Good/ })).toBeInTheDocument();
  });

  it("shows a pill with the wallet icon and a short address", async () => {
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    const pill = await connectedPill();
    expect(within(pill).getByText(pillAddress(DEMO_ADDRESS))).toBeInTheDocument();
    expect(pill.querySelector("img")).toHaveAttribute("src", "data:image/svg+xml;base64,PHN2Zy8+");
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the account card with net worth, links and actions", async () => {
    const user = userEvent.setup();
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await user.click(await connectedPill());
    const card = await screen.findByRole("dialog", { name: "Wallet account" });
    expect(await within(card).findByText("$12,345.67")).toBeInTheDocument();
    // The same label the wallet page uses for this (incomplete) summary.
    expect(within(card).getByText("Known value")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Portfolio" })).toHaveAttribute(
      "href",
      `/wallet/${DEMO_ADDRESS}`,
    );
    // The synthetic summary has Orca only: no on-site fee claim, no section.
    expect(within(card).queryByText("Opportunities")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says Net worth for a complete summary", async () => {
    serveSummary(
      summaryWith((s) => {
        s.whole_wallet_complete = true;
      }),
    );
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await userEvent.click(await connectedPill());
    const card = await screen.findByRole("dialog", { name: "Wallet account" });
    expect(await within(card).findByText("Net worth")).toBeInTheDocument();
  });

  it("shows a skeleton while loading and a dash when the value is unknown", async () => {
    let release: (value: unknown) => void = () => {};
    serveSummary(() => new Promise((resolve) => (release = resolve)));
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await userEvent.click(await connectedPill());
    expect(await screen.findByRole("status", { name: "Loading net worth" })).toBeInTheDocument();
    await act(async () => {
      release({ ok: false, kind: "unavailable" });
    });
    const card = screen.getByRole("dialog", { name: "Wallet account" });
    expect(await within(card).findByText("—")).toBeInTheDocument();
    expect(within(card).queryByText("$0.00")).toBeNull();
  });

  it("hides amounts and remembers the choice", async () => {
    const user = userEvent.setup();
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    const view = render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await user.click(await connectedPill());
    const card = await screen.findByRole("dialog", { name: "Wallet account" });
    await within(card).findByText("$12,345.67");
    await user.click(within(card).getByRole("button", { name: "Hide amounts" }));
    expect(within(card).getByText("••••")).toBeInTheDocument();
    expect(within(card).queryByText("$12,345.67")).toBeNull();
    expect(window.localStorage.getItem(HIDE_AMOUNTS_KEY)).toBe("1");
    view.unmount();

    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await user.click(await connectedPill());
    const again = await screen.findByRole("dialog", { name: "Wallet account" });
    expect(await within(again).findByText("••••")).toBeInTheDocument();
    await user.click(within(again).getByRole("button", { name: "Show amounts" }));
    expect(await within(again).findByText("$12,345.67")).toBeInTheDocument();
    expect(window.localStorage.getItem(HIDE_AMOUNTS_KEY)).toBeNull();
  });

  it("copies the full address", async () => {
    const user = userEvent.setup();
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await user.click(await connectedPill());
    const card = await screen.findByRole("dialog", { name: "Wallet account" });
    await user.click(within(card).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(DEMO_ADDRESS);
    expect(within(card).getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("disconnects from the card", async () => {
    const user = userEvent.setup();
    serveSummary(summaryWith());
    const fake = track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await user.click(await connectedPill());
    const card = await screen.findByRole("dialog", { name: "Wallet account" });
    await user.click(within(card).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
    expect(fake.wallet.accounts).toEqual([]);
  });

  it("links Claim LP fees to the first fee-claiming LP card when there are positions", async () => {
    serveSummary(
      summaryWith((s) => {
        s.components.push({
          ...s.components[0],
          id: "meteora_damm_v2",
          known_asset_value_usd: "300",
          known_net_value_usd: "300",
        });
      }),
    );
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await userEvent.click(await connectedPill());
    const card = await screen.findByRole("dialog", { name: "Wallet account" });
    expect(await within(card).findByText("Opportunities")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Claim LP fees/ })).toHaveAttribute(
      "href",
      `/wallet/${DEMO_ADDRESS}#protocol-meteora-damm-v2`,
    );
  });

  it("goes to the portfolio after a connect on the homepage", async () => {
    window.history.replaceState(null, "", "/");
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: OTHER }));
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: /Phantom/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/wallet/${OTHER}`));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("stays on the page after a connect elsewhere", async () => {
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: OTHER }));
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    await userEvent.click(await screen.findByRole("button", { name: /Phantom/ }));
    await connectedPill(OTHER);
    expect(push).not.toHaveBeenCalled();
  });

  it("does not navigate after a silent reconnect on the homepage", async () => {
    window.history.replaceState(null, "", "/");
    serveSummary(summaryWith());
    track(createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true }));
    remember("Phantom");
    render(
      <Shell>
        <HeaderAccount />
      </Shell>,
    );
    await connectedPill();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(push).not.toHaveBeenCalled();
  });
});
