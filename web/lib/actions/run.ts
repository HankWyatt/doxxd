// Runs a wallet action: packs instruction groups into transactions, checks
// and simulates each, has the wallet sign them in prompts of up to 10,
// re-checks what the wallet signed, sends the signed bytes and confirms them
// by polling signature statuses (never a websocket).
//
// Safety rules (spec: "Review Focus"):
// - nothing reaches the wallet without passing the pre-sign check
//   (./verify.ts) and a successful simulation;
// - a signed transaction is sent only when its message is byte-for-byte the
//   one that was checked and simulated, and it passes the check again;
// - after a busy or failed send only the same signed bytes are re-sent;
//   nothing is ever rebuilt or re-signed for positions that may have landed;
// - "Didn't land · nothing changed" is reported only once the blockhash has
//   expired with no status for the signature: on two rounds whose status
//   answers came from a node at or past the slot where the expired height
//   was read, and then in a final lookup through the transaction history;
// - a send that /api/rpc's own limiter refused never left Doxxd: the same
//   signed bytes go again after its Retry-After (at most 10 s, 3 times);
// - simulated amounts are gross: the wallet's SOL change has this
//   transaction's own fee added back;
// - the run stops before any signing prompt or send when the visitor asks, or
//   when the wallet's account is no longer the one the run started with.
//
// Imports web3.js, so it is reached only through the lazy entry
// lib/actions/build/index.ts (ruling R-P4).
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  SendTransactionError,
  VersionedTransaction,
  type AccountInfo,
  type VersionedMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import { GroupTooLargeError, packGroups, partitionGroups, withComputeUnitLimit, type InstructionGroup } from "./pack";
import { recordPending } from "./pending";
import {
  COMPUTE_BUDGET_PROGRAM,
  MAX_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_PRICE,
  WSOL_MINT,
  type ActionKind,
} from "./programs";
import { isRpcBusy, notForwardedRetryMs, type ActionRpc, type SimulatedAccount } from "./rpc";
import { verifyMessage, type Expectation } from "./verify";
import type { ConnectedWallet } from "./wallet-session";

export type StepStatus = "queued" | "awaiting-approval" | "sending" | "confirmed" | "failed" | "skipped" | "stopped";

/** One transaction of the run. */
export type ActionStep = {
  /** The transaction's number in the run, from 1 ("Transaction {i}"). */
  index: number;
  label: string;
  positionIds: string[];
  status: StepStatus;
  /**
   * What the simulation says the wallet gains, per mint in atoms; SOL (owner
   * lamports plus any wSOL account's) is reported in lamports under the wSOL
   * mint. Only positive changes are listed.
   */
  expected?: { mint: string; atoms: string }[];
  signature?: string;
  slot?: number;
  reason?: string;
};

export type RunOptions = {
  groups: InstructionGroup[];
  expectation: Expectation;
  /** What the visitor clicked. The run refuses an expectation of another kind. */
  intent: ActionKind;
  wallet: ConnectedWallet;
  /** The wallet's live account (useCurrentAddress). */
  currentAddress: () => string | null;
  rpc: ActionRpc;
  /** Called with a fresh copy of every step after each change. */
  onUpdate: (steps: ActionStep[]) => void;
  /** Checked before each signing prompt and before each send. */
  shouldStop: () => boolean;
  /** Test seams; default to real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

// Fixed values (Global Constraints).
const CU_PRICE_FLOOR = 10_000;
const CU_PRICE_CAP = 200_000;
const MAX_FEE_ACCOUNTS = 128;
const CU_HEADROOM_FACTOR = 1.2;
const CU_HEADROOM_UNITS = 10_000;
const MAX_PER_PROMPT = 10;
const MAX_WATCHED = 16;
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 90_000;
const SEND_RETRY_DELAYS_MS = [500, 1_000, 2_000];
// Re-sends after /api/rpc's own limiter refused a send (nothing forwarded).
const LIMITER_RETRIES = 3;
const LIMITER_MAX_WAIT_MS = 10_000;
// Solana's base fee per signature.
const LAMPORTS_PER_SIGNATURE = BigInt(5_000);
// A blockhash with this few blocks of validity left is not shown to the
// wallet: signing alone can take longer.
const EXPIRY_MARGIN_BLOCKS = 10;
// SPL Token account layout: amount is a u64 at offset 64 of a 165-byte base.
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_AMOUNT_OFFSET = 64;

export const REASONS = {
  mismatch: "Doesn't match the action you chose · not sent",
  walletChanged: "Wallet changed · stopped",
  busy: "Network busy · try again",
  unexpected: "Something went wrong · not sent",
  tooLarge: "Too large for one transaction · not sent",
  tooManyTokens: "Too many tokens in one transaction · not sent",
  simulationFailed: "Simulation failed · not sent",
  nothingToClaim: "Nothing to claim",
  declined: "You declined in your wallet",
  walletError: "Your wallet couldn't sign · nothing sent",
  walletChangedTx: "Your wallet changed the transaction · not sent",
  rejected: "Rejected by the network · not sent",
  failedOnChain: "Failed on chain · nothing changed",
  expired: "Didn't land · nothing changed",
  unconfirmed: "Not confirmed yet · check your wallet before retrying",
} as const;

const blocked = (detail: string) => `Blocked by the safety check: ${detail} · not sent`;
const plainReason = (error: unknown) => (isRpcBusy(error) ? REASONS.busy : REASONS.unexpected);
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** max(p75, 10,000) capped at 200,000 µlamports, by nearest rank. */
export function computeUnitPrice(fees: number[]): number {
  const sorted = fees.filter((fee) => Number.isFinite(fee) && fee >= 0).sort((a, b) => a - b);
  const p75 = sorted.length ? sorted[Math.ceil(sorted.length * 0.75) - 1] : 0;
  return Math.min(CU_PRICE_CAP, Math.max(CU_PRICE_FLOOR, Math.ceil(p75)));
}

function writableAccounts(groups: InstructionGroup[]): string[] {
  const out = new Set<string>();
  for (const group of groups)
    for (const ix of group.instructions) for (const key of ix.keys) if (key.isWritable) out.add(key.pubkey.toBase58());
  return [...out].slice(0, MAX_FEE_ACCOUNTS);
}

function declinedByVisitor(error: unknown): boolean {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (e?.code === 4001) return true;
  const text = `${typeof e?.name === "string" ? e.name : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  return /reject|declin|denied|cancel/i.test(text);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The RPC refuses a duplicate of a transaction it has already processed.
function alreadyProcessed(error: unknown): boolean {
  return /already been processed|AlreadyProcessed/i.test(errorText(error));
}

// The RPC answered and refused to forward: a JSON-RPC error (preflight,
// blockhash not found, bad signature) arrives as SendTransactionError, and a
// pass-through refusal as web3.js's "4xx Status: body" error. Any other
// failure (a broken response) leaves it unknown whether the transaction went
// out, so the runner polls for it rather than call it not sent.
function refused(error: unknown): boolean {
  return error instanceof SendTransactionError || /^4\d\d /.test(errorText(error));
}

// Preflight's answer for a blockhash the node no longer (or not yet) knows.
function blockhashNotFound(error: unknown): boolean {
  return /blockhash not found/i.test(errorText(error));
}

// Watched balances for one message: the owner, then the owner's ATA of each
// expected mint that the message references (tokens can reach the wallet
// only through those; see ./verify.ts).
type Watch = { addresses: string[]; tokens: { mint: string; program: string; index: number }[]; wsolIndex: number | null };

function watchFor(message: VersionedMessage, expectation: Expectation): Watch {
  const owner = new PublicKey(expectation.owner);
  const keys = new Set(message.staticAccountKeys.map((key) => key.toBase58()));
  const watch: Watch = { addresses: [expectation.owner], tokens: [], wsolIndex: null };
  const seen = new Set<string>();
  for (const { mint, tokenProgram } of expectation.mints) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, new PublicKey(tokenProgram)).toBase58();
    if (!keys.has(ata) || seen.has(ata)) continue;
    seen.add(ata);
    const index = watch.addresses.push(ata) - 1;
    if (mint === WSOL_MINT) watch.wsolIndex = index;
    else watch.tokens.push({ mint, program: tokenProgram, index });
  }
  return watch;
}

type Balance = { data: Uint8Array; lamports: number; owner: string } | null;

function tokenAmount(account: Balance, program: string): bigint {
  if (!account || account.owner !== program || account.data.length < TOKEN_ACCOUNT_SIZE) return BigInt(0);
  return Buffer.from(account.data).readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}
const lamportsOf = (account: Balance) => BigInt(account?.lamports ?? 0);

/**
 * The fee the payer pays for `message`: 5,000 lamports per required
 * signature, plus compute-unit price × compute-unit limit / 1,000,000,
 * rounded up (no SetComputeUnitPrice: no priority fee).
 */
export function transactionFee(message: VersionedMessage): bigint {
  const keys = message.staticAccountKeys;
  let units = BigInt(0);
  let price = BigInt(0);
  for (const ix of message.compiledInstructions) {
    if (keys[ix.programIdIndex]?.toBase58() !== COMPUTE_BUDGET_PROGRAM) continue;
    const data = Buffer.from(ix.data);
    if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5) units = BigInt(data.readUInt32LE(1));
    if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9) price = data.readBigUInt64LE(1);
  }
  const million = BigInt(1_000_000);
  const priority = (price * units + million - BigInt(1)) / million;
  return LAMPORTS_PER_SIGNATURE * BigInt(message.header.numRequiredSignatures) + priority;
}

// Gross deltas: `fee` (what the payer, the owner, pays for this transaction)
// is added back to the SOL change, so the amounts show what the action pays
// out, and a small SOL claim is not read as nothing.
function deltas(watch: Watch, pre: Balance[], post: Balance[], fee: bigint): { mint: string; atoms: string }[] {
  const out: { mint: string; atoms: string }[] = [];
  for (const { mint, program, index } of watch.tokens) {
    const delta = tokenAmount(post[index], program) - tokenAmount(pre[index], program);
    if (delta > BigInt(0)) out.push({ mint, atoms: delta.toString() });
  }
  // SOL: the owner's lamports plus the wSOL ATA's (created, filled and
  // closed in the same transaction, it is absent before and after).
  const sol = (balances: Balance[]) =>
    lamportsOf(balances[0]) + (watch.wsolIndex === null ? BigInt(0) : lamportsOf(balances[watch.wsolIndex]));
  const solDelta = sol(post) - sol(pre) + fee;
  if (solDelta > BigInt(0)) out.push({ mint: WSOL_MINT, atoms: solDelta.toString() });
  return out;
}

const preBalance = (info: AccountInfo<Buffer> | null): Balance =>
  info && info.lamports > 0 ? { data: info.data, lamports: info.lamports, owner: info.owner.toBase58() } : null;
const postBalance = (account: SimulatedAccount): Balance => account;

type Prepared =
  | { ok: true; message: VersionedMessage; bytes: Uint8Array; expected: { mint: string; atoms: string }[] }
  | { ok: false; status: "failed" | "skipped"; reason: string };

export async function runAction(options: RunOptions): Promise<ActionStep[]> {
  const { groups, expectation, intent, wallet, currentAddress, rpc, onUpdate, shouldStop } = options;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  let steps: ActionStep[] = [];

  // A throwing progress callback must never stop the run part-way.
  const publish = () => {
    try {
      onUpdate(
        steps.map((step) => ({
          ...step,
          positionIds: [...step.positionIds],
          ...(step.expected ? { expected: step.expected.map((e) => ({ ...e })) } : {}),
        })),
      );
    } catch {
      // The UI missed one update; the next one carries the full state.
    }
  };
  const set = (i: number, patch: Partial<ActionStep>) => {
    steps[i] = { ...steps[i], ...patch };
    publish();
  };
  const finishAll = (status: "failed" | "stopped", reason: string) => {
    steps = groups.map((group, i) => ({
      index: i + 1,
      label: group.label,
      positionIds: [...group.positionIds],
      status,
      reason,
    }));
    publish();
    return steps;
  };
  // Every step not yet sent or finished becomes stopped.
  const stopRemaining = (reason?: string) => {
    steps = steps.map((step) =>
      step.status === "queued" || step.status === "awaiting-approval"
        ? { ...step, status: "stopped", ...(reason ? { reason } : {}) }
        : step,
    );
    publish();
  };
  const walletChanged = () => currentAddress() !== wallet.address;
  // Stops the run when the visitor asked to, or the wallet's account changed:
  // every step not yet sent or finished becomes stopped. Synchronous.
  const haltRun = (): boolean => {
    if (shouldStop()) {
      stopRemaining();
      return true;
    }
    if (walletChanged()) {
      stopRemaining(REASONS.walletChanged);
      return true;
    }
    return false;
  };

  if (groups.length === 0) return [];
  // Ruling R-T7a: the expectation must be what the visitor clicked.
  if (expectation.kind !== intent) return finishAll("failed", REASONS.mismatch);
  if (expectation.owner !== wallet.address || walletChanged()) return finishAll("stopped", REASONS.walletChanged);

  // How the groups split into transactions. Sizes don't depend on the
  // blockhash or the price, so this holds for every prompt's fresh values.
  let parts: InstructionGroup[][];
  try {
    parts = partitionGroups(groups, new PublicKey(wallet.address));
  } catch (error) {
    return finishAll("failed", error instanceof GroupTooLargeError ? REASONS.tooLarge : plainReason(error));
  }
  steps = parts.map((part, i) => ({
    index: i + 1,
    label: part.map((g) => g.label).join(", "),
    positionIds: part.flatMap((g) => g.positionIds),
    status: "queued",
  }));
  publish();

  // Check and simulate one message: verify; simulate; lower the compute-unit
  // limit; verify and simulate again, watching the wallet's balances.
  const prepare = async (message: VersionedMessage): Promise<Prepared> => {
    const fail = (reason: string): Prepared => ({ ok: false, status: "failed", reason });
    let check = verifyMessage(message, expectation);
    if (!check.ok) return fail(blocked(check.reason));
    try {
      const first = await rpc.simulate(new VersionedTransaction(message));
      if (first.err) return fail(REASONS.simulationFailed);
      const units =
        first.unitsConsumed === null
          ? MAX_COMPUTE_UNIT_LIMIT
          : Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.ceil(first.unitsConsumed * CU_HEADROOM_FACTOR) + CU_HEADROOM_UNITS);
      const final = withComputeUnitLimit(message, units);
      check = verifyMessage(final, expectation);
      if (!check.ok) return fail(blocked(check.reason));
      const watch = watchFor(final, expectation);
      if (watch.addresses.length > MAX_WATCHED) return fail(REASONS.tooManyTokens);
      const before = await rpc.connection.getMultipleAccountsInfo(
        watch.addresses.map((address) => new PublicKey(address)),
        "confirmed",
      );
      const second = await rpc.simulate(new VersionedTransaction(final), watch.addresses);
      if (second.err) return fail(REASONS.simulationFailed);
      const expected = deltas(watch, before.map(preBalance), second.accounts.map(postBalance), transactionFee(final));
      if (expectation.kind === "claim" && expected.length === 0)
        return { ok: false, status: "skipped", reason: REASONS.nothingToClaim };
      return { ok: true, message: final, bytes: new VersionedTransaction(final).serialize(), expected };
    } catch (error) {
      return fail(plainReason(error));
    }
  };

  const heightPast = async (lastValidBlockHeight: number): Promise<boolean> => {
    try {
      return (await rpc.blockHeight()) > lastValidBlockHeight;
    } catch {
      return false;
    }
  };

  // Sends `raw` until the RPC accepts it, re-sending only these bytes after a
  // busy error. "rejected", "expired" and "busy" mean it certainly never
  // left; "unknown" means it may have reached the network.
  const send = async (
    raw: Uint8Array,
    lastValidBlockHeight: number,
  ): Promise<"sent" | "unknown" | "rejected" | "expired" | "busy"> => {
    let mayHaveReached = false;
    let limiterRetries = 0;
    for (let attempt = 0; ; ) {
      try {
        await rpc.send(raw);
        return "sent";
      } catch (error) {
        if (alreadyProcessed(error)) return "sent";
        // Refused by /api/rpc's own limiter: nothing was forwarded, so the
        // same bytes simply go again once it allows.
        const wait = notForwardedRetryMs(error);
        if (wait !== null) {
          if (limiterRetries >= LIMITER_RETRIES) return mayHaveReached ? "unknown" : "busy";
          limiterRetries++;
          await sleep(Math.min(wait, LIMITER_MAX_WAIT_MS));
          continue;
        }
        if (!isRpcBusy(error)) {
          if (!refused(error) || mayHaveReached) return "unknown";
          // Preflight refuses an expired blockhash; so is any refusal once
          // the height has passed the blockhash's last valid height.
          if (blockhashNotFound(error) || (await heightPast(lastValidBlockHeight))) return "expired";
          return "rejected";
        }
        mayHaveReached = true;
        if (attempt >= SEND_RETRY_DELAYS_MS.length) return "unknown";
        await sleep(SEND_RETRY_DELAYS_MS[attempt]);
        attempt++;
      }
    }
  };

  const confirmed = (step: number, signature: string, slot: number) => {
    // Recorded before the progress update, so a failing UI callback can never
    // drop a pending record.
    for (const positionId of steps[step].positionIds)
      recordPending({ wallet: wallet.address, positionId, kind: expectation.kind, signature, slot, at: now() });
    set(step, { status: "confirmed", slot });
  };

  // Polls until each signature is confirmed or failed, the blockhash has
  // expired without it, or 90 s pass. Expiry (ruling S-R003) needs:
  // - the block height past the last valid height, read together with its
  //   slot (getEpochInfo);
  // - no status on two rounds whose answer came from a node at or past that
  //   slot (a lagging status node proves nothing);
  // - then no status in one final lookup through the transaction history.
  const confirm = async (inFlight: Map<string, number>, lastValidBlockHeight: number) => {
    const start = now();
    const missingAfterExpiry = new Set<string>();
    type Status = Awaited<ReturnType<ActionRpc["statuses"]>>["value"][number];
    // Applies a status; true when it settled the signature.
    const settle = (signature: string, status: Status): boolean => {
      const step = inFlight.get(signature)!;
      if (status?.err) {
        set(step, { status: "failed", reason: REASONS.failedOnChain, slot: status.slot });
      } else if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        confirmed(step, signature, status.slot);
      } else return false;
      inFlight.delete(signature);
      return true;
    };
    // The final history lookup for signatures that look expired: only a
    // reply from a node at or past `slot` with no status means it can no
    // longer land.
    const expireUnlessFound = async (signatures: string[], slot: number) => {
      let history: Awaited<ReturnType<ActionRpc["statuses"]>> | null = null;
      try {
        history = await rpc.statuses(signatures, { searchTransactionHistory: true });
      } catch {
        return; // Unknown: keep polling.
      }
      if (history.contextSlot < slot) return;
      signatures.forEach((signature, k) => {
        const status = history.value[k] ?? null;
        if (settle(signature, status)) return;
        if (status) {
          missingAfterExpiry.delete(signature);
          return;
        }
        set(inFlight.get(signature)!, { status: "failed", reason: REASONS.expired });
        inFlight.delete(signature);
      });
    };
    while (inFlight.size > 0) {
      // Height first: a signature with no status at a height past the
      // blockhash's last valid height can no longer land.
      let tip: { blockHeight: number; slot: number } | null = null;
      try {
        tip = await rpc.chainTip();
      } catch {
        // Unknown this round.
      }
      const signatures = [...inFlight.keys()];
      let found: Awaited<ReturnType<ActionRpc["statuses"]>> | null = null;
      try {
        found = await rpc.statuses(signatures);
      } catch {
        // Unknown this round.
      }
      if (found) {
        const expired =
          tip !== null && tip.blockHeight > lastValidBlockHeight && found.contextSlot >= tip.slot;
        const lookUp: string[] = [];
        signatures.forEach((signature, k) => {
          const status = found.value[k] ?? null;
          if (settle(signature, status)) return;
          if (status) missingAfterExpiry.delete(signature);
          else if (expired) {
            if (missingAfterExpiry.has(signature)) lookUp.push(signature);
            else missingAfterExpiry.add(signature);
          }
        });
        if (lookUp.length > 0) await expireUnlessFound(lookUp, tip!.slot);
      }
      if (inFlight.size === 0) break;
      if (now() - start >= POLL_TIMEOUT_MS) {
        for (const step of inFlight.values()) set(step, { status: "failed", reason: REASONS.unconfirmed });
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };

  // Fetches a blockhash and a priority fee for these steps, then packs,
  // checks and simulates each. Null when the reads fail (the steps are
  // failed); otherwise the messages ready for the wallet.
  type Ready = { step: number; message: VersionedMessage; bytes: Uint8Array };
  const prepareChunk = async (
    entries: { step: number; part: InstructionGroup[] }[],
  ): Promise<{ ready: Ready[]; lastValidBlockHeight: number } | null> => {
    let blockhash: string;
    let lastValidBlockHeight: number;
    let cuPrice: number;
    try {
      const [latest, fees] = await Promise.all([
        rpc.latestBlockhash(),
        rpc.priorityFees(writableAccounts(entries.flatMap(({ part }) => part))),
      ]);
      ({ blockhash, lastValidBlockHeight } = latest);
      cuPrice = computeUnitPrice(fees);
    } catch (error) {
      for (const { step } of entries) set(step, { status: "failed", reason: plainReason(error) });
      return null;
    }
    const ready: Ready[] = [];
    for (const { step, part } of entries) {
      let packed: ReturnType<typeof packGroups>;
      try {
        packed = packGroups(part, new PublicKey(wallet.address), blockhash, cuPrice);
      } catch {
        packed = [];
      }
      if (packed.length !== 1) {
        set(step, { status: "failed", reason: REASONS.tooLarge });
        continue;
      }
      const result = await prepare(packed[0].message);
      if (result.ok) {
        set(step, { expected: result.expected });
        ready.push({ step, message: result.message, bytes: result.bytes });
      } else set(step, { status: result.status, reason: result.reason });
    }
    return { ready, lastValidBlockHeight };
  };

  // True when the blockhash has at most EXPIRY_MARGIN_BLOCKS blocks of
  // validity left. An unreadable height counts as not expired: the checks
  // after the prompt and on send still apply.
  const nearlyExpired = async (lastValidBlockHeight: number): Promise<boolean> => {
    try {
      return lastValidBlockHeight - (await rpc.blockHeight()) <= EXPIRY_MARGIN_BLOCKS;
    } catch {
      return false;
    }
  };

  // Ruling R-T7d: each prompt of up to 10 transactions is prepared just
  // before it opens, with its own blockhash and priority fee, so nothing the
  // wallet is shown has waited behind an earlier prompt.
  for (let c = 0; c < parts.length; c += MAX_PER_PROMPT) {
    const chunk = parts.slice(c, c + MAX_PER_PROMPT).map((part, k) => ({ step: c + k, part }));
    if (haltRun()) break;

    // 1-3. Blockhash and fee for this prompt, then pack, check, simulate.
    let prepared = await prepareChunk(chunk);
    if (!prepared || prepared.ready.length === 0) continue;

    // Preparation reads the RPC several times per message. If that outlived
    // (or nearly outlived) the blockhash, prepare once more with a fresh one;
    // the wallet is never shown messages that can no longer land.
    if (await nearlyExpired(prepared.lastValidBlockHeight)) {
      if (haltRun()) break;
      const stillReady = new Set(prepared.ready.map(({ step }) => step));
      prepared = await prepareChunk(chunk.filter(({ step }) => stillReady.has(step)));
      if (!prepared || prepared.ready.length === 0) continue;
      if (await nearlyExpired(prepared.lastValidBlockHeight)) {
        for (const { step } of prepared.ready) set(step, { status: "failed", reason: REASONS.expired });
        continue;
      }
    }
    const { ready, lastValidBlockHeight } = prepared;
    for (const { step } of ready) set(step, { status: "awaiting-approval" });

    // 4. One wallet prompt for the chunk. The stop and account checks come
    // last, with no await between them and the prompt.
    if (haltRun()) break;
    let signed: Uint8Array[];
    try {
      signed = await wallet.signTransactions(ready.map(({ bytes }) => Uint8Array.from(bytes)));
    } catch (error) {
      if (walletChanged()) stopRemaining(REASONS.walletChanged);
      else {
        const reason = declinedByVisitor(error) ? REASONS.declined : REASONS.walletError;
        for (const { step } of ready) set(step, { status: "stopped", reason });
        stopRemaining();
      }
      break;
    }

    // 5. Only the exact checked message, still passing the check, is sent.
    const toSend: { step: number; raw: Uint8Array; signature: string }[] = [];
    ready.forEach(({ step, message }, k) => {
      const raw = signed.length === ready.length ? signed[k] : undefined;
      let tx: VersionedTransaction | null = null;
      try {
        if (raw) tx = VersionedTransaction.deserialize(raw);
      } catch {
        tx = null;
      }
      const same =
        tx !== null &&
        tx.signatures.length === 1 &&
        Buffer.from(tx.message.serialize()).equals(Buffer.from(message.serialize())) &&
        verifyMessage(tx.message, expectation).ok;
      if (!tx || !raw || !same) {
        set(step, { status: "failed", reason: REASONS.walletChangedTx });
        return;
      }
      toSend.push({ step, raw: Uint8Array.from(raw), signature: bs58.encode(tx.signatures[0]) });
      set(step, { status: "queued" });
    });

    // The visitor may have left the prompt open past the blockhash's life:
    // nothing was sent, so nothing changed. The next prompt starts afresh.
    if (toSend.length > 0 && (await heightPast(lastValidBlockHeight))) {
      for (const { step } of toSend) set(step, { status: "failed", reason: REASONS.expired });
      continue;
    }

    // 6-7. Send one at a time, checking for a stop before each.
    const inFlight = new Map<string, number>();
    let halted = false;
    for (const { step, raw, signature } of toSend) {
      if (shouldStop()) {
        stopRemaining();
        halted = true;
        break;
      }
      if (walletChanged()) {
        stopRemaining(REASONS.walletChanged);
        halted = true;
        break;
      }
      set(step, { status: "sending", signature });
      const outcome = await send(raw, lastValidBlockHeight);
      if (outcome === "rejected") set(step, { status: "failed", reason: REASONS.rejected });
      else if (outcome === "expired") set(step, { status: "failed", reason: REASONS.expired });
      else if (outcome === "busy") set(step, { status: "failed", reason: REASONS.busy });
      else inFlight.set(signature, step);
    }
    await confirm(inFlight, lastValidBlockHeight);
    if (halted) break;
  }
  return steps;
}
