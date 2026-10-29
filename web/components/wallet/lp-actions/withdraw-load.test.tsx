import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { ACTION_PROGRAM_IDS } from "@/lib/actions/types";
import { createFakeWallet } from "@/components/wallet-connect/fake-wallet.test-util";
import { WalletConnectProvider } from "@/components/wallet-connect/provider";
import { DAMM, dammV2Page, dammV2Position } from "@/tests/fixtures/synthetic-meteora-damm-v2";
import { ProtocolSection } from "../protocol-section";

// The lazy Withdraw dialog chunk fails to download.
vi.mock("./withdraw-dialog", () => {
  throw new Error("Failed to fetch dynamically imported module");
});
vi.mock("@/lib/actions/build", () => ({
  createActionRpc: vi.fn(),
  buildClaimGroups: vi.fn(),
  runAction: vi.fn(),
  isRpcBusy: () => false,
}));

const removers: Array<() => void> = [];
afterEach(() => {
  removers.splice(0).forEach((fn) => fn());
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps the card and says so when the Withdraw dialog cannot load", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const page = dammV2Page();
  page.data = [{ ...dammV2Position(), program: ACTION_PROGRAM_IDS["meteora-damm-v2"] }];
  page.coverage.total_positions = 1;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: page })));
  const fake = createFakeWallet({ name: "Phantom", address: DAMM.wallet, authorized: true });
  fake.add();
  removers.push(fake.remove);
  window.localStorage.setItem("doxxd.wallet.v1", JSON.stringify({ name: "Phantom" }));
  render(
    <ActionsAvailabilityProvider enabled>
      <WalletConnectProvider>
        <ProtocolSection
          address={DAMM.wallet}
          resource="meteora-damm-v2"
          mode={{ kind: "live" }}
          labels={{}}
          defaultOpen
        />
      </WalletConnectProvider>
    </ActionsAvailabilityProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
  // Let the rejected import settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load · reload the page");
  expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
});
