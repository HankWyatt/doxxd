import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import type { WithdrawQuote } from "@/lib/actions/build/quote";
import { WSOL_MINT } from "@/lib/actions/programs";
import type { ActionStep, RunOptions } from "@/lib/actions/run";
import { ACTION_PROGRAM_IDS, type DammV2Target } from "@/lib/actions/types";
import type { ConnectedWallet } from "@/lib/actions/wallet-session";
import type { Schemas } from "@/lib/dmnd/contracts";
import { createFakeWallet } from "@/components/wallet-connect/fake-wallet.test-util";
import { HeaderWallet } from "@/components/wallet-connect/header-wallet";
import { WalletConnectProvider } from "@/components/wallet-connect/provider";
import { DAMM, dammV2Page, dammV2Position, syntheticAddress } from "@/tests/fixtures/synthetic-meteora-damm-v2";
import { ProtocolSection } from "../protocol-section";
import { resetLpRunStore } from "./run-store";
import { WithdrawDialog } from "./withdraw-dialog";

// The lazy action chunk (web3.js and the SDKs) is replaced wholesale.
const build = vi.hoisted(() => ({
  createActionRpc: vi.fn(),
  cachedReads: vi.fn(),
  quoteWithdraw: vi.fn(),
  buildWithdrawGroups: vi.fn(),
  runAction: vi.fn(),
  computeUnitPrice: vi.fn(),
  isRpcBusy: vi.fn(),
  buildClaimGroups: vi.fn(),
}));
vi.mock("@/lib/actions/build", () => build);

// Every address and amount here is invented.
const OWNER = syntheticAddress("withdraw-dialog/wallet");
const MINT_A = syntheticAddress("withdraw-dialog/token-a");
const MINT_B = syntheticAddress("withdraw-dialog/token-b");
const SIG = "5".repeat(88);
const OTHER = syntheticAddress("withdraw-dialog/other-wallet");
type Fake = ReturnType<typeof createFakeWallet>;

function target(over: Partial<DammV2Target> = {}): DammV2Target {
  return {
    protocol: "meteora-damm-v2",
    id: syntheticAddress("withdraw-dialog/position"),
    pool: syntheticAddress("withdraw-dialog/pool"),
    position: syntheticAddress("withdraw-dialog/position"),
    positionMint: syntheticAddress("withdraw-dialog/position-mint"),
    positionNftAccount: syntheticAddress("withdraw-dialog/nft-account"),
    nftTokenProgram: syntheticAddress("withdraw-dialog/nft-program"),
    program: ACTION_PROGRAM_IDS["meteora-damm-v2"],
    liquidity: { unlocked: "1000", vested: "0", permanentLocked: "0", total: "1000" },
    feeAAtoms: "1000000",
    feeBAtoms: "0",
    rewards: [],
    tokenA: { mint: MINT_A, decimals: 6, symbol: "SYNA" },
    tokenB: { mint: MINT_B, decimals: 9, symbol: "SYNB" },
    snapshotSlot: 1_000,
    ...over,
  };
}

// A quote proportional to `bps`; it closes only at 100%.
function quote(bps: number, over: Partial<WithdrawQuote> = {}): WithdrawQuote {
  const share = (atoms: number) => String((atoms * bps) / 10_000);
  return {
    receive: [
      { mint: MINT_A, symbol: "SYNA", decimals: 6, atoms: share(40_000_000) },
      { mint: MINT_B, symbol: "SYNB", decimals: 9, atoms: share(2_000_000_000) },
    ],
    fees: [
      { mint: MINT_A, symbol: "SYNA", decimals: 6, atoms: "1000000" },
      { mint: MINT_B, symbol: "SYNB", decimals: 9, atoms: "0" },
    ],
    minimums: [
      { mint: MINT_A, symbol: "SYNA", decimals: 6, atoms: share(39_000_000) },
      { mint: MINT_B, symbol: "SYNB", decimals: 9, atoms: share(1_900_000_000) },
    ],
    closes: bps === 10_000,
    depositRefundLamports: "3000000",
    rentLamports: "0",
    withdrawableBps: 10_000,
    vestingBps: 0,
    ...over,
  };
}

const UNCACHED = { name: "uncached", priorityFees: vi.fn(async () => [1, 2, 3]) };

function wallet(): ConnectedWallet {
  return {
    address: OWNER,
    walletName: "Phantom",
    walletIcon: null,
    supportsBatch: true,
    signTransactions: vi.fn(),
    disconnect: vi.fn(),
  };
}

const GROUPS = [{ label: "Withdraw SYNA + SYNB", positionIds: ["p"], instructions: [] }];
function builds(closes: boolean | ((call: number) => boolean) = true) {
  let calls = 0;
  build.buildWithdrawGroups.mockImplementation(async (_rpc, owner: string) => {
    calls++;
    return {
      groups: GROUPS,
      expectation: { kind: "withdraw", owner, mints: [], positions: [] },
      closes: typeof closes === "function" ? closes(calls) : closes,
    };
  });
}

// runAction that waits until the test settles it.
function heldRun() {
  let finish!: (steps: ActionStep[]) => void;
  let options!: RunOptions;
  build.runAction.mockImplementation(
    (o: RunOptions) =>
      new Promise<ActionStep[]>((resolve) => {
        options = o;
        finish = resolve;
      }),
  );
  return {
    finish: (steps: ActionStep[]) => act(() => finish(steps)),
    update: (steps: ActionStep[]) => act(() => options.onUpdate(steps)),
    options: () => options,
  };
}
const step = (over: Partial<ActionStep>): ActionStep => ({
  index: 1,
  label: "Withdraw SYNA + SYNB",
  positionIds: ["p"],
  status: "queued",
  ...over,
});

function open(t: DammV2Target = target()) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<WithdrawDialog target={t} wallet={wallet()} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}
const quoted = async (bps: number) =>
  waitFor(() => expect(build.quoteWithdraw).toHaveBeenLastCalledWith(expect.anything(), OWNER, expect.anything(), bps, expect.any(Number)));
const review = () => screen.getByRole("button", { name: "Review in wallet" });
const ready = () => waitFor(() => expect(review()).toBeEnabled());
const lastQuote = () => build.quoteWithdraw.mock.lastCall!;

beforeEach(() => {
  window.localStorage.clear();
  build.createActionRpc.mockImplementation(() => UNCACHED);
  build.cachedReads.mockImplementation((rpc: unknown) => ({ name: "cached", of: rpc }));
  build.quoteWithdraw.mockImplementation(async (_rpc, _owner, _target, bps: number) => quote(bps));
  build.computeUnitPrice.mockImplementation(() => 20_000);
  build.isRpcBusy.mockImplementation(() => false);
});
afterEach(() => {
  resetLpRunStore();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("withdraw dialog quote", () => {
  it("opens with one live quote at 100% through cached reads", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "Withdraw from SYNA + SYNB" })).toBeInTheDocument();
    await ready();
    expect(build.quoteWithdraw).toHaveBeenCalledTimes(1);
    const [rpc, owner, t, bps, slippage] = lastQuote();
    expect(rpc).toEqual({ name: "cached", of: UNCACHED });
    expect(build.cachedReads).toHaveBeenCalledWith(UNCACHED, 30_000);
    expect([owner, t.id, bps, slippage]).toEqual([OWNER, target().id, 10_000, 100]);
    expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("You receive (about)")).toBeInTheDocument();
    expect(screen.getByText("40 SYNA + 2 SYNB")).toBeInTheDocument();
    expect(screen.getByText("Includes fees")).toBeInTheDocument();
    expect(screen.getByText("1 SYNA + 0 SYNB")).toBeInTheDocument();
    expect(screen.getByText("Minimum you'll accept")).toBeInTheDocument();
    expect(screen.getByText("39 SYNA + 1.9 SYNB")).toBeInTheDocument();
    expect(screen.getByText("+0.003 SOL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("presets and the price-move chips re-quote from the loaded state", async () => {
    open();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    await quoted(2_500);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await quoted(5_000);
    fireEvent.click(screen.getByRole("button", { name: "75%" }));
    await quoted(7_500);
    fireEvent.click(screen.getByRole("button", { name: "0.5%" }));
    await waitFor(() => expect(lastQuote()[4]).toBe(50));
    expect(lastQuote()[3]).toBe(7_500);
    fireEvent.click(screen.getByRole("button", { name: "2%" }));
    await waitFor(() => expect(lastQuote()[4]).toBe(200));
    // One rpc and one cache for every re-quote.
    expect(build.createActionRpc).toHaveBeenCalledTimes(1);
    expect(build.cachedReads).toHaveBeenCalledTimes(1);
    for (const call of build.quoteWithdraw.mock.calls) expect(call[0]).toEqual({ name: "cached", of: UNCACHED });
    await ready();
    expect(screen.getByText("30 SYNA + 1.5 SYNB")).toBeInTheDocument();
  });

  it("takes a custom whole percent of the withdrawable part, 1 to 100", async () => {
    open();
    await ready();
    const input = screen.getByRole("spinbutton", { name: "or type a percent of the withdrawable part" });
    for (const bad of ["0", "101", "2.5"]) {
      const before = build.quoteWithdraw.mock.calls.length;
      fireEvent.change(input, { target: { value: bad } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole percent from 1 to 100");
      expect(input).toHaveAccessibleDescription("Enter a whole percent from 1 to 100");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(review()).toBeDisabled();
      expect(build.quoteWithdraw.mock.calls.length).toBe(before);
      // The last quote was for another share: no amounts until a valid one.
      expect(screen.getByText("You receive (about)").nextElementSibling).toHaveTextContent("—");
      expect(screen.getByText("Minimum you'll accept").nextElementSibling!.firstChild).toHaveTextContent("—");
    }
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(review()).toBeDisabled();
    expect(screen.getByText("You receive (about)").nextElementSibling).toHaveTextContent("—");
    fireEvent.change(input, { target: { value: "40" } });
    await quoted(4_000);
    expect(screen.queryByText("Enter a whole percent from 1 to 100")).toBeNull();
    expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute("aria-pressed", "false");
    await ready();
  });

  it("takes a custom price move above 0% and up to 5%", async () => {
    open();
    await ready();
    const input = screen.getByRole("spinbutton", { name: "% price move" });
    for (const bad of ["0", "5.5", "5.01", "-1", "1.234", "0.001"]) {
      const before = build.quoteWithdraw.mock.calls.length;
      fireEvent.change(input, { target: { value: bad } });
      expect(await screen.findByRole("alert")).toHaveTextContent("Enter a price move above 0% and up to 5%");
      expect(input).toHaveAccessibleDescription("Enter a price move above 0% and up to 5%");
      expect(review()).toBeDisabled();
      expect(build.quoteWithdraw.mock.calls.length).toBe(before);
      expect(screen.getByText("You receive (about)").nextElementSibling).toHaveTextContent("—");
    }
    for (const [good, bps] of [["3.5", 350], ["0.01", 1], ["4.99", 499], ["5", 500]] as const) {
      fireEvent.change(input, { target: { value: good } });
      await waitFor(() => expect(lastQuote()[4]).toBe(bps));
      await ready();
    }
  });

  it("shows the close line only at 100% when the quote closes", async () => {
    open();
    await ready();
    expect(screen.getByText("Closes position, returns deposit")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await quoted(5_000);
    await ready();
    expect(screen.queryByText("Closes position, returns deposit")).toBeNull();
  });

  it("hides the close line when the live quote does not close, even at 100%", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) => quote(bps, { closes: false }));
    open();
    await ready();
    expect(screen.queryByText("Closes position, returns deposit")).toBeNull();
  });

  it("says how much is still vesting, from the live quote", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) =>
      quote(bps, { vestingBps: 4_000, withdrawableBps: 6_000 }),
    );
    open();
    expect(
      await screen.findByText("40% is still vesting. You can withdraw up to 60% now; the rest unlocks over time."),
    ).toBeInTheDocument();
  });

  it("says how much is vesting and how much is locked for good", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) =>
      quote(bps, { vestingBps: 2_000, withdrawableBps: 5_000 }),
    );
    open();
    expect(
      await screen.findByText("20% is still vesting and 30% is locked for good. You can withdraw up to 50% now."),
    ).toBeInTheDocument();
    await ready();
  });

  it("says how much is locked for good when nothing is vesting", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) =>
      quote(bps, { vestingBps: 0, withdrawableBps: 7_000 }),
    );
    open();
    expect(
      await screen.findByText("30% of this position is locked for good. You can withdraw up to 70% now."),
    ).toBeInTheDocument();
    await ready();
  });

  it("says nothing can be withdrawn yet when the withdrawable part is 0", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) =>
      quote(bps, { vestingBps: 6_000, withdrawableBps: 0 }),
    );
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing to withdraw yet");
    expect(screen.queryByText(/still vesting|locked for good|up to 0%/)).toBeNull();
    expect(review()).toBeDisabled();
  });

  it("says the amount is too small when every minimum is 0", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) => {
      const q = quote(bps);
      return bps === 2_500 ? { ...q, minimums: q.minimums.map((m) => ({ ...m, atoms: "0" })) } : q;
    });
    open();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Amount too small to withdraw");
    expect(review()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await ready();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never lets a stale quote overwrite a newer one", async () => {
    open();
    await ready();
    const held = new Map<number, (q: WithdrawQuote) => void>();
    build.quoteWithdraw.mockImplementation(
      (_r, _o, _t, bps: number) => new Promise<WithdrawQuote>((resolve) => held.set(bps, resolve)),
    );
    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    await waitFor(() => expect(held.has(2_500)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await waitFor(() => expect(held.has(5_000)).toBe(true));
    await act(async () => held.get(5_000)!(quote(5_000)));
    await ready();
    expect(screen.getByText("20 SYNA + 1 SYNB")).toBeInTheDocument();
    await act(async () => held.get(2_500)!(quote(2_500)));
    expect(screen.getByText("20 SYNA + 1 SYNB")).toBeInTheDocument();
    expect(screen.queryByText("10 SYNA + 0.5 SYNB")).toBeNull();
    expect(review()).toBeEnabled();
  });

  it("has no vesting sentence when everything is withdrawable", async () => {
    open();
    await ready();
    expect(screen.queryByText(/still vesting/)).toBeNull();
  });

  it("says wrapped SOL comes back as SOL when a leg is wSOL", async () => {
    open(target({ tokenB: { mint: WSOL_MINT, decimals: 9, symbol: "SOL" } }));
    expect(await screen.findByText("Wrapped SOL in your wallet comes back as SOL too.")).toBeInTheDocument();
  });

  it("has no wrapped SOL note without a wSOL leg", async () => {
    open();
    await ready();
    expect(screen.queryByText(/Wrapped SOL/)).toBeNull();
  });

  it("estimates the network fee: base fee, priority fee and new account rent", async () => {
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) =>
      quote(bps, { rentLamports: bps === 10_000 ? "0" : "2000000" }),
    );
    open();
    await ready();
    // 5,000 + 20,000 µlamports × 200,000 units = 9,000 lamports.
    expect(screen.getByText("~0.000009 SOL")).toBeInTheDocument();
    expect(build.computeUnitPrice).toHaveBeenCalledWith([1, 2, 3]);
    expect(UNCACHED.priorityFees).toHaveBeenCalledWith([target().pool, target().position]);
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    expect(await screen.findByText("~0.002009 SOL")).toBeInTheDocument();
  });

  it("shows — for the network fee when the priority fees can't be read", async () => {
    build.createActionRpc.mockImplementation(() => ({
      ...UNCACHED,
      priorityFees: vi.fn(async () => {
        throw new Error("busy");
      }),
    }));
    open();
    await ready();
    const fee = screen.getByText("Network fee").parentElement!;
    expect(within(fee).getByText("—")).toBeInTheDocument();
  });
});

describe("withdraw dialog errors", () => {
  it("a quote failure says so plainly and disables Review", async () => {
    build.quoteWithdraw.mockRejectedValue(new Error("socket hang up"));
    open();
    expect(await screen.findByText("Couldn't load live pool data · try again")).toBeInTheDocument();
    expect(review()).toBeDisabled();
  });

  it.each([
    ["Nothing to withdraw yet"],
    ["Amount too small to withdraw"],
    ["Position data doesn't match the pool"],
    ["Withdrawals are paused for this pool"],
  ])("shows the builder's refusal: %s", async (message) => {
    build.quoteWithdraw.mockRejectedValue(new Error(message));
    open();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(review()).toBeDisabled();
  });

  it("a busy network says so, and choosing a share again retries", async () => {
    build.isRpcBusy.mockImplementation(() => true);
    build.quoteWithdraw.mockRejectedValueOnce(new Error("rate limited"));
    open();
    expect(await screen.findByText("Network busy · try again")).toBeInTheDocument();
    expect(review()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    await ready();
    expect(build.quoteWithdraw).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Network busy · try again")).toBeNull();
  });
});

describe("closing", () => {
  it("Esc closes", async () => {
    const { onClose } = open();
    await ready();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes", async () => {
    const { onClose } = open();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus inside the dialog", async () => {
    open();
    await ready();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("Esc does nothing while the wallet prompt is open", async () => {
    builds();
    const run = heldRun();
    const { onClose } = open();
    await ready();
    fireEvent.click(review());
    await waitFor(() => expect(build.runAction).toHaveBeenCalled());
    await run.update([step({ status: "awaiting-approval" })]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await run.update([step({ status: "sending", signature: SIG })]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Review in wallet", () => {
  it("rebuilds with the uncached rpc and runs the built groups once", async () => {
    builds();
    const run = heldRun();
    const { onDone } = open();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "50%" }));
    await quoted(5_000);
    // At 50% the quote does not close, so neither must the build.
    builds(false);
    await ready();
    fireEvent.click(review());
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(build.buildWithdrawGroups).toHaveBeenCalledWith(UNCACHED, OWNER, expect.objectContaining({ id: target().id }), 5_000, 100);
    const options = run.options();
    expect(options.groups).toBe(GROUPS);
    expect(options.intent).toBe("withdraw");
    expect(options.rpc).toBe(UNCACHED);
    expect(options.expectation.kind).toBe("withdraw");
    // The progress panel replaces the dialog body.
    expect(screen.queryByText("You receive (about)")).toBeNull();
    await run.update([step({ status: "awaiting-approval" })]);
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
    expect(screen.getByText("1 transaction · approve them in Phantom")).toBeInTheDocument();
    await run.finish([step({ status: "confirmed", signature: SIG, slot: 2_000 })]);
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Nothing was withdrawn")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(build.runAction).toHaveBeenCalledTimes(1);
  });

  it("a double click on Review starts one run only", async () => {
    builds();
    const run = heldRun();
    open();
    await ready();
    const button = review();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(build.runAction).toHaveBeenCalled());
    expect(build.buildWithdrawGroups).toHaveBeenCalledTimes(1);
    expect(build.runAction).toHaveBeenCalledTimes(1);
    await run.finish([step({ status: "stopped" })]);
  });

  it("says nothing was withdrawn when no step got a signature", async () => {
    builds();
    const run = heldRun();
    open();
    await ready();
    fireEvent.click(review());
    await waitFor(() => expect(build.runAction).toHaveBeenCalled());
    await run.finish([step({ status: "stopped", reason: "You declined in your wallet" })]);
    expect(screen.getByText("Nothing was withdrawn")).toBeInTheDocument();
    expect(
      screen.getByText("If you stop or reject, nothing is lost: your position stays as it is."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/those fees just stay unclaimed/)).toBeNull();
  });

  it("when the pool changed, shows the new amounts and asks for a second click", async () => {
    // The build no longer closes: the pool changed after the quote.
    let closes = true;
    build.quoteWithdraw.mockImplementation(async (_r, _o, _t, bps: number) => quote(bps, { closes }));
    builds(false);
    const run = heldRun();
    open();
    await ready();
    expect(screen.getByText("Closes position, returns deposit")).toBeInTheDocument();
    closes = false;
    fireEvent.click(review());
    expect(await screen.findByText("The pool changed · review the new amounts")).toBeInTheDocument();
    expect(build.runAction).not.toHaveBeenCalled();
    // Re-quoted from fresh reads: a new cache over the uncached rpc.
    await ready();
    expect(build.cachedReads).toHaveBeenCalledTimes(2);
    expect(build.quoteWithdraw).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Closes position, returns deposit")).toBeNull();
    fireEvent.click(review());
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(build.buildWithdrawGroups).toHaveBeenCalledTimes(2);
    await run.finish([step({ status: "confirmed", signature: SIG, slot: 2_000 })]);
  });

  it("a build failure shows the plain reason and sends nothing", async () => {
    build.buildWithdrawGroups.mockRejectedValue(new Error("Withdrawals are paused for this pool"));
    open();
    await ready();
    fireEvent.click(review());
    expect(await screen.findByText("Withdrawals are paused for this pool")).toBeInTheDocument();
    expect(build.runAction).not.toHaveBeenCalled();
  });
});

// The card and its dialog together, on your own wallet's page.
describe("on the LP card", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

  function Shell({ children }: { children: ReactNode }) {
    return (
      <ActionsAvailabilityProvider enabled>
        <WalletConnectProvider>{children}</WalletConnectProvider>
      </ActionsAvailabilityProvider>
    );
  }
  function page(): Schemas["WalletMeteoraDammV2Positions"] {
    const p = dammV2Page();
    p.data = [{ ...dammV2Position(), program: ACTION_PROGRAM_IDS["meteora-damm-v2"] }];
    return p;
  }

  function mountCard(): Fake {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, data: page() })),
    );
    const fake = createFakeWallet({ name: "Phantom", address: DAMM.wallet, authorized: true });
    fake.add();
    cleanup.push(fake.remove);
    window.localStorage.setItem("doxxd.wallet.v1", JSON.stringify({ name: "Phantom" }));
    render(
      <Shell>
        <HeaderWallet viewed={DAMM.wallet} />
        <ProtocolSection
          address={DAMM.wallet}
          resource="meteora-damm-v2"
          mode={{ kind: "live" }}
          labels={{ [DAMM.tokenB]: "SYNB" }}
          defaultOpen
        />
      </Shell>,
    );
    return fake;
  }

  it("Withdraw opens the dialog; closing it mid-run leaves the run on the card", async () => {
    mountCard();
    builds(true);
    const run = heldRun();
    await screen.findByText("Your wallet · Phantom");
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("dialog", { name: "Withdraw from SYNA + SYNB" });
    expect(dialog).toBeInTheDocument();
    await ready();
    fireEvent.click(review());
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(run.options().currentAddress()).toBe(DAMM.wallet);
    await run.update([step({ status: "queued" })]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The card's own panel carries on with the same run.
    expect(screen.getByText("Withdraw from SYNA + SYNB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop after this one" })).toBeInTheDocument();
    // No other action can start meanwhile.
    expect(screen.getByRole("button", { name: /Claim all fees/ })).toBeDisabled();
    expect(
      screen.getByText("If you stop or reject, nothing is lost: your position stays as it is."),
    ).toBeInTheDocument();
    await run.finish([step({ status: "stopped" })]);
    expect(screen.getByText("Nothing was withdrawn")).toBeInTheDocument();
  });

  it("closing during the rebuild, a changed pool still says so on the card", async () => {
    mountCard();
    let resolveBuild!: (built: unknown) => void;
    build.buildWithdrawGroups.mockImplementation(
      () => new Promise((resolve) => (resolveBuild = resolve)),
    );
    await screen.findByText("Your wallet · Phantom");
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await screen.findByRole("dialog");
    await ready();
    fireEvent.click(review());
    await waitFor(() => expect(build.buildWithdrawGroups).toHaveBeenCalled());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Checking live pool data…")).toBeInTheDocument();
    // The quote closed the position; the fresh build no longer does.
    await act(async () =>
      resolveBuild({
        groups: GROUPS,
        expectation: { kind: "withdraw", owner: DAMM.wallet, mints: [], positions: [] },
        closes: false,
      }),
    );
    expect(screen.getByText("The pool changed · review the new amounts")).toBeInTheDocument();
    expect(build.runAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it.each([
    ["switches account", (fake: Fake) => fake.switchAccount(OTHER)],
    ["disconnects", (fake: Fake) => fake.switchAccount(null)],
  ])("closes the dialog for good when the wallet %s", async (_name, change) => {
    const fake = mountCard();
    await screen.findByText("Your wallet · Phantom");
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await screen.findByRole("dialog");
    await ready();
    act(() => change(fake));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Back on the same account, it does not reopen on its own.
    act(() => fake.switchAccount(DAMM.wallet));
    await screen.findByText("Your wallet · Phantom");
    await screen.findByRole("button", { name: "Withdraw" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
