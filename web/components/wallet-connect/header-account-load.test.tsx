import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { pillAddress } from "@/lib/actions/account";
import { DEMO_ADDRESS } from "@/lib/fixtures/wallet";
import { createFakeWallet } from "./fake-wallet.test-util";
import { HeaderAccount } from "./header-account";
import { WalletConnectProvider } from "./provider";

// The lazy chunk fails to download (a deploy replaced it, the network dropped).
vi.mock("./account-menu", () => {
  throw new Error("Failed to fetch dynamically imported module");
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const removers: Array<() => void> = [];
afterEach(() => {
  removers.splice(0).forEach((fn) => fn());
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <ActionsAvailabilityProvider enabled>
      <WalletConnectProvider>{children}</WalletConnectProvider>
    </ActionsAvailabilityProvider>
  );
}

it("keeps the page and shows the inert pill when the account card cannot load", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fake = createFakeWallet({ name: "Phantom", address: DEMO_ADDRESS, authorized: true });
  fake.add();
  removers.push(fake.remove);
  window.localStorage.setItem("doxxd.wallet.v1", JSON.stringify({ name: "Phantom" }));
  render(
    <Shell>
      <main>Page content</main>
      <HeaderAccount />
    </Shell>,
  );
  expect(await screen.findByText(pillAddress(DEMO_ADDRESS))).toBeInTheDocument();
  // Let the rejected import settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(screen.getByText(pillAddress(DEMO_ADDRESS))).toBeInTheDocument();
  expect(screen.getByText("Page content")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Connected wallet/ })).toBeNull();
});
