// @vitest-environment node
// web3.js derives and compiles with Node's crypto and Buffer; jsdom's realm
// breaks that, so this suite runs in the node environment.
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MOCK_BLOCKHASH } from "@/tests/fixtures/mock-action-rpc";
import { GroupTooLargeError, packGroups, partitionGroups, withComputeUnitLimit, type InstructionGroup } from "./pack";
import { CP_AMM_PROGRAM } from "./programs";

const seededKey = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey;
const OWNER = seededKey(7);
const CP_AMM = new PublicKey(CP_AMM_PROGRAM);
// 32 fixed bytes of 8, then the group and account numbers: synthetic, unique.
function syntheticAddress(group: number, account: number): PublicKey {
  const bytes = new Uint8Array(32).fill(8);
  bytes[0] = group;
  bytes[1] = account;
  return new PublicKey(bytes);
}

// A claim-shaped instruction: 15 accounts, 14 of them unique to the group,
// and an 8-byte discriminator, like cp-amm's claim_position_fee.
function claimGroup(n: number, accounts = 14): InstructionGroup {
  const keys = Array.from({ length: accounts }, (_, k) => ({
    pubkey: syntheticAddress(n, k),
    isSigner: false,
    isWritable: k < 6,
  }));
  return {
    positionIds: [`position-${n}`],
    label: `Claim ${n}`,
    instructions: [
      new TransactionInstruction({
        programId: CP_AMM,
        keys: [...keys, { pubkey: OWNER, isSigner: true, isWritable: true }],
        data: Buffer.alloc(8, n),
      }),
    ],
  };
}

const size = (message: VersionedTransaction["message"]) => new VersionedTransaction(message).serialize().length;

describe("packGroups", () => {
  it("packs 12 claim groups greedily, in order, into transactions of at most 1,232 bytes", () => {
    const groups = Array.from({ length: 12 }, (_, n) => claimGroup(n + 1));
    const packed = packGroups(groups, OWNER, MOCK_BLOCKHASH, 25_000);
    expect(packed.length).toBeGreaterThanOrEqual(2);
    expect(packed.flatMap((p) => p.positionIds)).toEqual(groups.flatMap((g) => g.positionIds));
    for (const p of packed) {
      expect(size(p.message)).toBeLessThanOrEqual(1_232);
      expect(p.message.header.numRequiredSignatures).toBe(1);
      expect(p.message.staticAccountKeys[0].equals(OWNER)).toBe(true);
      expect(p.message.recentBlockhash).toBe(MOCK_BLOCKHASH);
    }
    // Greedy: no transaction could also have taken the next group.
    for (let t = 0; t + 1 < packed.length; t++) {
      const taken = packed.slice(0, t + 1).flatMap((p) => p.positionIds).length;
      const together = groups.slice(taken - packed[t].positionIds.length, taken + 1);
      expect(() => packGroups(together, OWNER, MOCK_BLOCKHASH, 25_000)).not.toThrow();
      expect(packGroups(together, OWNER, MOCK_BLOCKHASH, 25_000)).toHaveLength(2);
    }
  });

  it("never splits a group", () => {
    const groups = [claimGroup(1), { ...claimGroup(2), instructions: [...claimGroup(2).instructions, ...claimGroup(3).instructions] }];
    const packed = packGroups(groups, OWNER, MOCK_BLOCKHASH, 25_000);
    const all = packed.flatMap((p) => TransactionMessage.decompile(p.message).instructions);
    const cpAmmData = all.filter((ix) => ix.programId.equals(CP_AMM)).map((ix) => ix.data[0]);
    expect(cpAmmData).toEqual([1, 2, 3]);
    const second = packed.find((p) => p.positionIds.includes("position-2"))!;
    const inSecond = TransactionMessage.decompile(second.message).instructions.filter((ix) => ix.programId.equals(CP_AMM));
    expect(inSecond.map((ix) => ix.data[0])).toEqual(expect.arrayContaining([2, 3]));
  });

  it("puts SetComputeUnitLimit(1,400,000) then SetComputeUnitPrice first", () => {
    const [packed] = packGroups([claimGroup(1), claimGroup(2)], OWNER, MOCK_BLOCKHASH, 25_000);
    const [limit, price, ...rest] = TransactionMessage.decompile(packed.message).instructions;
    expect(ComputeBudgetInstruction.decodeInstructionType(limit)).toBe("SetComputeUnitLimit");
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units).toBe(1_400_000);
    expect(ComputeBudgetInstruction.decodeInstructionType(price)).toBe("SetComputeUnitPrice");
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(price).microLamports).toBe(BigInt(25_000));
    expect(rest.every((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))).toBe(true);
  });

  it("throws GroupTooLargeError for a single group that does not fit", () => {
    const huge = claimGroup(1, 40);
    expect(() => packGroups([claimGroup(2), huge], OWNER, MOCK_BLOCKHASH, 25_000)).toThrow(GroupTooLargeError);
  });

  it("partitionGroups splits like packGroups, and each part packs into one message", () => {
    const groups = Array.from({ length: 12 }, (_, n) => claimGroup(n + 1));
    const parts = partitionGroups(groups, OWNER);
    const packed = packGroups(groups, OWNER, MOCK_BLOCKHASH, 200_000);
    expect(parts.map((part) => part.flatMap((g) => g.positionIds))).toEqual(packed.map((p) => p.positionIds));
    for (const part of parts) expect(packGroups(part, OWNER, MOCK_BLOCKHASH, 200_000)).toHaveLength(1);
    expect(() => partitionGroups([claimGroup(1, 40)], OWNER)).toThrow(GroupTooLargeError);
  });

  it("returns nothing for no groups", () => {
    expect(packGroups([], OWNER, MOCK_BLOCKHASH, 25_000)).toEqual([]);
  });
});

describe("withComputeUnitLimit", () => {
  it("changes only the compute-unit limit", () => {
    const [packed] = packGroups([claimGroup(1)], OWNER, MOCK_BLOCKHASH, 25_000);
    const lowered = withComputeUnitLimit(packed.message, 82_000);
    const [limit, ...rest] = TransactionMessage.decompile(lowered).instructions;
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit).units).toBe(82_000);
    const [, ...before] = TransactionMessage.decompile(packed.message).instructions;
    expect(rest).toEqual(before);
    expect(lowered.recentBlockhash).toBe(MOCK_BLOCKHASH);
    expect(lowered.staticAccountKeys.map(String)).toEqual(packed.message.staticAccountKeys.map(String));
  });

  it("refuses a message that does not start with SetComputeUnitLimit", () => {
    const message = new TransactionMessage({
      payerKey: OWNER,
      recentBlockhash: MOCK_BLOCKHASH,
      instructions: claimGroup(1).instructions,
    }).compileToV0Message();
    expect(() => withComputeUnitLimit(message, 82_000)).toThrow();
  });
});
