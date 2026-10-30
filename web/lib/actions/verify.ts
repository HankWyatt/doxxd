// The pre-sign check. Every message is checked here before the wallet sees
// it, and again after the wallet signs it. A message passes only when it
// can do nothing but the allowed LP actions for the connected wallet:
// - no address-table lookups, so every account is visible here;
// - the wallet is the fee payer and the only signer;
// - only the programs in ./programs.ts at the top level (never System or
//   Memo);
// - capped compute budget;
// - ATA creates only of the wallet's own ATAs of expected mints;
// - Token / Token-2022 only CloseAccount of those ATAs, to the wallet;
// - protocol instructions only from ALLOWED_INSTRUCTIONS, with their
//   paid-out tokens, rent and position NFTs checked by role;
// - only the instructions the visitor's action kind allows: a claim only
//   collects (no liquidity removed, no position closed), and every
//   withdrawal that removes liquidity carries a non-zero minimum;
// - in a withdraw, each liquidity removal takes exactly what the visitor
//   chose: the expected pool (and LP account, for CPMM and AMM v4), the
//   exact amount (or all, for remove_all_liquidity) and the exact minimums,
//   at most once per position; a position is closed only when the
//   withdrawal closes it;
// - a close acts only on listed DAMM v2 and CLMM positions: it may collect
//   (as a claim does), refresh vesting and close each listed position once,
//   and never removes liquidity;
// - every close_position names the position account listed with its
//   position NFT account, and pays the rent to the wallet.
// The wallet's ATAs are derived here from the expected mints, never taken
// from the builder.
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type VersionedMessage } from "@solana/web3.js";
import {
  ALLOWED_INSTRUCTIONS,
  ALLOWED_PROGRAMS,
  AMM_V4_PROGRAM,
  ATA_CREATE,
  ATA_CREATE_IDEMPOTENT,
  ATA_PROGRAM,
  CLMM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_PRICE,
  SET_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_PRICE,
  TOKEN_2022_PROGRAM,
  TOKEN_CLOSE_ACCOUNT,
  TOKEN_PROGRAM,
  TOKEN_PROGRAMS,
  type AccountRole,
  type ActionKind,
  type InstructionArgs,
  type InstructionSpec,
} from "./programs";
import type { ActionProtocol } from "./types";

export type Expectation = {
  /** What the visitor asked for. */
  kind: ActionKind;
  /** The connected wallet. */
  owner: string;
  /** Mints the wallet may receive, each with its token program. */
  mints: { mint: string; tokenProgram: string }[];
  /** Positions the transaction may act on. */
  positions: ExpectedPosition[];
};

export type ExpectedPosition = {
  position: string;
  nftAccount: string;
  protocol: ActionProtocol;
  /**
   * In a withdraw: exactly what the visitor chose, filled by the builder
   * from its own computed values (never read back from an instruction).
   * A liquidity removal or close of a position without it is refused.
   */
  withdraw?: WithdrawExpectation;
};

export type WithdrawExpectation = {
  pool: string;
  /** The LP token account burned from (CPMM and AMM v4 only). */
  lpAccount?: string;
  /** Exact liquidity delta (DAMM v2, CLMM) or LP amount (CPMM, AMM v4). */
  amount: string;
  /** DAMM v2 remove_all_liquidity instead of remove_liquidity(amount). */
  removeAll?: boolean;
  minimums: [string, string];
  closes: boolean;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

class Rejected extends Error {}

function reject(reason: string): never {
  throw new Rejected(reason);
}

type Context = {
  message: VersionedMessage;
  kind: ActionKind;
  keys: string[];
  owner: string;
  mints: Set<string>;
  /** The wallet's ATA → its mint and token program. */
  ownerAtas: Map<string, { mint: string; program: string }>;
  /** Position NFT account → the protocols it is expected under. */
  nftAccounts: Map<string, Set<ActionProtocol>>;
  computeUnitLimit: boolean;
  computeUnitPrice: boolean;
  positions: ExpectedPosition[];
  /** Positions (protocol:nftAccount) this message already removes from or closes. */
  removed: Set<string>;
  closed: Set<string>;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const TOKEN_LABEL: Record<string, string> = { [TOKEN_PROGRAM]: "Token", [TOKEN_2022_PROGRAM]: "Token-2022" };
const CLMM_BITMAP_SEED = new TextEncoder().encode("pool_tick_array_bitmap_extension");
/** Protocols whose empty positions a close may close. */
const CLOSABLE: readonly ActionProtocol[] = ["meteora-damm-v2", "raydium-clmm"];

export function verifyMessage(message: VersionedMessage, expect: Expectation): VerifyResult {
  try {
    check(message, expect);
    return { ok: true };
  } catch (error) {
    if (error instanceof Rejected) return { ok: false, reason: error.message };
    return { ok: false, reason: "the transaction could not be checked" };
  }
}

function check(message: VersionedMessage, expect: Expectation): void {
  if (message.addressTableLookups.length > 0) reject("address-table lookups are not allowed");
  if (expect.kind !== "claim" && expect.kind !== "withdraw" && expect.kind !== "close") reject("unknown action kind");
  if (expect.kind === "close")
    for (const p of expect.positions) {
      if (!CLOSABLE.includes(p.protocol)) reject(`a close cannot act on a ${p.protocol} position`);
      if (p.withdraw) reject("a close cannot carry a withdrawal");
    }

  const owner = parseOwner(expect.owner);
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  if (keys[0] !== owner.toBase58()) reject("fee payer is not the connected wallet");
  const signatures = message.header.numRequiredSignatures;
  if (signatures !== 1)
    reject(`only the connected wallet may sign (the message needs ${signatures} signatures)`);
  if (new Set(keys).size !== keys.length) reject("duplicate account key");

  const ctx: Context = {
    message,
    kind: expect.kind,
    keys,
    owner: owner.toBase58(),
    mints: new Set(expect.mints.map((m) => m.mint)),
    ownerAtas: new Map(),
    nftAccounts: new Map(),
    computeUnitLimit: false,
    computeUnitPrice: false,
    positions: expect.positions,
    removed: new Set(),
    closed: new Set(),
  };
  for (const { mint, tokenProgram } of expect.mints) {
    if (!TOKEN_PROGRAMS.includes(tokenProgram))
      reject(`expected mint ${mint} has unknown token program ${tokenProgram}`);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, new PublicKey(tokenProgram));
    ctx.ownerAtas.set(ata.toBase58(), { mint, program: tokenProgram });
  }
  for (const { nftAccount, protocol } of expect.positions) {
    const protocols = ctx.nftAccounts.get(nftAccount) ?? new Set<ActionProtocol>();
    protocols.add(protocol);
    ctx.nftAccounts.set(nftAccount, protocols);
  }

  message.compiledInstructions.forEach((ix, n) => {
    const program = keys[ix.programIdIndex];
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]);
    if (program === undefined || accounts.some((a) => a === undefined))
      reject(`instruction ${n} references a missing account`);
    const data = ix.data;

    if (!ALLOWED_PROGRAMS.includes(program)) reject(`program ${program} is not allowed`);
    if (program === COMPUTE_BUDGET_PROGRAM) checkComputeBudget(ctx, data);
    else if (program === ATA_PROGRAM) checkAtaCreate(ctx, accounts, data);
    else if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM)
      checkCloseAccount(ctx, program, accounts, data);
    else checkProtocol(ctx, program, ix.accountKeyIndexes, accounts, data);
  });
}

function parseOwner(owner: string): PublicKey {
  let key: PublicKey;
  try {
    key = new PublicKey(owner);
  } catch {
    reject("owner is not a valid wallet address");
  }
  if (!PublicKey.isOnCurve(key.toBytes())) reject("owner is not a valid wallet address");
  return key;
}

function checkComputeBudget(ctx: Context, data: Uint8Array): void {
  const tag = data[0];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (tag === SET_COMPUTE_UNIT_LIMIT) {
    if (data.length !== 5) reject(`Compute Budget instruction ${tag} is malformed`);
    if (ctx.computeUnitLimit) reject("more than one SetComputeUnitLimit");
    ctx.computeUnitLimit = true;
    const units = view.getUint32(1, true);
    if (units > MAX_COMPUTE_UNIT_LIMIT)
      reject(`compute-unit limit ${units} is above ${MAX_COMPUTE_UNIT_LIMIT}`);
  } else if (tag === SET_COMPUTE_UNIT_PRICE) {
    if (data.length !== 9) reject(`Compute Budget instruction ${tag} is malformed`);
    if (ctx.computeUnitPrice) reject("more than one SetComputeUnitPrice");
    ctx.computeUnitPrice = true;
    const price = view.getBigUint64(1, true);
    if (price > BigInt(MAX_COMPUTE_UNIT_PRICE))
      reject(`compute-unit price ${price} is above ${MAX_COMPUTE_UNIT_PRICE} µlamports`);
  } else {
    reject(`Compute Budget instruction ${tag ?? "(empty)"} is not allowed`);
  }
}

// Accounts: payer, associated account, wallet, mint, System program, token program.
function checkAtaCreate(ctx: Context, accounts: string[], data: Uint8Array): void {
  const kind = data.length === 0 ? ATA_CREATE : data.length === 1 ? data[0] : -1;
  if (kind !== ATA_CREATE && kind !== ATA_CREATE_IDEMPOTENT)
    reject(`ATA instruction ${data[0]} is not allowed`);
  if (accounts.length !== 6) reject(`ATA create has ${accounts.length} accounts; expected 6`);
  const [payer, ata, wallet, mint, , tokenProgram] = accounts;
  if (payer !== ctx.owner) reject("ATA create payer is not the connected wallet");
  if (wallet !== ctx.owner) reject("ATA create wallet is not the connected wallet");
  if (!ctx.mints.has(mint)) reject(`ATA create for unexpected mint ${mint}`);
  const own = ctx.ownerAtas.get(ata);
  if (!own || own.mint !== mint || own.program !== tokenProgram)
    reject(`ATA create account is not the connected wallet's ATA of ${mint}`);
}

// Accounts: account, destination, owner (authority).
function checkCloseAccount(ctx: Context, program: string, accounts: string[], data: Uint8Array): void {
  const label = TOKEN_LABEL[program];
  if (data.length !== 1 || data[0] !== TOKEN_CLOSE_ACCOUNT)
    reject(`${label} instruction ${data[0] ?? "(empty)"} is not allowed`);
  if (accounts.length !== 3) reject("CloseAccount must have exactly 3 accounts");
  const [account, destination, authority] = accounts;
  if (ctx.nftAccounts.has(account)) reject("CloseAccount on a position NFT account");
  if (ctx.ownerAtas.get(account)?.program !== program)
    reject("CloseAccount account is not the connected wallet's token account of an expected mint");
  if (destination !== ctx.owner) reject("CloseAccount destination is not the connected wallet");
  if (authority !== ctx.owner) reject("CloseAccount authority is not the connected wallet");
}

// An instruction with several allowed account forms (AMM v4 withdraw: 22 or
// 11 accounts) has one spec per form, all with the same discriminator; the
// account count picks the form, and any other count is refused.
function findSpec(program: string, data: Uint8Array, accountCount: number): InstructionSpec {
  const specs = ALLOWED_INSTRUCTIONS[program];
  const forms = specs.filter(
    (s) => data.length >= s.discriminator.length && s.discriminator.every((b, i) => data[i] === b),
  );
  if (forms.length === 1) return forms[0];
  if (forms.length > 1) {
    const spec = forms.find((s) => s.accounts === accountCount);
    if (spec) return spec;
    const counts = forms.map((s) => s.accounts).sort((a, b) => a - b).join(" or ");
    reject(`${forms[0].protocol} ${forms[0].name} has ${accountCount} accounts; expected ${counts}`);
  }
  const id = program === AMM_V4_PROGRAM ? String(data[0] ?? "(empty)") : hex(data.subarray(0, 8)) || "(empty)";
  reject(`${specs[0].protocol} instruction ${id} is not allowed`);
}

function checkProtocol(
  ctx: Context,
  program: string,
  indexes: number[],
  accounts: string[],
  data: Uint8Array,
): void {
  const spec = findSpec(program, data, accounts.length);
  const label = `${spec.protocol} ${spec.name}`;
  if (data.length !== spec.args.length)
    reject(`${label} has ${data.length} data bytes; expected ${spec.args.length}`);
  if (!spec.kinds.includes(ctx.kind)) reject(`${label} is not allowed in a ${ctx.kind}`);
  checkArgs(ctx.kind, spec, label, data);

  const n = accounts.length;
  const fixed = spec.accounts;
  if (spec.remaining === "none" && n !== fixed) reject(`${label} has ${n} accounts; expected ${fixed}`);
  if (spec.remaining === "optionalPool" && n !== fixed && n !== fixed + 1)
    reject(`${label} has ${n} accounts; expected ${fixed} or ${fixed + 1}`);
  if (n < fixed) reject(`${label} has ${n} accounts; expected at least ${fixed}`);

  for (const [index, { role, name }] of Object.entries(spec.roles)) {
    const i = Number(index);
    const key = accounts[i];
    const at = `${label} account ${i} (${name})`;
    if (role === "pool" || role === "lpSource") {
      continue; // checked against the withdraw expectation (checkWithdrawal)
    } else if (role === "position") {
      continue; // checked against the position NFT account (checkClosedPosition)
    } else if (role === "owner" || role === "rentReceiver") {
      if (key !== ctx.owner) reject(`${at} is not the connected wallet`);
      if (role === "owner" && !ctx.message.isAccountSigner(indexes[i])) reject(`${at} is not a signer`);
    } else if (role === "ownedTokenAccount") {
      if (!isOwned(ctx, key)) reject(`${at} is not the connected wallet's own token account`);
    } else if (!ctx.nftAccounts.get(key)?.has(spec.protocol)) {
      reject(`${at} is not an expected ${spec.protocol} position`);
    }
  }

  if (spec.remaining === "clmmRewards") checkClmmRewards(ctx, label, accounts, fixed);
  if (spec.closes) checkClosedPosition(ctx, spec, label, accounts);
  if (ctx.kind === "withdraw") checkWithdrawal(ctx, spec, label, accounts, data);
  if (ctx.kind === "close" && spec.closes) {
    // Each listed position closes at most once (a withdraw counts its own).
    const key = `${spec.protocol}:${accounts[roleIndex(spec, "positionNftAccount")!]}`;
    if (ctx.closed.has(key)) reject(`${label} closes the same position twice`);
    ctx.closed.add(key);
  }
}

/**
 * A close_position names the position account listed with its position NFT
 * account (the role loop already holds the NFT account to a listed position
 * of this protocol).
 */
function checkClosedPosition(ctx: Context, spec: InstructionSpec, label: string, accounts: string[]): void {
  const nft = accounts[roleIndex(spec, "positionNftAccount")!];
  const i = roleIndex(spec, "position")!;
  const listed = ctx.positions.some(
    (p) => p.protocol === spec.protocol && p.nftAccount === nft && p.position === accounts[i],
  );
  if (!listed) reject(`${label} account ${i} (${spec.roles[i].name}) is not the position of its NFT account`);
}

const roleIndex = (spec: InstructionSpec, role: AccountRole): number | null => {
  const entry = Object.entries(spec.roles).find(([, r]) => r.role === role);
  return entry ? Number(entry[0]) : null;
};

const amountsText = (values: readonly (bigint | string)[]) => values.map(String).join(", ");

/**
 * Ties a liquidity removal or close to the visitor's choice, the position's
 * `withdraw` expectation. The position is the one named by the
 * instruction's position NFT account (DAMM v2, CLMM) or, for CPMM and AMM
 * v4, the expected withdrawal of the same protocol from that LP account
 * (or the only one, so a different LP account is named in the refusal).
 * A CLMM decrease of 0 liquidity is a fee collect, not a removal.
 */
function checkWithdrawal(ctx: Context, spec: InstructionSpec, label: string, accounts: string[], data: Uint8Array): void {
  if (!spec.removes && !spec.closes) return;
  const { amount, minimums } = decodeInstructionArgs(spec.args, data);
  if (spec.removes === "amount" && amount === BigInt(0)) return;

  const position = withdrawnPosition(ctx, spec, label, accounts);
  const w = position.withdraw!;
  const key = `${position.protocol}:${position.nftAccount}`;
  if (spec.closes) {
    if (!w.closes) reject(`${label} closes a position the withdrawal keeps open`);
    if (ctx.closed.has(key)) reject(`${label} closes the same position twice`);
    ctx.closed.add(key);
    return;
  }

  const at = (role: AccountRole) => {
    const i = roleIndex(spec, role)!;
    return { i, key: accounts[i], text: `${label} account ${i} (${spec.roles[i].name})` };
  };
  const pool = at("pool");
  if (pool.key !== w.pool) reject(`${pool.text} is not the pool being withdrawn from`);
  if (roleIndex(spec, "lpSource") !== null) {
    const lp = at("lpSource");
    if (lp.key !== w.lpAccount) reject(`${lp.text} is not the LP account being withdrawn from`);
  }
  if (ctx.removed.has(key)) reject(`${label} removes liquidity from the same position twice`);
  ctx.removed.add(key);

  if (spec.removes === "all") {
    if (!w.removeAll) reject(`${label} removes all liquidity, but the withdrawal removes ${w.amount}`);
  } else {
    if (w.removeAll) reject(`${label} removes ${amount}, but the withdrawal removes all liquidity`);
    if (amount !== BigInt(w.amount)) reject(`${label} removes ${amount}; expected ${w.amount}`);
  }
  const expected = w.minimums.map((m) => BigInt(m));
  if (minimums.length !== expected.length || minimums.some((m, i) => m !== expected[i]))
    reject(`${label} minimums are ${amountsText(minimums)}; expected ${amountsText(w.minimums)}`);
}

function withdrawnPosition(ctx: Context, spec: InstructionSpec, label: string, accounts: string[]): ExpectedPosition {
  const own = ctx.positions.filter((p) => p.protocol === spec.protocol);
  const nft = roleIndex(spec, "positionNftAccount");
  let found: ExpectedPosition | undefined;
  if (nft !== null) {
    const named = own.filter((p) => p.nftAccount === accounts[nft]);
    found = named.find((p) => p.withdraw) ?? named[0];
  } else {
    const lp = roleIndex(spec, "lpSource");
    const withdrawals = own.filter((p) => p.withdraw);
    found =
      withdrawals.find((p) => lp !== null && p.withdraw!.lpAccount === accounts[lp]) ??
      (withdrawals.length === 1 ? withdrawals[0] : undefined);
  }
  if (!found?.withdraw) reject(`${label} acts on a position the visitor did not choose to withdraw from`);
  return found;
}

export type DecodedArgs = { amount: bigint | null; minimums: bigint[] };

/** Decodes an allowed instruction's amount and minimums; the length must already match. */
export function decodeInstructionArgs(args: InstructionArgs, data: Uint8Array): DecodedArgs {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (offset: number) => view.getBigUint64(offset, true);
  let amount: bigint | null = null;
  if (args.amount) {
    const { offset, bytes } = args.amount;
    amount = bytes === 8 ? u64(offset) : u64(offset) | (u64(offset + 8) << BigInt(64));
  }
  return { amount, minimums: args.minimums.map(u64) };
}

function checkArgs(kind: ActionKind, spec: InstructionSpec, label: string, data: Uint8Array): void {
  if (!spec.args.amount && spec.args.minimums.length === 0) return;
  const { amount, minimums } = decodeInstructionArgs(spec.args, data);
  const zero = BigInt(0);
  const noMinimum = minimums.every((m) => m === zero);
  if (kind === "claim" || kind === "close") {
    // Only a pure collect reaches here (see `kinds` in ./programs.ts).
    if (amount !== zero || !noMinimum) reject(`${label} in a ${kind} must remove 0 liquidity with 0 minimums`);
    return;
  }
  if (amount === zero) {
    if (spec.collectWhenZero) return;
    reject(`${label} removes nothing`);
  }
  if (noMinimum) reject(`${label} has no minimum amounts`);
}

const isOwned = (ctx: Context, key: string) => key === ctx.owner || ctx.ownerAtas.has(key);

// CLMM decrease_liquidity_v2 remaining accounts: the pool's tick-array
// bitmap extension, if any, then one triple per reward (pool reward vault,
// recipient, reward mint). The recipients receive tokens. The bitmap is
// accepted only first, so the triples read the same however the program
// locates the bitmap.
function checkClmmRewards(ctx: Context, label: string, accounts: string[], fixed: number): void {
  const pool = new PublicKey(accounts[3]);
  const [bitmapKey] = PublicKey.findProgramAddressSync(
    [CLMM_BITMAP_SEED, pool.toBytes()],
    new PublicKey(CLMM_PROGRAM),
  );
  const bitmap = bitmapKey.toBase58();
  const start = accounts[fixed] === bitmap ? fixed + 1 : fixed;
  if (accounts.slice(start).includes(bitmap))
    reject(`${label} has the tick-array bitmap extension out of place`);
  const rewards = accounts.length - start;
  if (rewards % 3 !== 0) reject(`${label} has ${rewards} reward accounts; expected a multiple of 3`);
  for (let i = start + 1; i < accounts.length; i += 3)
    if (!isOwned(ctx, accounts[i]))
      reject(`${label} account ${i} (reward recipient) is not the connected wallet's own token account`);
}
