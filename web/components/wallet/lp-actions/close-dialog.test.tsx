import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionStep, RunOptions } from "@/lib/actions/run";
import { ACTION_PROGRAM_IDS, type DammV2Target } from "@/lib/actions/types";
import type { ConnectedWallet } from "@/lib/actions/wallet-session";
import { syntheticAddress } from "@/tests/fixtures/synthetic-meteora-damm-v2";
import { CloseDialog } from "./close-dialog";
import { resetLpRunStore } from "./run-store";

// The lazy action chunk (web3.js and the SDKs) is replaced wholesale.
const build = vi.hoisted(() => ({
  createActionRpc: vi.fn(),
  buildCloseGroups: vi.fn(),
  runAction: vi.fn(),
  isRpcBusy: vi.fn(),
  unwrapsWrappedSol: vi.fn(),
}));
vi.mock("@/lib/actions/build", () => build);

// Every address and amount here is invented.
const OWNER = syntheticAddress("close-dialog/wallet");
const MINT_A = syntheticAddress("close-dialog/token-a");
const MINT_B = syntheticAddress("close-dialog/token-b");
const EMPTY = { unlocked: "0", vested: "0", permanentLocked: "0", total: "0" };

function target(): DammV2Target {
  return {
    protocol: "meteora-damm-v2",
    id: syntheticAddress("close-dialog/position"),
    pool: syntheticAddress("close-dialog/pool"),
    position: syntheticAddress("close-dialog/position"),
    positionMint: syntheticAddress("close-dialog/position-mint"),
    positionNftAccount: syntheticAddress("close-dialog/nft-account"),
    nftTokenProgram: syntheticAddress("close-dialog/nft-program"),
    program: ACTION_PROGRAM_IDS["meteora-damm-v2"],
    liquidity: EMPTY,
    feeAAtoms: "0",
    feeBAtoms: "0",
    rewards: [],
    tokenA: { mint: MINT_A, decimals: 6, symbol: "SYNA" },
    tokenB: { mint: MINT_B, decimals: 9, symbol: "SYNB" },
    snapshotSlot: 1_000,
  };
}

const UNCACHED = { name: "uncached" };
const GROUPS = [{ label: "Close SYNA + SYNB", positionIds: ["p"], instructions: [] }];

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
  return { finish: (steps: ActionStep[]) => act(() => finish(steps)), options: () => options };
}

function open() {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(<CloseDialog target={target()} wallet={wallet()} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}
const closeButton = () => screen.getByRole("button", { name: "Close position" });

beforeEach(() => {
  build.createActionRpc.mockImplementation(() => UNCACHED);
  build.isRpcBusy.mockImplementation(() => false);
  build.unwrapsWrappedSol.mockImplementation(() => false);
  build.buildCloseGroups.mockImplementation(async (_rpc, owner: string) => ({
    groups: GROUPS,
    expectation: { kind: "close", owner, mints: [], positions: [] },
    refundLamports: "3000000",
  }));
});
afterEach(() => {
  resetLpRunStore();
  vi.clearAllMocks();
});

describe("close dialog", () => {
  it("asks to close the empty position, saying what its deposit returns", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "Close SYNA + SYNB" })).toBeInTheDocument();
    expect(
      await screen.findByText("Close this empty position? Its deposit (about 0.003 SOL) comes back to your wallet."),
    ).toBeInTheDocument();
    expect(build.buildCloseGroups).toHaveBeenCalledWith(UNCACHED, OWNER, expect.objectContaining({ id: target().id }));
    await waitFor(() => expect(closeButton()).toBeEnabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(build.runAction).not.toHaveBeenCalled();
  });

  it("Cancel closes without running anything", async () => {
    const { onClose } = open();
    await waitFor(() => expect(closeButton()).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(build.runAction).not.toHaveBeenCalled();
  });

  it("shows a builder's refusal and keeps Close position disabled", async () => {
    build.buildCloseGroups.mockRejectedValue(new Error("This position still holds liquidity"));
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("This position still holds liquidity");
    expect(closeButton()).toBeDisabled();
    expect(screen.getByText("Close this empty position? Its deposit comes back to your wallet.")).toBeInTheDocument();
  });

  it("rebuilds from fresh reads and runs a close, then shows the progress panel until Done", async () => {
    const run = heldRun();
    const { onDone } = open();
    await waitFor(() => expect(closeButton()).toBeEnabled());
    fireEvent.click(closeButton());
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(build.buildCloseGroups).toHaveBeenCalledTimes(2);
    const options = run.options();
    expect(options.intent).toBe("close");
    expect(options.groups).toBe(GROUPS);
    expect(options.expectation.kind).toBe("close");
    const panel = within(screen.getByRole("region", { name: "Close SYNA + SYNB" }));
    expect(panel.getByText("If you stop or reject, nothing is lost: your position stays as it is.")).toBeInTheDocument();
    run.finish([]);
    expect(await panel.findByText("Nothing was closed")).toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("ends the run with the refusal when the position is no longer empty at confirm time", async () => {
    open();
    await waitFor(() => expect(closeButton()).toBeEnabled());
    build.buildCloseGroups.mockRejectedValue(new Error("Part of this position is still vesting"));
    fireEvent.click(closeButton());
    expect(await screen.findByText("Part of this position is still vesting")).toBeInTheDocument();
    expect(build.runAction).not.toHaveBeenCalled();
  });
});
