// Packs instruction groups into v0 transactions for the runner (./run.ts).
// Pure apart from compiling messages: no RPC, no wallet.
//
// Imports web3.js, so it is reached only through the lazy entry
// lib/actions/build/index.ts (ruling R-P4).
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
  type VersionedMessage,
} from "@solana/web3.js";
import { MAX_COMPUTE_UNIT_LIMIT } from "./programs";

/** Instructions that must land together, for the positions they act on. */
export type InstructionGroup = { positionIds: string[]; instructions: TransactionInstruction[]; label: string };

export type PackedMessage = { message: VersionedMessage; positionIds: string[]; label: string };

/** Solana's packet limit for a whole serialized transaction. */
export const MAX_TRANSACTION_BYTES = 1_232;

/** A single group that does not fit in one transaction, even alone. */
export class GroupTooLargeError extends Error {
  readonly positionIds: string[];
  constructor(group: InstructionGroup) {
    super(`"${group.label}" does not fit in one transaction.`);
    this.name = "GroupTooLargeError";
    this.positionIds = [...group.positionIds];
  }
}

function budget(units: number, cuPrice: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
  ];
}

function compile(owner: PublicKey, blockhash: string, instructions: TransactionInstruction[]): VersionedMessage {
  return new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message();
}

/**
 * The message for `groups`, or null when it does not fit. A compile or
 * serialize failure (too many accounts, a buffer overflow) counts as not
 * fitting; the size counts every signature slot the message needs.
 */
function fit(owner: PublicKey, blockhash: string, cuPrice: number, groups: InstructionGroup[]): VersionedMessage | null {
  try {
    const message = compile(owner, blockhash, [
      ...budget(MAX_COMPUTE_UNIT_LIMIT, cuPrice),
      ...groups.flatMap((g) => g.instructions),
    ]);
    return new VersionedTransaction(message).serialize().length <= MAX_TRANSACTION_BYTES ? message : null;
  } catch {
    return null;
  }
}

type Packing = { groups: InstructionGroup[]; message: VersionedMessage };

function partition(groups: InstructionGroup[], owner: PublicKey, blockhash: string, cuPrice: number): Packing[] {
  const out: Packing[] = [];
  let current: Packing | null = null;
  for (const group of groups) {
    const together: VersionedMessage | null = current && fit(owner, blockhash, cuPrice, [...current.groups, group]);
    if (current && together) {
      current = { groups: [...current.groups, group], message: together };
      continue;
    }
    if (current) out.push(current);
    const alone = fit(owner, blockhash, cuPrice, [group]);
    if (!alone) throw new GroupTooLargeError(group);
    current = { groups: [group], message: alone };
  }
  if (current) out.push(current);
  return out;
}

/**
 * Packs `groups` greedily, in order, into as few transactions as fit. A group
 * is never split. Each message is paid for by `owner`, starts with
 * SetComputeUnitLimit(1,400,000) and SetComputeUnitPrice(cuPrice), and is at
 * most 1,232 bytes serialized. Throws GroupTooLargeError for a group that
 * does not fit alone.
 */
export function packGroups(
  groups: InstructionGroup[],
  owner: PublicKey,
  blockhash: string,
  cuPrice: number,
): PackedMessage[] {
  return partition(groups, owner, blockhash, cuPrice).map(({ groups: packed, message }) => ({
    message,
    positionIds: packed.flatMap((g) => g.positionIds),
    label: packed.map((g) => g.label).join(", "),
  }));
}

// The blockhash and the compute-unit price are fixed-width fields, so their
// values never change a message's size: any blockhash and price give the
// same packing.
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/**
 * How packGroups splits `groups` into transactions, without a real blockhash
 * or price: the groups of each transaction, in order. Packing one entry with
 * any blockhash and price gives exactly one message. Throws
 * GroupTooLargeError like packGroups.
 */
export function partitionGroups(groups: InstructionGroup[], owner: PublicKey): InstructionGroup[][] {
  return partition(groups, owner, PLACEHOLDER_BLOCKHASH, 0).map((p) => p.groups);
}

/**
 * The same message with its leading SetComputeUnitLimit set to `units`.
 * Everything else (instructions, payer, blockhash) stays as it was. Throws
 * when the message does not start with SetComputeUnitLimit or uses
 * address-table lookups.
 */
export function withComputeUnitLimit(message: VersionedMessage, units: number): VersionedMessage {
  if (message.addressTableLookups.length > 0) throw new Error("Address-table lookups are not supported.");
  const decompiled = TransactionMessage.decompile(message);
  const [first, ...rest] = decompiled.instructions;
  if (
    !first ||
    !first.programId.equals(ComputeBudgetProgram.programId) ||
    ComputeBudgetInstruction.decodeInstructionType(first) !== "SetComputeUnitLimit"
  )
    throw new Error("The message does not start with SetComputeUnitLimit.");
  return compile(decompiled.payerKey, decompiled.recentBlockhash, [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ...rest,
  ]);
}
