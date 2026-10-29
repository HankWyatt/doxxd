// Pure types and constants for on-site LP actions. No web3.js or SDK imports:
// the UI imports this statically (the SDKs load only in the lazy build chunk).

export type ActionProtocol =
  | "meteora-damm-v2"
  | "raydium-clmm"
  | "raydium-cpmm"
  | "raydium-amm-v4";

/** The only program each protocol's DMND rows may name for actions to apply. */
export const ACTION_PROGRAM_IDS: Record<ActionProtocol, string> = {
  "meteora-damm-v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "raydium-clmm": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "raydium-cpmm": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "raydium-amm-v4": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
};

export type Leg = {
  mint: string;
  decimals: number | null;
  symbol: string | null;
};

export type DammV2Target = {
  protocol: "meteora-damm-v2";
  id: string;
  pool: string;
  position: string;
  positionMint: string;
  positionNftAccount: string;
  nftTokenProgram: string;
  program: string;
  liquidity: {
    unlocked: string;
    vested: string;
    permanentLocked: string;
    total: string;
  };
  feeAAtoms: string;
  feeBAtoms: string;
  rewards: { index: number; mint: string; atoms: string }[];
  tokenA: Leg;
  tokenB: Leg;
  snapshotSlot: number;
};

export type ClmmTarget = {
  protocol: "raydium-clmm";
  id: string;
  pool: string;
  position: string;
  positionMint: string;
  positionNftAccount: string;
  nftTokenProgram: string;
  program: string;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  feeOwedAAtoms: string;
  feeOwedBAtoms: string;
  rewards: { mint: string; atoms: string }[];
  tokenA: Leg;
  tokenB: Leg;
  snapshotSlot: number;
};

export type FungibleTarget = {
  protocol: "raydium-cpmm" | "raydium-amm-v4";
  id: string;
  pool: string | null;
  lpMint: string;
  lpAccount: string;
  lpAtoms: string;
  lpDecimals: number;
  withdrawalAvailable: boolean | null;
  legs: Leg[];
  snapshotSlot: number;
};

export type ActionTarget = DammV2Target | ClmmTarget | FungibleTarget;
