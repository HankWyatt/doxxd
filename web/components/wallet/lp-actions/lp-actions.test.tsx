import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import bs58 from "bs58";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { PENDING_ACTIONS_KEY, recordPending } from "@/lib/actions/pending";
import { ACTION_PROGRAM_IDS } from "@/lib/actions/types";
import type { ActionStep, RunOptions } from "@/lib/actions/run";
import type { ProtocolResource, Schemas } from "@/lib/dmnd/contracts";
import { short } from "@/lib/portfolio/adapters/shared";
import { explorerHref } from "@/lib/safe-url";
import { createFakeWallet } from "@/components/wallet-connect/fake-wallet.test-util";
import { HeaderWallet } from "@/components/wallet-connect/header-wallet";
import { WalletConnectProvider } from "@/components/wallet-connect/provider";
import { ProtocolSection } from "../protocol-section";
import {
  DAMM,
  dammV2Page,
  dammV2Position,
  syntheticAddress,
} from "@/tests/fixtures/synthetic-meteora-damm-v2";
import { CLMM, CPMM, clmmPage, cpmmPage } from "@/tests/fixtures/synthetic-raydium-positions";
import { refetchTimes } from "./use-lp-actions";
import { resetLpRunStore } from "./run-store";

// The lazy action chunk (web3.js and the SDKs) is replaced wholesale.
const build = vi.hoisted(() => ({
  createActionRpc: vi.fn((url: string) => ({ url })),
  buildClaimGroups: vi.fn(),
  buildCloseGroups: vi.fn(),
  runAction: vi.fn(),
  isRpcBusy: () => false,
  unwrapsWrappedSol: vi.fn(() => false),
}));
vi.mock("@/lib/actions/build", () => build);

const OTHER = bs58.encode(new Uint8Array(32).fill(8));
const SIG = bs58.encode(new Uint8Array(64).fill(9));
const SIG_2 = bs58.encode(new Uint8Array(64).fill(10));
const CP_AMM = ACTION_PROGRAM_IDS["meteora-damm-v2"];
const R = [1, 2, 3, 4].map((n) => syntheticAddress("lp-actions/damm-" + n));

// Row 1: fees and unlocked liquidity. Row 2: fees, only locked liquidity.
// Row 3: nothing to claim. Every value is invented.
function dammRow(n: number, over: Partial<Schemas["WalletMeteoraDammV2Position"]> = {}) {
  return { ...dammV2Position(), position: R[n - 1], program: CP_AMM, ...over };
}
function dammPage(): Schemas["WalletMeteoraDammV2Positions"] {
  const page = dammV2Page();
  page.data = [
    dammRow(1),
    dammRow(2, {
      liquidity: { unlocked: "0", vested: "0", permanent_locked: "1500", total: "1500" },
      fee_a_claimable_atoms: "500000000",
      fee_b_claimable_atoms: "0",
      rewards: [],
    }),
    dammRow(3, { fee_a_claimable_atoms: "0", fee_b_claimable_atoms: "0", rewards: [] }),
  ];
  page.coverage.total_positions = 3;
  return page;
}

function serve(pages: Record<string, unknown>) {
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, "http://doxxd.test");
    const resource = url.pathname.split("/").pop()!;
    const page = pages[resource + (url.searchParams.get("cursor") ?? "")];
    return Response.json({ ok: true, data: page });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const cleanup: Array<() => void> = [];
function connect(address: string | null) {
  if (!address) return null;
  const fake = createFakeWallet({ name: "Phantom", address, authorized: true });
  fake.add();
  cleanup.push(fake.remove);
  window.localStorage.setItem("doxxd.wallet.v1", JSON.stringify({ name: "Phantom" }));
  return fake;
}
function Shell({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return (
    <ActionsAvailabilityProvider enabled={enabled}>
      <WalletConnectProvider>{children}</WalletConnectProvider>
    </ActionsAvailabilityProvider>
  );
}
function mount(
  address: string,
  resource: ProtocolResource,
  { enabled = true, connected = address as string | null } = {},
) {
  const fake = connect(connected);
  render(
    <Shell enabled={enabled}>
      <HeaderWallet viewed={address} />
      <ProtocolSection
        address={address}
        resource={resource}
        mode={{ kind: "live" }}
        labels={{}}
        defaultOpen
      />
    </Shell>,
  );
  return fake;
}
const ownDamm = async () => {
  const fetch = serve({ "meteora-damm-v2": dammPage() });
  const fake = mount(DAMM.wallet, "meteora-damm-v2");
  await screen.findByText("Your wallet · Phantom");
  await screen.findAllByRole("button", { name: "Claim" });
  return { fetch, fake };
};
const rowOf = (text: string) => screen.getByText(text).closest("tr")!;

// A claim build for whatever targets the UI asks for.
function buildsGroups() {
  build.buildClaimGroups.mockImplementation(async (_rpc, owner: string, targets: { id: string }[]) => ({
    groups: [{ label: "claim", positionIds: targets.map((t) => t.id), instructions: [] }],
    skipped: [],
    expectation: { kind: "claim", owner, mints: [], positions: [] },
  }));
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
  return { finish: (steps: ActionStep[]) => act(() => finish(steps)), options: () => options };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  resetLpRunStore();
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("who sees LP actions", () => {
  it("shows nothing new when actions are off", async () => {
    serve({ "meteora-damm-v2": dammPage() });
    mount(DAMM.wallet, "meteora-damm-v2", { enabled: false });
    expect(await screen.findByText("3 positions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.queryByText(/fees to claim/)).toBeNull();
  });

  it("shows nothing new on another wallet's page", async () => {
    serve({ "meteora-damm-v2": dammPage() });
    mount(DAMM.wallet, "meteora-damm-v2", { connected: OTHER });
    await screen.findByText(/Viewing another wallet/);
    expect(await screen.findByText("3 positions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("keeps the usual fee cells on another wallet's Raydium cards", async () => {
    serve({ "raydium-clmm": clmmPage(), "raydium-cpmm": cpmmPage() });
    connect(OTHER);
    render(
      <Shell enabled>
        <HeaderWallet viewed={CLMM.wallet} />
        {(["raydium-clmm", "raydium-cpmm"] as const).map((resource) => (
          <ProtocolSection
            key={resource}
            address={resource === "raydium-clmm" ? CLMM.wallet : CPMM.wallet}
            resource={resource}
            mode={{ kind: "live" }}
            labels={{}}
            defaultOpen
          />
        ))}
      </Shell>,
    );
    await screen.findByText(/Viewing another wallet/);
    await screen.findByText("1 position");
    await screen.findByText(short(CPMM.tokenA) + " + " + short(CPMM.tokenB));
    expect(screen.queryByText(/at least/)).toBeNull();
    expect(screen.queryByText("Included in your LP tokens")).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("shows nothing new while no wallet is connected", async () => {
    serve({ "meteora-damm-v2": dammPage() });
    mount(DAMM.wallet, "meteora-damm-v2", { connected: null });
    expect(await screen.findByText("3 positions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
  });

  it("shows the actions on your own wallet", async () => {
    await ownDamm();
    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(2);
    expect(screen.getByText("3 positions · fees to claim on 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim all fees (2)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
    // DAMM v2 fees stay DMND's exact figures.
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText("0.5")).toBeInTheDocument();
    // The protocol link stays, as a smaller secondary link.
    expect(screen.getAllByRole("link", { name: /Manage on Meteora/ })[0]).toHaveClass("secondary");
  });

  it("shows no actions for Orca, even on your own wallet", async () => {
    const page = clmmPage();
    page.protocol = "orca";
    serve({ orca: page });
    mount(CLMM.wallet, "orca");
    await screen.findByText("Your wallet · Phantom");
    expect(await screen.findByText("1 position")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(screen.queryByText(/at least/)).toBeNull();
  });

  it("hides the actions when the wallet switches account", async () => {
    const { fake } = await ownDamm();
    act(() => fake!.switchAccount(OTHER));
    await screen.findByText(/Viewing another wallet/);
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByText(/fees to claim/)).toBeNull();
  });
});

describe("row buttons and fee cells", () => {
  it("says why a locked row has no Withdraw", async () => {
    await ownDamm();
    const locked = screen.getByRole("button", { name: "🔒 Locked" });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute("title", "Locked liquidity can't be withdrawn");
  });

  it("routes Withdraw to the dialog seam without starting a claim", async () => {
    await ownDamm();
    fireEvent.click(screen.getAllByRole("button", { name: "Withdraw" })[0]);
    expect(build.buildClaimGroups).not.toHaveBeenCalled();
    expect(build.runAction).not.toHaveBeenCalled();
  });

  it("CPMM rows offer Withdraw only, with fees included in the LP tokens", async () => {
    serve({ "raydium-cpmm": cpmmPage() });
    mount(CPMM.wallet, "raydium-cpmm");
    expect(await screen.findByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.getByText("Included in your LP tokens")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Claim all/ })).toBeNull();
  });

  it("CLMM fees read as a lower bound and the row offers Claim", async () => {
    serve({ "raydium-clmm": clmmPage() });
    mount(CLMM.wallet, "raydium-clmm");
    expect(await screen.findByRole("button", { name: "Claim" })).toBeInTheDocument();
    expect(screen.getByText("at least 0.0015 SYNA")).toBeInTheDocument();
    expect(screen.getByText("at least 0.25 " + short(CLMM.tokenB))).toBeInTheDocument();
    expect(screen.getByText("1 position · fees to claim on 1")).toBeInTheDocument();
  });

  it("accrued CLMM fees read plainly, with DMND's USD, and the summary adds the page total", async () => {
    const page = clmmPage();
    Object.assign(page.data[0], {
      claimable_basis: "accrued",
      claimable_at: "2026-09-14T11:59:45Z",
      claimable_value_usd: "4.5",
      fee_a: { mint: CLMM.tokenA, symbol: "SYNA", decimals: 9, ui_amount: "0.0015", value_usd: "4.5", price_source: "dmnd_pool_implied" },
    });
    page.page_known_claimable_value_usd = "4.5";
    serve({ "raydium-clmm": page });
    mount(CLMM.wallet, "raydium-clmm");
    expect(await screen.findByRole("button", { name: "Claim" })).toBeInTheDocument();
    expect(screen.getByText("0.0015 SYNA")).toBeInTheDocument();
    expect(screen.queryByText(/at least/)).toBeNull();
    expect(screen.getAllByText("($4.50)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("est.").length).toBeGreaterThan(0);
    expect(screen.getByText("1 position · fees to claim on 1 · claimable: $4.50")).toBeInTheDocument();
  });
});

describe("selection", () => {
  it("selecting 2 rows shows the count, DMND's exact fees and Claim fees (2)", async () => {
    await ownDamm();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    boxes.forEach((box) => fireEvent.click(box));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText("fees ≈ 2 SYNA + 0.25 " + short(DAMM.tokenB))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim fees (2)" })).toBeInTheDocument();

    buildsGroups();
    heldRun();
    fireEvent.click(screen.getByRole("button", { name: "Claim fees (2)" }));
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    const targets = build.buildClaimGroups.mock.calls[0][2] as { id: string }[];
    expect(targets.map((t) => t.id)).toEqual([R[0], R[1]]);
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("Clear empties the selection", async () => {
    await ownDamm();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("1 selected")).toBeNull();
  });
});

describe("claiming", () => {
  it("wires runAction to the build, the wallet and the live account", async () => {
    await ownDamm();
    buildsGroups();
    const run = heldRun();
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(build.createActionRpc).toHaveBeenCalledWith(new URL("/api/rpc", window.location.origin).href);
    const built = await build.buildClaimGroups.mock.results[0].value;
    const [rpc, owner, targets] = build.buildClaimGroups.mock.calls[0];
    expect(rpc).toBe(build.createActionRpc.mock.results[0].value);
    expect(owner).toBe(DAMM.wallet);
    expect(targets.map((t: { id: string }) => t.id)).toEqual([R[0]]);
    const options = run.options();
    expect(options.intent).toBe("claim");
    expect(options.groups).toBe(built.groups);
    expect(options.expectation).toBe(built.expectation);
    expect(options.rpc).toBe(rpc);
    expect(options.wallet.address).toBe(DAMM.wallet);
    expect(options.currentAddress()).toBe(DAMM.wallet);
    expect(options.shouldStop()).toBe(false);
    // Nothing else can start while a run is going.
    screen.getAllByRole("button", { name: "Claim" }).forEach((b) => expect(b).toBeDisabled());
  });

  it("Claim all fees claims every row with fees", async () => {
    await ownDamm();
    buildsGroups();
    heldRun();
    fireEvent.click(screen.getByRole("button", { name: "Claim all fees (2)" }));
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(build.buildClaimGroups.mock.calls[0][2].map((t: { id: string }) => t.id)).toEqual([R[0], R[1]]);
    expect(screen.getByText("Claiming fees from 2 positions")).toBeInTheDocument();
  });

  it("with more pages, Claim all fees loads every page first", async () => {
    const first = dammPage();
    first.has_more = true;
    first.cursor = "c2";
    first.coverage.total_positions = 4;
    const second = dammV2Page();
    second.data = [dammRow(4)];
    const fetch = serve({ "meteora-damm-v2": first, "meteora-damm-v2c2": second });
    mount(DAMM.wallet, "meteora-damm-v2");
    const button = await screen.findByRole("button", { name: "Claim all fees" });
    // Other pages may hold more fees: no count that would understate them (F-R003).
    expect(screen.getByText("4 positions")).toBeInTheDocument();
    expect(screen.queryByText(/fees to claim on/)).not.toBeInTheDocument();
    buildsGroups();
    heldRun();
    fireEvent.click(button);
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(
      `/api/wallet/${DAMM.wallet}/meteora-damm-v2?limit=50&cursor=c2`,
    );
    expect(build.buildClaimGroups.mock.calls[0][2].map((t: { id: string }) => t.id)).toEqual([R[0], R[1], R[3]]);
  });

  it("the progress panel shows each step's copy, stops on request and closes with Done", async () => {
    await ownDamm();
    build.buildClaimGroups.mockImplementation(async (_rpc, owner: string) => ({
      groups: [{ label: "claim", positionIds: [R[0], R[1]], instructions: [] }],
      skipped: [{ positionId: R[2], reason: "Position no longer exists" }],
      expectation: { kind: "claim", owner, mints: [], positions: [] },
    }));
    const run = heldRun();
    fireEvent.click(screen.getByRole("button", { name: "Claim all fees (2)" }));
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    const step = (index: number, status: ActionStep["status"], extra: Partial<ActionStep> = {}): ActionStep => ({
      index,
      label: "claim",
      positionIds: index === 1 ? [R[0], R[1]] : [R[0]],
      status,
      ...extra,
    });
    act(() =>
      run.options().onUpdate([
        step(1, "confirmed", {
          signature: SIG,
          slot: 7,
          expected: [
            { mint: DAMM.tokenA, atoms: "1500000000" },
            { mint: "So11111111111111111111111111111111111111112", atoms: "2000000" },
          ],
        }),
        step(2, "awaiting-approval"),
        step(3, "queued"),
        step(4, "failed", { reason: "Simulation failed · not sent" }),
        step(5, "skipped", { reason: "Nothing to claim" }),
        step(6, "stopped", { reason: "Wallet changed · stopped" }),
        step(7, "sending", { signature: SIG_2 }),
      ]),
    );
    const panel = screen.getByRole("region", { name: "Claiming fees from 2 positions" });
    const p = within(panel);
    expect(p.getByText("7 transactions · approve them in Phantom")).toBeInTheDocument();
    expect(p.getByText("Transaction 1 · 2 positions")).toBeInTheDocument();
    expect(p.getByText("Transaction 2 · 1 position")).toBeInTheDocument();
    expect(p.getByText("≈ 1.5 SYNA + 0.002 SOL")).toBeInTheDocument();
    expect(p.getByText("Confirmed")).toBeInTheDocument();
    expect(p.getByRole("link", { name: /Solscan/ })).toHaveAttribute("href", explorerHref("tx", SIG));
    expect(p.getByText("Waiting for your approval")).toBeInTheDocument();
    expect(p.getByText("Queued")).toBeInTheDocument();
    expect(p.getByText("Failed")).toBeInTheDocument();
    expect(p.getByText("Simulation failed · not sent")).toBeInTheDocument();
    expect(p.getByText("Nothing to claim")).toBeInTheDocument();
    expect(p.getByText("Wallet changed · stopped")).toBeInTheDocument();
    expect(p.getByText("Position no longer exists")).toBeInTheDocument();
    expect(
      p.getByText("If you stop or reject one, nothing is lost: those fees just stay unclaimed."),
    ).toBeInTheDocument();

    fireEvent.click(p.getByRole("button", { name: "Stop after this one" }));
    expect(run.options().shouldStop()).toBe(true);
    expect(p.queryByRole("button", { name: "Done" })).toBeNull();

    run.finish([step(1, "failed", { reason: "You declined in your wallet" })]);
    fireEvent.click(await p.findByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: /Claiming fees/ })).toBeNull();
  });

  it("a build failure ends the run with a plain message", async () => {
    await ownDamm();
    build.buildClaimGroups.mockRejectedValue(new Error("boom"));
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    expect(await screen.findByText("Couldn't load live pool data · try again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(build.runAction).not.toHaveBeenCalled();
  });

  it("an account switch mid-run reaches the runner and hides the actions", async () => {
    const { fake } = await ownDamm();
    buildsGroups();
    const run = heldRun();
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    act(() => fake!.switchAccount(OTHER));
    expect(run.options().currentAddress()).toBe(OTHER);
    expect(run.options().wallet.address).toBe(DAMM.wallet);
    await screen.findByText(/Viewing another wallet/);
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Claim all/ })).toBeNull();
  });
});

describe("after an action", () => {
  const pending = (kind: "claim" | "withdraw", at: number) =>
    window.localStorage.setItem(
      PENDING_ACTIONS_KEY,
      JSON.stringify({
        version: 1,
        actions: [{ wallet: DAMM.wallet, positionId: R[0], kind, signature: SIG, slot: 410000010, at }],
      }),
    );

  it("a just-claimed row says so, hides its fees and leaves the count", async () => {
    pending("claim", Date.now());
    serve({ "meteora-damm-v2": dammPage() });
    mount(DAMM.wallet, "meteora-damm-v2");
    expect(await screen.findByText("Just claimed · updating")).toBeInTheDocument();
    const row = rowOf("Just claimed · updating");
    expect(within(row).queryByText(/1\.5/)).toBeNull();
    expect(within(row).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(within(row).queryByRole("button", { name: "Claim" })).toBeNull();
    expect(screen.getByText("3 positions · fees to claim on 1")).toBeInTheDocument();
  });

  it("a just-withdrawn row says so", async () => {
    pending("withdraw", Date.now());
    serve({ "meteora-damm-v2": dammPage() });
    mount(DAMM.wallet, "meteora-damm-v2");
    expect(await screen.findByText("Withdrawn · updating")).toBeInTheDocument();
  });

  it("after 10 minutes it says DMND hasn't caught up and offers Refresh", async () => {
    pending("claim", Date.now() - 11 * 60_000);
    const fetch = serve({ "meteora-damm-v2": dammPage() });
    mount(DAMM.wallet, "meteora-damm-v2");
    expect(await screen.findByText("updating · DMND hasn't caught up yet")).toBeInTheDocument();
    const calls = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 1));
  });

  it("a fresh DMND row clears the record", async () => {
    pending("claim", Date.now());
    const page = dammPage();
    page.data[0].position_slot = 410000010;
    serve({ "meteora-damm-v2": page });
    mount(DAMM.wallet, "meteora-damm-v2");
    await screen.findAllByRole("button", { name: "Claim" });
    expect(screen.queryByText("Just claimed · updating")).toBeNull();
  });

  it("refetches on the backoff schedule after a confirmed claim", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetch } = await ownDamm();
    buildsGroups();
    build.runAction.mockImplementation(async (o: RunOptions) => {
      recordPending({ wallet: DAMM.wallet, positionId: R[0], kind: "claim", signature: SIG, slot: 410000010, at: Date.now() });
      const steps: ActionStep[] = [
        { index: 1, label: "claim", positionIds: [R[0]], status: "confirmed", signature: SIG, slot: 410000010 },
      ];
      o.onUpdate(steps);
      return steps;
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    expect(await screen.findByText("Just claimed · updating")).toBeInTheDocument();
    await screen.findByRole("button", { name: "Done" });
    const before = fetch.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(5_000));
    await waitFor(() => expect(fetch.mock.calls.length).toBe(before + 1));
    await act(async () => vi.advanceTimersByTime(10_000));
    await waitFor(() => expect(fetch.mock.calls.length).toBe(before + 2));
  });

  it("the backoff is 5, 10, 20, 40 s, then every 60 s, for at most 10 minutes", () => {
    const times = refetchTimes();
    expect(times.slice(0, 6)).toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    expect(times.at(-1)).toBeLessThanOrEqual(600_000);
    expect(times.at(-1)! + 60_000).toBeGreaterThan(600_000);
  });
});

describe("one run per page (fix round R-T11c)", () => {
  const NO_FEES = { fee_a_claimable_atoms: "0", fee_b_claimable_atoms: "0", rewards: [] };
  const claimAll = (name = "Claim all fees (2)") => fireEvent.click(screen.getByRole("button", { name }));

  it("collapsing and reopening mid-run keeps the panel and Stop, and blocks a second start", async () => {
    await ownDamm();
    buildsGroups();
    const run = heldRun();
    claimAll();
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Meteora DAMM v2" }));
    expect(screen.queryByRole("region", { name: /Claiming fees/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Meteora DAMM v2" }));
    // Shown while the reopened card is still loading its rows.
    expect(screen.getByRole("region", { name: "Claiming fees from 2 positions" })).toBeInTheDocument();
    const claims = await screen.findAllByRole("button", { name: "Claim" });
    claims.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole("button", { name: "Claim all fees (2)" })).toBeDisabled();
    fireEvent.click(claims[0]);
    claimAll();
    expect(build.buildClaimGroups).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop after this one" }));
    expect(run.options().shouldStop()).toBe(true);
  });

  it("a second card cannot start while one runs", async () => {
    const clmm = clmmPage();
    clmm.wallet = DAMM.wallet;
    serve({ "meteora-damm-v2": dammPage(), "raydium-clmm": clmm });
    connect(DAMM.wallet);
    render(
      <Shell enabled>
        <HeaderWallet viewed={DAMM.wallet} />
        {(["meteora-damm-v2", "raydium-clmm"] as const).map((resource) => (
          <ProtocolSection
            key={resource}
            address={DAMM.wallet}
            resource={resource}
            mode={{ kind: "live" }}
            labels={{}}
            defaultOpen
          />
        ))}
      </Shell>,
    );
    const other = within(document.getElementById("protocol-raydium-clmm")!);
    const otherClaimAll = await other.findByRole("button", { name: "Claim all fees (1)" });
    await screen.findByRole("button", { name: "Claim all fees (2)" });
    buildsGroups();
    heldRun();
    claimAll();
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(otherClaimAll).toBeDisabled();
    other.getAllByRole("button", { name: "Claim" }).forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(otherClaimAll);
    expect(build.buildClaimGroups).toHaveBeenCalledTimes(1);
    // Each card shows only its own run.
    expect(other.queryByRole("region", { name: /Claiming fees/ })).toBeNull();
  });

  it("paging is locked while the card's run goes", async () => {
    const first = dammPage();
    first.has_more = true;
    first.cursor = "c2";
    serve({ "meteora-damm-v2": first });
    mount(DAMM.wallet, "meteora-damm-v2");
    const next = await screen.findByRole("button", { name: "Next positions" });
    buildsGroups();
    const run = heldRun();
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    expect(next).toBeDisabled();
    run.finish([]);
    await waitFor(() => expect(next).toBeEnabled());
  });

  it("with more pages, Claim all fees shows even when this page has nothing to claim", async () => {
    const first = dammPage();
    first.data = [dammRow(3, NO_FEES)];
    first.has_more = true;
    first.cursor = "c2";
    serve({ "meteora-damm-v2": first });
    mount(DAMM.wallet, "meteora-damm-v2");
    expect(await screen.findByRole("button", { name: "Claim all fees" })).toBeEnabled();
    expect(screen.getByText("3 positions")).toBeInTheDocument();
    expect(screen.queryByText(/fees to claim on/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
  });

  it("Stop while pages load abandons them and says nothing was claimed", async () => {
    const first = dammPage();
    first.has_more = true;
    first.cursor = "c2";
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (!new URL(input, "http://doxxd.test").searchParams.has("cursor"))
          return Response.json({ ok: true, data: first });
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        );
      }),
    );
    mount(DAMM.wallet, "meteora-damm-v2");
    fireEvent.click(await screen.findByRole("button", { name: "Claim all fees" }));
    const panel = within(await screen.findByRole("region", { name: "Claiming fees from all positions" }));
    expect(panel.getByText("Loading every position…")).toBeInTheDocument();
    await waitFor(() => expect(signal).toBeDefined());
    fireEvent.click(panel.getByRole("button", { name: "Stop after this one" }));
    expect(signal!.aborted).toBe(true);
    expect(await panel.findByText("Nothing was claimed")).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(panel.queryByText("Couldn't load every position · try again")).toBeNull();
    expect(build.buildClaimGroups).not.toHaveBeenCalled();
  });

  it("when no position on any page has fees, it says nothing was claimed", async () => {
    const first = dammPage();
    first.data = [dammRow(3, NO_FEES)];
    first.has_more = true;
    first.cursor = "c2";
    const second = dammV2Page();
    second.data = [dammRow(4, NO_FEES)];
    serve({ "meteora-damm-v2": first, "meteora-damm-v2c2": second });
    mount(DAMM.wallet, "meteora-damm-v2");
    fireEvent.click(await screen.findByRole("button", { name: "Claim all fees" }));
    const panel = within(await screen.findByRole("region", { name: /Claiming fees/ }));
    expect(await panel.findByText("Nothing was claimed")).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(build.buildClaimGroups).not.toHaveBeenCalled();
  });

  it("announces the panel and moves focus to it, then back to Claim all", async () => {
    await ownDamm();
    const live = document.querySelector("#protocol-meteora-damm-v2 [aria-live='polite']");
    expect(live).toBeEmptyDOMElement();
    buildsGroups();
    const run = heldRun();
    claimAll();
    const heading = await screen.findByText("Claiming fees from 2 positions");
    expect(live).toContainElement(heading);
    await waitFor(() => expect(heading).toHaveFocus());
    run.finish([]);
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Claim all fees (2)" })).toHaveFocus();
  });
});

describe("fix round 2 (R-101..R-103)", () => {
  it("a sent but unconfirmed step never reads as nothing claimed", async () => {
    await ownDamm();
    buildsGroups();
    const run = heldRun();
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
    run.finish([
      {
        index: 1,
        label: "claim",
        positionIds: [R[0]],
        status: "failed",
        signature: SIG,
        reason: "Not confirmed yet · check your wallet before retrying",
      },
    ]);
    const panel = within(screen.getByRole("region", { name: /Claiming fees/ }));
    expect(await panel.findByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(panel.getByText("Not confirmed yet · check your wallet before retrying")).toBeInTheDocument();
    expect(panel.queryByText("Nothing was claimed")).toBeNull();
  });

  it("a new run on the same card takes focus again, even with the last panel open", async () => {
    await ownDamm();
    buildsGroups();
    const run = heldRun();
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    await waitFor(() => expect(screen.getByText("Claiming fees from 1 position")).toHaveFocus());
    run.finish([]);
    await screen.findByRole("button", { name: "Done" });
    const claim = screen.getAllByRole("button", { name: "Claim" })[1];
    claim.focus();
    fireEvent.click(claim);
    await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Claiming fees from 1 position")).toHaveFocus());
  });

  it("a card reopened just before a refetch tick keeps the backoff going", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let hold = false;
    const held: Array<() => void> = [];
    const fetch = vi.fn((input: string) => {
      void input;
      const answer = () => Response.json({ ok: true, data: dammPage() });
      return hold ? new Promise<Response>((resolve) => held.push(() => resolve(answer()))) : Promise.resolve(answer());
    });
    vi.stubGlobal("fetch", fetch);
    mount(DAMM.wallet, "meteora-damm-v2");
    await screen.findAllByRole("button", { name: "Claim" });
    buildsGroups();
    build.runAction.mockImplementation(async (o: RunOptions) => {
      recordPending({ wallet: DAMM.wallet, positionId: R[0], kind: "claim", signature: SIG, slot: 410000010, at: Date.now() });
      const steps: ActionStep[] = [
        { index: 1, label: "claim", positionIds: [R[0]], status: "confirmed", signature: SIG, slot: 410000010 },
      ];
      o.onUpdate(steps);
      return steps;
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    await screen.findByRole("button", { name: "Done" });
    // Reopen with the rows still loading when the 5 s tick fires.
    fireEvent.click(screen.getByRole("button", { name: "Collapse Meteora DAMM v2" }));
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Expand Meteora DAMM v2" }));
    await act(async () => vi.advanceTimersByTime(5_000));
    hold = false;
    await act(async () => held.splice(0).forEach((release) => release()));
    expect(await screen.findByText("Just claimed · updating")).toBeInTheDocument();
    const before = fetch.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(10_000));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("closing empty positions", () => {
  const EMPTY = { unlocked: "0", vested: "0", permanent_locked: "0", total: "0" };
  // Row 4: no liquidity at all, fees still to collect.
  function withEmptyRow(): Schemas["WalletMeteoraDammV2Positions"] {
    const page = dammPage();
    page.data.push(dammRow(4, { liquidity: EMPTY }));
    page.coverage.total_positions = 4;
    return page;
  }
  const closeButtons = () => screen.queryAllByRole("button", { name: "Close position" });

  it("offers Close position only on an empty DAMM v2 row of your own wallet", async () => {
    serve({ "meteora-damm-v2": withEmptyRow() });
    mount(DAMM.wallet, "meteora-damm-v2");
    await screen.findByText("Your wallet · Phantom");
    await waitFor(() => expect(closeButtons()).toHaveLength(1));
    const row = closeButtons()[0].closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "🔒 Locked" })).toBeNull();
  });

  it("offers nothing on another wallet's page", async () => {
    serve({ "meteora-damm-v2": withEmptyRow() });
    mount(DAMM.wallet, "meteora-damm-v2", { connected: OTHER });
    await screen.findByText(/Viewing another wallet/);
    expect(await screen.findByText("4 positions")).toBeInTheDocument();
    expect(closeButtons()).toHaveLength(0);
  });

  it("offers Close position on a CLMM row with no liquidity, but not with liquidity", async () => {
    const page = clmmPage();
    page.data[0] = { ...page.data[0], liquidity: "0" };
    serve({ "raydium-clmm": page });
    mount(CLMM.wallet, "raydium-clmm");
    expect(await screen.findByRole("button", { name: "Close position" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("opens the close dialog, and a closed row says so with no buttons", async () => {
    build.buildCloseGroups.mockImplementation(async (_rpc, owner: string) => ({
      groups: [],
      expectation: { kind: "close", owner, mints: [], positions: [] },
      refundLamports: "2000000",
    }));
    serve({ "meteora-damm-v2": withEmptyRow() });
    mount(DAMM.wallet, "meteora-damm-v2");
    await waitFor(() => expect(closeButtons()).toHaveLength(1));
    fireEvent.click(closeButtons()[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      await screen.findByText("Close this empty position? Its deposit (about 0.002 SOL) comes back to your wallet."),
    ).toBeInTheDocument();
    expect(build.runAction).not.toHaveBeenCalled();
  });

  it("a just-closed row reads Closed · updating and offers nothing", async () => {
    window.localStorage.setItem(
      PENDING_ACTIONS_KEY,
      JSON.stringify({
        version: 1,
        actions: [{ wallet: DAMM.wallet, positionId: R[3], kind: "close", signature: SIG, slot: 410000010, at: Date.now() }],
      }),
    );
    serve({ "meteora-damm-v2": withEmptyRow() });
    mount(DAMM.wallet, "meteora-damm-v2");
    const status = await screen.findByText("Closed · updating");
    const row = status.closest("tr")!;
    expect(within(row).queryByRole("button", { name: /Claim|Withdraw|Close position/ })).toBeNull();
    expect(closeButtons()).toHaveLength(0);
  });
});

describe("wrapped SOL on claims", () => {
  for (const unwraps of [true, false])
    it(`${unwraps ? "says" : "does not say"} wrapped SOL comes back as SOL when the claim ${unwraps ? "unwraps" : "doesn't unwrap"} it`, async () => {
      await ownDamm();
      buildsGroups();
      build.unwrapsWrappedSol.mockImplementation(() => unwraps);
      heldRun();
      fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[0]);
      await waitFor(() => expect(build.runAction).toHaveBeenCalledTimes(1));
      const panel = within(screen.getByRole("region", { name: "Claiming fees from 1 position" }));
      const note = panel.queryByText("Wrapped SOL in your wallet comes back as SOL too.");
      if (unwraps) expect(note).toBeInTheDocument();
      else expect(note).toBeNull();
      expect(build.unwrapsWrappedSol).toHaveBeenCalledWith(build.runAction.mock.calls[0][0].groups);
    });
});
