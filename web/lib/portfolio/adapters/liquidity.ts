import type { Schemas } from "../../dmnd/contracts";
import type { AmountView, PositionView } from "../model";
import { atomsToUi, compareDecimalDesc } from "../../decimal";
import {
  ACTION_PROGRAM_IDS,
  type ActionTarget,
  type Leg,
} from "../../actions/types";
import {
  position,
  leg,
  legLabel,
  sourceDetail,
  tokenLabels,
  sourceClockNote,
} from "./shared";
export function sourceContextDetails(
  sources: Schemas["WalletFungibleLiquiditySource"][],
  prefix = "Source",
) {
  return sources.flatMap((source, i) => [
    sourceDetail(`${prefix} ${i + 1} account`, source.account),
    sourceDetail(`${prefix} ${i + 1} context slot`, source.context_slot),
  ]);
}
const actionLeg = (source: {
  mint: string;
  decimals?: number | null;
  symbol?: string | null;
}): Leg => ({
  mint: source.mint,
  decimals: source.decimals ?? null,
  symbol: source.symbol ?? null,
});
// A reward's labels; with a mint it reads like a leg, and its details keep the mint.
const reward = (r: Parameters<typeof tokenLabels>[0]) =>
  r.mint
    ? {
        label: legLabel({ mint: r.mint, symbol: r.symbol }),
        mint: r.mint,
        ...tokenLabels(r),
        sourceDetails: [{ label: "Mint", value: r.mint }],
      }
    : { label: "Reward" };
// Only Raydium CLMM rows get actions; Orca rows share this adapter without.
export function liquidityRows(
  raw: Schemas["WalletLiquidityPositions"],
  resource: "orca" | "raydium-clmm" = "orca",
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(
      row.position,
      legLabel(row.principal_a) + " / " + legLabel(row.principal_b),
    ),
    assets: [leg(row.principal_a), leg(row.principal_b)],
    links: {
      pool: row.pool,
      position: row.position,
      positionMint: row.position_mint,
    },
    ...(resource === "raydium-clmm" &&
    row.program === ACTION_PROGRAM_IDS["raydium-clmm"]
      ? {
          action: {
            protocol: "raydium-clmm",
            id: row.position,
            pool: row.pool,
            position: row.position,
            positionMint: row.position_mint,
            positionNftAccount: row.owner_token_account,
            nftTokenProgram: row.token_program,
            program: row.program,
            liquidity: row.liquidity,
            tickLower: row.tick_lower,
            tickUpper: row.tick_upper,
            feeOwedAAtoms: row.fee_owed_a,
            feeOwedBAtoms: row.fee_owed_b,
            rewards: row.rewards.flatMap((r) =>
              r.mint ? [{ mint: r.mint, atoms: r.owed_atoms }] : [],
            ),
            tokenA: actionLeg(row.principal_a),
            tokenB: actionLeg(row.principal_b),
            snapshotSlot: row.position_slot,
          } satisfies ActionTarget,
        }
      : {}),
    rewards: row.rewards.map((r) => ({
      ...reward(r),
      amount: r.owed_atoms,
      qualifier: "raw atoms; settled owed counter",
    })),
    details: [
      { label: "Pool", value: row.pool },
      { label: "Position", value: row.position },
      { label: "Tick range", value: row.tick_lower + " → " + row.tick_upper },
      {
        label: "Owed fee counters (raw atoms)",
        value: row.fee_owed_a + " / " + row.fee_owed_b,
      },
      sourceDetail("Owner token slot", row.owner_token_slot),
      sourceDetail("Position account slot", row.position_slot),
      sourceDetail("Pool slot", row.pool_slot),
      sourceDetail("Snapshot slot", row.snapshot_slot),
      sourceClockNote,
      {
        label: "Valuation",
        value: "Principal only. Fees and reward counters are shown separately.",
      },
    ],
  }));
}
export function meteoraRows(
  raw: Schemas["WalletMeteoraPositions"],
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(
      row.position,
      legLabel(row.principal_x) + " / " + legLabel(row.principal_y),
    ),
    assets: [leg(row.principal_x), leg(row.principal_y)],
    links: { pool: row.pair, position: row.position },
    rewards: row.rewards.map((r) => ({
      ...reward(r),
      amount: r.pending_atoms,
      qualifier: "raw atoms; pending counter",
    })),
    details: [
      { label: "Pair", value: row.pair },
      { label: "Position", value: row.position },
      {
        label: "Bin range",
        value: row.lower_bin_id + " → " + row.upper_bin_id,
      },
      {
        label: "Pending fee counters (raw atoms)",
        value: row.fee_pending_x_atoms + " / " + row.fee_pending_y_atoms,
      },
      sourceDetail("Owner slot", row.owner_slot),
      sourceDetail("Position account slot", row.position_slot),
      sourceDetail("Pair slot", row.pair_slot),
      sourceDetail("Bin arrays slot", row.bin_arrays_slot),
      sourceDetail("Snapshot slot", row.snapshot_slot),
      sourceClockNote,
    ],
  }));
}
// Exact atoms scaled by DMND's decimals; without decimals the atoms stay raw.
function claimable(
  token: Parameters<typeof tokenLabels>[0] & { mint: string },
  atoms: string,
  decimals: number | null | undefined,
  kind: string,
): AmountView {
  const amount = decimals == null ? null : atomsToUi(atoms, decimals);
  return {
    label: legLabel(token),
    mint: token.mint,
    ...tokenLabels(token),
    amount: amount ?? atoms,
    qualifier:
      (amount === null ? "raw atoms; " : "") +
      kind +
      "; before any Token-2022 transfer fee",
    sourceDetails: [
      { label: "Mint", value: token.mint },
      { label: "Raw atoms", value: atoms },
    ],
  };
}
export function dammV2Rows(
  raw: Schemas["WalletMeteoraDammV2Positions"],
): PositionView[] {
  return raw.data.map((row) => {
    const assets = [row.token_a, row.token_b].map(
      (source): AmountView => ({
        ...leg(source),
        sourceDetails: [
          sourceDetail("Mint", source.mint),
          sourceDetail("Raw atoms", source.amount_atoms),
          sourceDetail("Decimals", source.decimals),
        ],
      }),
    );
    const [a, b] = assets;
    const fees = [
      claimable(row.token_a, row.fee_a_claimable_atoms, row.token_a.decimals, "claimable fee"),
      claimable(row.token_b, row.fee_b_claimable_atoms, row.token_b.decimals, "claimable fee"),
    ];
    return {
      ...position(row.position, a.label + " / " + b.label),
      assets,
      links: {
        pool: row.pool,
        position: row.position,
        positionMint: row.position_mint,
      },
      ...(row.program === ACTION_PROGRAM_IDS["meteora-damm-v2"]
        ? {
            action: {
              protocol: "meteora-damm-v2",
              id: row.position,
              pool: row.pool,
              position: row.position,
              positionMint: row.position_mint,
              positionNftAccount: row.owner_token_account,
              nftTokenProgram: row.token_program,
              program: row.program,
              liquidity: {
                unlocked: row.liquidity.unlocked,
                vested: row.liquidity.vested,
                permanentLocked: row.liquidity.permanent_locked,
                total: row.liquidity.total,
              },
              feeAAtoms: row.fee_a_claimable_atoms,
              feeBAtoms: row.fee_b_claimable_atoms,
              rewards: row.rewards.map((r) => ({
                index: r.index,
                mint: r.mint,
                atoms: r.claimable_atoms,
              })),
              tokenA: actionLeg(row.token_a),
              tokenB: actionLeg(row.token_b),
              snapshotSlot: row.position_slot,
            } satisfies ActionTarget,
          }
        : {}),
      valueUsd: row.principal_value_usd ?? null,
      locked: [row.liquidity.permanent_locked, row.liquidity.vested].some(
        (units) => compareDecimalDesc(units, "0") < 0,
      ),
      fees,
      rewards: [
        ...fees,
        ...row.rewards.map((r) =>
          claimable(r, r.claimable_atoms, r.decimals, "claimable reward, no USD value"),
        ),
      ],
      details: [
        { label: "Pool", value: row.pool },
        { label: "Position", value: row.position },
        { label: "Position NFT mint", value: row.position_mint },
        { label: "Owner token account", value: row.owner_token_account },
        { label: "Unlocked liquidity", value: row.liquidity.unlocked },
        { label: "Vesting liquidity", value: row.liquidity.vested },
        {
          label: "Permanently locked liquidity",
          value: row.liquidity.permanent_locked,
        },
        { label: "Total liquidity", value: row.liquidity.total },
        {
          label: "Liquidity units",
          value:
            "Raw pool liquidity. Locked and vesting liquidity is included in the token amounts; part of the vesting bucket may already be releasable.",
        },
        {
          label: "Fee collection mode",
          value: row.collect_fee_mode.replaceAll("_", " "),
        },
        sourceDetail("Pool price (token A in token B)", row.pool_price),
        sourceDetail("Owner token slot", row.owner_token_slot),
        sourceDetail("Position account slot", row.position_slot),
        sourceDetail("Pool slot", row.pool_slot),
        sourceDetail("Snapshot slot", row.snapshot_slot),
        sourceDetail("Position clock time", row.snapshot_block_time),
        sourceClockNote,
        {
          label: "Valuation",
          value:
            "Principal only, when the source values both legs. Claimable fees and rewards are shown separately without USD value.",
        },
      ],
    };
  });
}
// DMND's receipt rows carry no program ID; a refused (unverified) row gets no
// action, and callers that do not say which protocol they hold get none either.
export function fungibleRows(
  raw: Schemas["WalletFungibleLiquidityPositions"],
  protocol?: "raydium-cpmm" | "raydium-amm-v4",
): PositionView[] {
  return raw.data.map((row) => ({
    ...position(row.owner_token_account, "Direct LP receipt"),
    assets: row.principal.map(leg),
    ...(row.pool ? { links: { pool: row.pool } } : {}),
    ...(protocol && row.status !== "refused"
      ? {
          action: {
            protocol,
            id: row.owner_token_account,
            pool: row.pool ?? null,
            lpMint: row.lp_mint,
            lpAccount: row.owner_token_account,
            lpAtoms: row.lp_atoms,
            lpDecimals: row.lp_decimals,
            withdrawalAvailable: row.withdrawal_available ?? null,
            legs: row.principal.map(actionLeg),
            snapshotSlot: row.context_slot,
          } satisfies ActionTarget,
        }
      : {}),
    details: [
      { label: "LP mint", value: row.lp_mint },
      { label: "Receipt atoms", value: row.lp_atoms },
      { label: "Token account", value: row.owner_token_account },
      { label: "Pool", value: row.pool ?? "Unqualified" },
      { label: "Status", value: row.reason ?? row.status },
      {
        label: "Withdrawal availability",
        value:
          row.withdrawal_available == null
            ? "Unknown"
            : row.withdrawal_available
              ? "Observed available"
              : "Restricted",
      },
      sourceDetail("Position context slot", row.context_slot),
      ...sourceContextDetails(row.sources),
      sourceClockNote,
    ],
  }));
}
