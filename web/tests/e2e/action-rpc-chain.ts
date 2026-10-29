// Loaded by action-rpc-server.mjs through Vite's module runner, never by the
// Playwright process: the Solana SDKs' CommonJS builds require an ESM-only
// `uuid`, which fails under Playwright's module loader hooks.
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { chainFixture, PROGRAM_IDS, SYNTHETIC, type ChainAccount, type SyntheticChain } from "../fixtures/actions-chain";
import { answerRpc, postStatesFrom, type PostStates } from "../fixtures/mock-action-rpc";

/** The chain's addresses and amounts that DMND rows must name (JSON-safe). */
export type ChainSummary = {
  owner: string;
  mints: SyntheticChain["mints"];
  dammV2: { unlocked: SyntheticChain["dammV2"]["variants"]["unlocked"]; locked: SyntheticChain["dammV2"]["variants"]["locked"] };
  cpmm: { pool: string; lpMint: string; lpAccount: string };
  amounts: {
    positionLiquidity: string;
    halfLiquidity: string;
    feeA: string;
    feeB: string;
    reward: string;
    cpmmOwnerLp: string;
  };
};

// What a claim pays the owner in these flows (made-up, round): one DAMM v2
// position's fees, in SYNA and SOL. Every simulation reports these balances
// afterwards, so the runner sees something to claim.
function claimPostStates(chain: SyntheticChain): PostStates {
  const owner = chain.owner.publicKey;
  const ownerAccount = chain.accounts.get(owner.toBase58())!;
  const synaAta = getAssociatedTokenAddressSync(
    new PublicKey(chain.mints.syna),
    owner,
    false,
    new PublicKey(PROGRAM_IDS.token),
  ).toBase58();
  const synaAccount = chain.accounts.get(synaAta)!;
  const data = Buffer.from(synaAccount.data);
  // SPL Token account: amount is a u64 at offset 64.
  data.writeBigUInt64LE(data.readBigUInt64LE(64) + BigInt(SYNTHETIC.dammV2.feeAPending.toString()), 64);
  const changes: Record<string, ChainAccount> = {
    [owner.toBase58()]: { ...ownerAccount, lamports: ownerAccount.lamports + SYNTHETIC.dammV2.feeBAccrued.toNumber() },
    [synaAta]: { ...synaAccount, data },
  };
  return postStatesFrom(changes);
}

export function createActionChain() {
  const chain = chainFixture();
  const postStates = claimPostStates(chain);
  const D = SYNTHETIC.dammV2;
  const summary: ChainSummary = {
    owner: chain.owner.publicKey.toBase58(),
    mints: chain.mints,
    dammV2: { unlocked: chain.dammV2.variants.unlocked, locked: chain.dammV2.variants.locked },
    cpmm: { pool: chain.cpmm.pool, lpMint: chain.cpmm.lpMint, lpAccount: chain.cpmm.lpAccount },
    amounts: {
      positionLiquidity: D.positionLiquidity.toString(),
      halfLiquidity: D.halfLiquidity.toString(),
      feeA: D.feeAPending.toString(),
      feeB: D.feeBAccrued.toString(),
      reward: D.rewardPending.toString(),
      cpmmOwnerLp: SYNTHETIC.cpmm.ownerLp.toString(),
    },
  };
  return {
    summary,
    answer: (body: unknown) => answerRpc(chain, body, { postStates }),
  };
}
