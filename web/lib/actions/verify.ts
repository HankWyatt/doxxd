// The pre-sign check. Every message is checked here before the wallet sees
// it, and again after the wallet signs it. A message passes only when it
// can do nothing but the allowed LP actions for the connected wallet:
// - no address-table lookups, so every account is visible here;
// - the wallet is the fee payer and the only signer;
// - only the programs in ./programs.ts at the top level (never System);
// - capped compute budget;
// - ATA creates only of the wallet's own ATAs of expected mints;
// - Token / Token-2022 only CloseAccount of those ATAs, to the wallet;
// - protocol instructions only from ALLOWED_INSTRUCTIONS, with their
//   paid-out tokens, rent and position NFTs checked by role.
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
  MEMO_PROGRAM,
  SET_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_PRICE,
  TOKEN_2022_PROGRAM,
  TOKEN_CLOSE_ACCOUNT,
  TOKEN_PROGRAM,
  TOKEN_PROGRAMS,
  type InstructionSpec,
} from "./programs";
import type { ActionProtocol } from "./types";

export type Expectation = {
  /** The connected wallet. */
  owner: string;
  /** Mints the wallet may receive, each with its token program. */
  mints: { mint: string; tokenProgram: string }[];
  /** Positions the transaction may act on. */
  positions: { position: string; nftAccount: string; protocol: ActionProtocol }[];
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

class Rejected extends Error {}

function reject(reason: string): never {
  throw new Rejected(reason);
}

type Context = {
  message: VersionedMessage;
  keys: string[];
  owner: string;
  mints: Set<string>;
  /** The wallet's ATA → its mint and token program. */
  ownerAtas: Map<string, { mint: string; program: string }>;
  /** Position NFT account → the protocols it is expected under. */
  nftAccounts: Map<string, Set<ActionProtocol>>;
  computeUnitLimit: boolean;
  computeUnitPrice: boolean;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const TOKEN_LABEL: Record<string, string> = { [TOKEN_PROGRAM]: "Token", [TOKEN_2022_PROGRAM]: "Token-2022" };
const CLMM_BITMAP_SEED = new TextEncoder().encode("pool_tick_array_bitmap_extension");

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

  const owner = parseOwner(expect.owner);
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  if (keys[0] !== owner.toBase58()) reject("fee payer is not the connected wallet");
  const signatures = message.header.numRequiredSignatures;
  if (signatures !== 1)
    reject(`only the connected wallet may sign (the message needs ${signatures} signatures)`);
  if (new Set(keys).size !== keys.length) reject("duplicate account key");

  const ctx: Context = {
    message,
    keys,
    owner: owner.toBase58(),
    mints: new Set(expect.mints.map((m) => m.mint)),
    ownerAtas: new Map(),
    nftAccounts: new Map(),
    computeUnitLimit: false,
    computeUnitPrice: false,
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
    else if (program === MEMO_PROGRAM) return; // its accounts must sign, and only the owner signs
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

function findSpec(program: string, data: Uint8Array): InstructionSpec {
  const specs = ALLOWED_INSTRUCTIONS[program];
  const spec = specs.find(
    (s) => data.length >= s.discriminator.length && s.discriminator.every((b, i) => data[i] === b),
  );
  if (spec) return spec;
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
  const spec = findSpec(program, data);
  const label = `${spec.protocol} ${spec.name}`;
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
    if (role === "owner" || role === "rentReceiver") {
      if (key !== ctx.owner) reject(`${at} is not the connected wallet`);
      if (role === "owner" && !ctx.message.isAccountSigner(indexes[i])) reject(`${at} is not a signer`);
    } else if (role === "ownedTokenAccount") {
      if (!isOwned(ctx, key)) reject(`${at} is not the connected wallet's own token account`);
    } else if (!ctx.nftAccounts.get(key)?.has(spec.protocol)) {
      reject(`${at} is not an expected ${spec.protocol} position`);
    }
  }

  if (spec.remaining === "clmmRewards") checkClmmRewards(ctx, label, accounts, fixed);
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
