import "./buffer-polyfill";
import type { InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import type { ActionTarget, ClmmTarget, DammV2Target } from "../types";
import type { Expectation } from "../verify";
import {
  buildDammV2ClaimGroups,
  buildDammV2WithdrawGroups,
  quoteDammV2Withdraw,
  type ClaimBuild,
} from "./meteora-damm-v2";
import type { WithdrawQuote } from "./quote";
import { buildClmmClaimGroups, buildClmmWithdrawGroups, quoteClmmWithdraw } from "./raydium-clmm";

export { createActionRpc, isRpcBusy, RpcBusyError } from "../rpc";
export type { ActionRpc, SimulatedAccount } from "../rpc";
export { verifyMessage } from "../verify";
export type { Expectation, VerifyResult } from "../verify";
export { GroupTooLargeError, packGroups } from "../pack";
export type { InstructionGroup, PackedMessage } from "../pack";
export { runAction } from "../run";
export type { ActionStep, RunOptions, StepStatus } from "../run";
export { AmountTooSmallError, NothingToWithdrawError, PositionGoneError } from "./quote";
export type { SkipReason, TokenAmount, WithdrawQuote } from "./quote";

function notImplemented(): never {
  throw new Error("not implemented");
}

const isDammV2 = (t: ActionTarget): t is DammV2Target => t.protocol === "meteora-damm-v2";
const isClmm = (t: ActionTarget): t is ClmmTarget => t.protocol === "raydium-clmm";

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
  // Raydium CPMM and AMM v4 (Task 10) are not built yet.
  if (!targets.every((t) => isDammV2(t) || isClmm(t))) notImplemented();
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
  return notImplemented();
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
  return notImplemented();
}
