import "./buffer-polyfill";
import type { InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import type { ActionTarget, ClmmTarget, DammV2Target, FungibleTarget } from "../types";
import type { Expectation } from "../verify";
import { TOKEN_2022_PROGRAM, TOKEN_CLOSE_ACCOUNT, TOKEN_PROGRAM } from "../programs";
import {
  buildDammV2ClaimGroups,
  buildDammV2CloseGroups,
  buildDammV2WithdrawGroups,
  quoteDammV2Withdraw,
  type ClaimBuild,
  type CloseBuild,
} from "./meteora-damm-v2";
import type { WithdrawQuote } from "./quote";
import { buildAmmV4WithdrawGroups, quoteAmmV4Withdraw } from "./raydium-amm-v4";
import { buildClmmClaimGroups, buildClmmCloseGroups, buildClmmWithdrawGroups, quoteClmmWithdraw } from "./raydium-clmm";
import { buildCpmmWithdrawGroups, quoteCpmmWithdraw } from "./raydium-cpmm";

export { cachedReads, createActionRpc, isRpcBusy, RpcBusyError } from "../rpc";
export type { ActionRpc, SimulatedAccount } from "../rpc";
export { verifyMessage } from "../verify";
export type { Expectation, VerifyResult } from "../verify";
export { GroupTooLargeError, packGroups } from "../pack";
export type { InstructionGroup, PackedMessage } from "../pack";
export { computeUnitPrice, runAction } from "../run";
export type { ActionStep, RunOptions, StepStatus } from "../run";
export {
  AmountTooSmallError,
  NothingToWithdrawError,
  PositionGoneError,
  PositionNotEmptyError,
  RewardsPausedError,
} from "./quote";
export type { CloseBuild } from "./meteora-damm-v2";
export type { SkipReason, TokenAmount, WithdrawQuote } from "./quote";

function unknownProtocol(): never {
  throw new Error("unknown protocol");
}

const isDammV2 = (t: ActionTarget): t is DammV2Target => t.protocol === "meteora-damm-v2";
const isClmm = (t: ActionTarget): t is ClmmTarget => t.protocol === "raydium-clmm";
const isCpmm = (t: ActionTarget): t is FungibleTarget => t.protocol === "raydium-cpmm";
const isAmmV4 = (t: ActionTarget): t is FungibleTarget => t.protocol === "raydium-amm-v4";

/**
 * One claim build from per-protocol builds: groups and skips in the order of
 * `targets`, the expected mints without repeats, every built position.
 */
function mergeClaims(owner: string, targets: ActionTarget[], builds: ClaimBuild[]): ClaimBuild {
  const order = new Map<string, number>();
  targets.forEach((t, i) => {
    if (!order.has(t.id)) order.set(t.id, i);
  });
  const at = (id: string) => order.get(id) ?? targets.length;
  const mints = new Map<string, string>();
  for (const { mint, tokenProgram } of builds.flatMap((b) => b.expectation.mints))
    if (!mints.has(mint)) mints.set(mint, tokenProgram);
  return {
    groups: builds.flatMap((b) => b.groups).sort((a, b) => at(a.positionIds[0]) - at(b.positionIds[0])),
    skipped: builds.flatMap((b) => b.skipped).sort((a, b) => at(a.positionId) - at(b.positionId)),
    expectation: {
      kind: "claim",
      owner,
      mints: [...mints].map(([mint, tokenProgram]) => ({ mint, tokenProgram })),
      positions: builds.flatMap((b) => b.expectation.positions),
    },
  };
}

/**
 * Claim groups for `targets`, built per protocol from live chain state, with
 * the positions skipped and the pre-sign check's expectation (kind "claim").
 */
export async function buildClaimGroups(
  rpc: ActionRpc,
  owner: string,
  targets: ActionTarget[],
): Promise<{
  groups: InstructionGroup[];
  skipped: ClaimBuild["skipped"];
  expectation: Expectation;
}> {
  // Raydium CPMM and AMM v4 fees are inside the LP tokens: withdraw only.
  if (targets.some((t) => isCpmm(t) || isAmmV4(t))) throw new Error("claim not supported");
  if (!targets.every((t) => isDammV2(t) || isClmm(t))) unknownProtocol();
  const damm = targets.filter(isDammV2);
  const clmm = targets.filter(isClmm);
  const builds: ClaimBuild[] = [];
  if (damm.length) builds.push(await buildDammV2ClaimGroups(rpc, owner, damm));
  if (clmm.length) builds.push(await buildClmmClaimGroups(rpc, owner, clmm));
  return mergeClaims(owner, targets, builds);
}

/** A live quote for withdrawing `bps` of `target`'s withdrawable liquidity. */
export async function quoteWithdraw(
  rpc: ActionRpc,
  owner: string,
  target: ActionTarget,
  bps: number,
  slippageBps: number,
): Promise<WithdrawQuote> {
  if (isDammV2(target)) return quoteDammV2Withdraw(rpc, owner, target, bps, slippageBps);
  if (isClmm(target)) return quoteClmmWithdraw(rpc, owner, target, bps, slippageBps);
  if (isCpmm(target)) return quoteCpmmWithdraw(rpc, owner, target, bps, slippageBps);
  if (isAmmV4(target)) return quoteAmmV4Withdraw(rpc, owner, target, bps, slippageBps);
  return unknownProtocol();
}

/**
 * The withdraw group for `bps` of `target`'s withdrawable liquidity (kind
 * "withdraw"), and whether it closes the position, read from the same chain
 * state as the group, so the dialog can re-check what its quote promised.
 */
export async function buildWithdrawGroups(
  rpc: ActionRpc,
  owner: string,
  target: ActionTarget,
  bps: number,
  slippageBps: number,
): Promise<{ groups: InstructionGroup[]; expectation: Expectation; closes: boolean }> {
  if (isDammV2(target)) return buildDammV2WithdrawGroups(rpc, owner, target, bps, slippageBps);
  if (isClmm(target)) return buildClmmWithdrawGroups(rpc, owner, target, bps, slippageBps);
  if (isCpmm(target)) return buildCpmmWithdrawGroups(rpc, owner, target, bps, slippageBps);
  if (isAmmV4(target)) return buildAmmV4WithdrawGroups(rpc, owner, target, bps, slippageBps);
  return unknownProtocol();
}

/**
 * The group that closes `target`, an empty DAMM v2 or CLMM position, after
 * collecting what it still holds (kind "close"), and the lamports closing
 * returns. Built from live state; refuses a position that is not empty.
 */
export async function buildCloseGroups(rpc: ActionRpc, owner: string, target: ActionTarget): Promise<CloseBuild> {
  if (isDammV2(target)) return buildDammV2CloseGroups(rpc, owner, target);
  if (isClmm(target)) return buildClmmCloseGroups(rpc, owner, target);
  if (isCpmm(target) || isAmmV4(target)) throw new Error("close not supported");
  return unknownProtocol();
}

/**
 * True when a group unwraps wrapped SOL (a Token CloseAccount of the wallet's
 * wSOL account): any wSOL the wallet already held comes back as SOL too.
 */
export function unwrapsWrappedSol(groups: InstructionGroup[]): boolean {
  return groups.some((group) =>
    group.instructions.some((ix) => {
      const program = ix.programId.toBase58();
      return (
        (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) &&
        ix.data.length === 1 &&
        ix.data[0] === TOKEN_CLOSE_ACCOUNT
      );
    }),
  );
}
