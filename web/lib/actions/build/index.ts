import "./buffer-polyfill";
import type { InstructionGroup } from "../pack";
import type { ActionRpc } from "../rpc";
import type { ActionTarget, DammV2Target } from "../types";
import type { Expectation } from "../verify";
import {
  buildDammV2ClaimGroups,
  buildDammV2WithdrawGroups,
  quoteDammV2Withdraw,
  type ClaimBuild,
} from "./meteora-damm-v2";
import type { WithdrawQuote } from "./quote";

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
  // Raydium (Tasks 9 and 10) is not built yet.
  if (!targets.every(isDammV2)) notImplemented();
  return buildDammV2ClaimGroups(rpc, owner, targets);
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
  return notImplemented();
}

/** The withdraw group for `bps` of `target`'s withdrawable liquidity (kind "withdraw"). */
export async function buildWithdrawGroups(
  rpc: ActionRpc,
  owner: string,
  target: ActionTarget,
  bps: number,
  slippageBps: number,
): Promise<{ groups: InstructionGroup[]; expectation: Expectation }> {
  if (isDammV2(target)) return buildDammV2WithdrawGroups(rpc, owner, target, bps, slippageBps);
  return notImplemented();
}
