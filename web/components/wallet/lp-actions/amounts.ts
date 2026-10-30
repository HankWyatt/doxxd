// Token amounts for the LP action UI: names and decimals from DMND's rows,
// atoms scaled to display amounts. Pure; no web3.js.
import { atomsToUi, formatAmount } from "@/lib/decimal";
import { WSOL_MINT } from "@/lib/actions/programs";
import { mintName } from "@/lib/portfolio/adapters/shared";
import type { ActionTarget, Leg } from "@/lib/actions/types";

export type MintInfo = { decimals: number | null; name: string };
export type MintLookup = (mint: string) => MintInfo;

const legsOf = (t: ActionTarget): Leg[] => ("legs" in t ? t.legs : [t.tokenA, t.tokenB]);

/**
 * Names and decimals for the mints in `targets`: DMND's leg symbol, then the
 * holdings label, then the short mint. The runner reports SOL in
 * lamports under the wSOL mint, so that mint always reads as SOL.
 */
export function mintLookup(targets: readonly ActionTarget[], labels: Record<string, string>): MintLookup {
  const legs = new Map<string, Leg>();
  for (const t of targets) for (const leg of legsOf(t)) if (!legs.has(leg.mint)) legs.set(leg.mint, leg);
  return (mint) => {
    if (mint === WSOL_MINT) return { decimals: 9, name: "SOL" };
    const leg = legs.get(mint);
    return { decimals: leg?.decimals ?? null, name: leg?.symbol?.trim() || labels[mint] || mintName(mint) };
  };
}

/** "1.5 SYNA"; without known decimals the atoms stay raw and say so. */
export function formatAtoms(mint: string, atoms: string, lookup: MintLookup): string {
  const { decimals, name } = lookup(mint);
  const ui = decimals === null ? null : atomsToUi(atoms, decimals);
  const text = ui === null ? null : formatAmount(ui);
  return text === null ? `${atoms} raw atoms ${name}` : `${text} ${name}`;
}

/** "1.5 SYNA + 0.002 SOL" */
export function formatAmounts(amounts: readonly { mint: string; atoms: string }[], lookup: MintLookup): string {
  return amounts.map((a) => formatAtoms(a.mint, a.atoms, lookup)).join(" + ");
}

const ZERO = BigInt(0);
const big = (value: string) => (/^\d+$/.test(value) ? BigInt(value) : ZERO);

/**
 * DMND's claimable fee atoms summed per mint, for targets whose fees DMND
 * reports exactly (Meteora DAMM v2). Rewards are not fees and are left out.
 */
export function exactFeeTotals(targets: readonly ActionTarget[]): { mint: string; atoms: string }[] {
  const totals = new Map<string, bigint>();
  const add = (mint: string, atoms: string) => totals.set(mint, (totals.get(mint) ?? ZERO) + big(atoms));
  for (const t of targets)
    if (t.protocol === "meteora-damm-v2") {
      add(t.tokenA.mint, t.feeAAtoms);
      add(t.tokenB.mint, t.feeBAtoms);
    }
  return [...totals].filter(([, atoms]) => atoms > ZERO).map(([mint, atoms]) => ({ mint, atoms: atoms.toString() }));
}

/** "SYNA + SYNB": a position named by its tokens, as the card names it. */
export function positionName(target: ActionTarget, lookup: MintLookup): string {
  return legsOf(target)
    .map((leg) => lookup(leg.mint).name)
    .join(" + ");
}
