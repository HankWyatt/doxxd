// The wallet's associated token accounts (ATAs) and the live mints they hold,
// shared by the Raydium builders.
//
// RPC methods used: getMultipleAccounts (through readAccounts), for the
// candidate ATAs only.
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import type { ActionRpc } from "../rpc";
import { attempt, readAccounts, type LiveMint } from "./meteora-damm-v2";

/** The mint at `address` with its live token program, or null. */
export function liveMint(address: PublicKey, info: AccountInfo<Buffer> | null | undefined): LiveMint | null {
  if (!info) return null;
  const program = info.owner.equals(TOKEN_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : info.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : null;
  if (!program) return null;
  const mint = attempt(() => unpackMint(address, info, program));
  return mint && { address, program, mint };
}

/** The wallet's ATA of `mint`, under the mint's live token program. */
export const ataOf = (wallet: PublicKey, mint: LiveMint) =>
  getAssociatedTokenAddressSync(mint.address, wallet, false, mint.program);

/**
 * The wallet's ATAs (of `mints`) that need no create: an initialized token
 * account the mint's token program owns, of that mint, whose owner field is
 * the wallet. Anything else keeps its idempotent create, which fails safely
 * on an account that is not the wallet's (ruling R-T9b). The wSOL ATA is
 * never "existing": every group that unwraps it closes it, so the next group
 * must create it again.
 */
export async function existingAtas(rpc: ActionRpc, wallet: PublicKey, mints: LiveMint[]): Promise<Set<string>> {
  const byAta = new Map<string, LiveMint>();
  for (const mint of mints) byAta.set(ataOf(wallet, mint).toBase58(), mint);
  const accounts = await readAccounts(rpc, [...byAta.keys()]);
  const out = new Set<string>();
  for (const [ata, mint] of byAta) {
    const info = accounts.get(ata);
    if (mint.address.equals(NATIVE_MINT) || !info || !info.owner.equals(mint.program)) continue;
    // Lamports sent to an ATA address do not make it a token account, and a
    // token account whose owner was reassigned is not the wallet's.
    const account = attempt(() => unpackAccount(new PublicKey(ata), info, mint.program));
    if (account && account.isInitialized && account.owner.equals(wallet) && account.mint.equals(mint.address))
      out.add(ata);
  }
  return out;
}

/** Idempotent creates of the wallet's ATAs of `mints` that are not in `existing`. */
export function ataCreates(wallet: PublicKey, mints: LiveMint[], existing: Set<string>): TransactionInstruction[] {
  return mints
    .filter((mint) => !existing.has(ataOf(wallet, mint).toBase58()))
    .map((mint) =>
      createAssociatedTokenAccountIdempotentInstruction(wallet, ataOf(wallet, mint), wallet, mint.address, mint.program),
    );
}

/** The wSOL unwrap: Token CloseAccount of the wallet's wSOL ATA, to the wallet, when `mints` pay wSOL. */
export function wsolUnwraps(wallet: PublicKey, mints: LiveMint[]): TransactionInstruction[] {
  return mints
    .filter((mint) => mint.address.equals(NATIVE_MINT))
    .map((mint) => createCloseAccountInstruction(ataOf(wallet, mint), wallet, wallet, [], mint.program));
}
