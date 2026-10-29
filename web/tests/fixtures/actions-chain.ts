// Synthetic on-chain state for the wallet-action builders and runner.
//
// Every key comes from a fixed seed of repeated bytes (Keypair.fromSeed) or
// is a program-derived address of those keys. Amounts are round, made-up
// numbers. Only the program IDs and the wSOL mint are real addresses.
//
// Accounts are encoded with the protocols' own coders, never by hand:
// - cp-amm (Meteora DAMM v2): the IDL's BorshAccountsCoder (`cpAmmCoder`);
// - Raydium CLMM, CPMM and AMM v4, and OpenBook: the SDK's layouts;
// - SPL Token and Token-2022: @solana/spl-token's layouts.
// Each state starts as the coder's decoding of an all-zero account, so every
// field the coder knows is present; the fixture then sets the ones it means.
import { createHash } from "node:crypto";
import {
  cpAmmCoder,
  derivePoolAddress,
  derivePoolAuthority,
  derivePositionAddress,
  derivePositionNftAccount,
  deriveRewardVaultAddress,
  deriveTokenVaultAddress,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";
import {
  ClmmConfigLayout,
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  getAssociatedPoolKeys,
  getCreatePoolKeys,
  getPdaExBitmapAccount,
  getPdaObservationAccount,
  getPdaPersonalPositionAddress,
  getPdaPoolAuthority,
  getPdaPoolId,
  getPdaPoolRewardVaultId,
  getPdaPoolVaultId,
  getPdaTickArrayAddress,
  liquidityStateV4Layout,
  Market,
  MARKET_STATE_LAYOUT_V3,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickArrayBitmapExtensionLayout,
  TickArrayLayout,
} from "@raydium-io/raydium-sdk-v2";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  AccountType,
  ExtensionType,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getMintLen,
  LENGTH_SIZE,
  MintLayout,
  TRANSFER_FEE_AMOUNT_SIZE,
  TRANSFER_FEE_CONFIG_SIZE,
  TransferFeeAmountLayout,
  TransferFeeConfigLayout,
  TYPE_SIZE,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const PROGRAM_IDS = {
  system: "11111111111111111111111111111111",
  sysvar: "Sysvar1111111111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  cpAmm: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  clmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  cpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  ammV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  openBook: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
} as const;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";

const pow2 = (n: number) => new BN(1).shln(n);

// The numbers the fixture encodes, so tests can assert against them.
export const SYNTHETIC = {
  clock: {
    slot: 1_000,
    blockHeight: 900,
    lastValidBlockHeight: 1_050,
    epoch: 0,
    unixTimestamp: 1_800_000_000,
  },
  ownerLamports: 2_000_000_000,
  transferFeeBps: 100,
  transferFeeMax: 1_000_000_000,
  dammV2: {
    sqrtPrice: pow2(64), // price 1
    positionLiquidity: pow2(104),
    halfLiquidity: pow2(103),
    // Four positions of 2^104 in the wSOL pool.
    poolLiquidity: pow2(106),
    feeAPending: new BN(250_000_000),
    // Accrued from the pool's fee-per-liquidity growth: 2^104 × X >> 128.
    feeBAccrued: new BN(125_000_000),
    rewardPending: new BN(50_000_000),
    // The vesting account: 2^102 released at a cliff already passed, then
    // 4 periods of 2^100 that start only after 2055, whatever "now" is.
    releasableVesting: pow2(102),
    // Inner vesting (Position.inner_vesting, no Vesting account), each with
    // 2^103 vesting liquidity, against the clock's unix time:
    // - innerElapsed: unlocked 0; 2^102 at a passed cliff plus 4 × 2^100
    //   periods that all ended, so everything is releasable;
    // - innerPartial: unlocked 2^103; 2^101 at a passed cliff plus 6 × 2^100
    //   periods of 1e8 s, one of which has passed (3 × 2^100 releasable);
    // - innerBeforeCliff: unlocked 2^103; cliff in the future, nothing releasable.
    innerPartialReleasable: pow2(100).muln(3),
    transferFeePoolFees: new BN(10_000_000),
  },
  clmm: {
    tickSpacing: 60,
    tickLower: -3_600,
    tickUpper: 3_600,
    liquidity: new BN("10000000000000"),
    sqrtPriceX64: pow2(64), // tick 0
    feesOwedA: new BN(1_000_000),
    feesOwedB: new BN(2_000_000),
    // A second pool with tick spacing 1, whose position's tick arrays lie
    // beyond the default bitmap (±60 × 512 ticks), and three reward slots.
    wide: {
      tickSpacing: 1,
      tickLower: -40_000,
      tickUpper: 40_000,
      liquidity: new BN("1000000000000"),
      feesOwedA: new BN(3_000_000),
      feesOwedB: new BN(4_000_000),
      rewardsOwed: [new BN(5_000_000), new BN(6_000_000), new BN(7_000_000)],
    },
  },
  cpmm: {
    lpSupply: new BN("1000000000000"),
    ownerLp: new BN("100000000000"),
    reserveWsol: new BN("100000000000"),
    reserveSynb: new BN("5000000000"),
    // A second pool, SYNT (Token-2022, 1% transfer fee) / SYNA, whose vaults
    // also hold creator fees.
    transferFee: {
      lpSupply: new BN("2000000000000"),
      ownerLp: new BN("400000000000"),
      reserveSynt: new BN("3000000000"),
      reserveSyna: new BN("6000000000000"),
      creatorFeeSynt: new BN(3_000_000),
      creatorFeeSyna: new BN(4_000_000),
    },
  },
  ammV4: {
    lpSupply: new BN("1000000000"),
    ownerLp: new BN("100000000"),
    reserveSync: new BN("5000000000"),
    reserveWsol: new BN("100000000000"),
    // A pool created without an OpenBook market (raydium-amm after "Remove
    // openbook dependency"): SYNA / wSOL, with open orders and the market
    // program set to the default key and no market account.
    marketless: {
      lpSupply: new BN("2000000000"),
      ownerLp: new BN("500000000"),
      reserveSyna: new BN("4000000000000"),
      reserveWsol: new BN("20000000000"),
    },
  },
};

export type ChainAccount = { data: Buffer; owner: string; lamports: number };

export type DammV2Fixture = {
  pool: string;
  position: string;
  positionMint: string;
  positionNftAccount: string;
  vesting?: string;
};

export type SyntheticChain = {
  owner: Keypair;
  accounts: Map<string, ChainAccount>;
  mints: { syna: string; synb: string; synt: string; sync: string; reward: string; wsol: string };
  // The top level is the unlocked position; `variants` holds all eight.
  dammV2: DammV2Fixture & {
    variants: Record<
      | "unlocked"
      | "vested"
      | "locked"
      | "noFees"
      | "transferFee"
      | "innerElapsed"
      | "innerPartial"
      | "innerBeforeCliff",
      DammV2Fixture
    >;
  };
  clmm: {
    pool: string;
    position: string;
    positionMint: string;
    positionNftAccount: string;
    tickArrays: string[];
    config: string;
    bitmapExtension: string;
    // SYNA/wSOL, tick spacing 1, rewards in REWARD, SYNR1 (Token) and SYNR2
    // (Token-2022); a Token position NFT held in the owner's ATA.
    wide: {
      pool: string;
      position: string;
      positionMint: string;
      positionNftAccount: string;
      tickArrays: string[];
      bitmapExtension: string;
      rewardMints: string[];
      rewardVaults: string[];
    };
  };
  // `lpAccount`: the owner's LP token account (its ATA of the LP mint).
  cpmm: {
    pool: string;
    lpMint: string;
    lpAccount: string;
    config: string;
    authority: string;
    transferFee: { pool: string; lpMint: string; lpAccount: string };
  };
  ammV4: {
    pool: string;
    lpMint: string;
    lpAccount: string;
    market: string;
    authority: string;
    marketAuthority: string;
    // SYNA/wSOL without a market; `marketSeed` is the account stored as its
    // market, which does not exist on chain.
    marketless: { pool: string; lpMint: string; lpAccount: string; authority: string; marketSeed: string };
  };
};

const seeded = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte));
const key = (byte: number) => seeded(byte).publicKey;
const DEFAULT_KEY = PublicKey.default;
const rentExempt = (size: number) => (size + 128) * 6_960;

// Overlay `patch` onto a decoded state: plain objects and arrays merge by
// key or index; anything else (numbers, BN, PublicKey, Buffer) replaces.
function overlay(target: unknown, patch: unknown): unknown {
  const mergeable = (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);
  if (!mergeable(target) || !mergeable(patch)) return patch;
  const t = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) t[k] = overlay(t[k], v);
  return target;
}

const u256 = (value: BN) => [...value.toArrayLike(Buffer, "le", 32)];

// cp-amm accounts through the IDL coder. BorshAccountsCoder.encode writes into
// a fixed 1,000-byte buffer (anchor 0.31.1 coder/borsh/accounts.js:40), too
// small for the 1,104-byte Pool body, so this uses the same coder's layout for
// the account's exact size.
type CpAmmAccount = "Pool" | "Position" | "Vesting";
function encodeCpAmm(name: CpAmmAccount, patch: Record<string, unknown>): Buffer {
  const coder = cpAmmCoder.accounts;
  const discriminator = coder.accountDiscriminator(name);
  const body = Buffer.alloc(coder.size(name) - discriminator.length);
  const state = overlay(coder.decode(name, Buffer.concat([discriminator, body])), patch);
  const layouts = (
    coder as unknown as {
      accountLayouts: Map<string, { layout: { encode(src: unknown, b: Buffer): number } }>;
    }
  ).accountLayouts;
  layouts.get(name)!.layout.encode(state, body);
  return Buffer.concat([discriminator, body]);
}

type Layout = {
  span: number;
  decode(b: Buffer): unknown;
  encode(src: unknown, b: Buffer): number;
};
// Raydium's layouts start with an unnamed 8-byte blob for the Anchor
// discriminator (sha256("account:<Name>")[..8]), which they skip on encode.
function encodeLayout(layout: Layout, patch: Record<string, unknown>, anchorName?: string): Buffer {
  const data = Buffer.alloc(layout.span);
  layout.encode(overlay(layout.decode(data), patch), data);
  if (anchorName)
    createHash("sha256").update(`account:${anchorName}`).digest().copy(data, 0, 0, 8);
  return data;
}

type TlvExtension = { type: ExtensionType; data: Buffer };
// Token-2022 layout: the base state, zero padding to 165 bytes, an account
// type byte, then type-length-value extensions.
function withExtensions(base: Buffer, accountType: AccountType, extensions: TlvExtension[]): Buffer {
  if (!extensions.length) return base;
  const head = Buffer.alloc(ACCOUNT_SIZE + 1);
  base.copy(head);
  head[ACCOUNT_SIZE] = accountType;
  const parts = extensions.map(({ type, data }) => {
    const tl = Buffer.alloc(TYPE_SIZE + LENGTH_SIZE);
    tl.writeUInt16LE(type, 0);
    tl.writeUInt16LE(data.length, TYPE_SIZE);
    return Buffer.concat([tl, data]);
  });
  return Buffer.concat([head, ...parts]);
}

function mintData(opts: {
  decimals: number;
  supply: BN;
  authority?: PublicKey;
  extensions?: TlvExtension[];
}): Buffer {
  const base = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: opts.authority ? 1 : 0,
      mintAuthority: opts.authority ?? DEFAULT_KEY,
      supply: BigInt(opts.supply.toString()),
      decimals: opts.decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: DEFAULT_KEY,
    },
    base,
  );
  return withExtensions(base, AccountType.Mint, opts.extensions ?? []);
}

/** SPL Token / Token-2022 account bytes (AccountLayout plus any TLV extensions). */
export function tokenAccountData(opts: {
  mint: PublicKey;
  owner: PublicKey;
  amount: BN;
  nativeReserve?: number;
  extensions?: TlvExtension[];
}): Buffer {
  const base = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: opts.mint,
      owner: opts.owner,
      amount: BigInt(opts.amount.toString()),
      delegateOption: 0,
      delegate: DEFAULT_KEY,
      state: AccountState.Initialized,
      isNativeOption: opts.nativeReserve === undefined ? 0 : 1,
      isNative: BigInt(opts.nativeReserve ?? 0),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: DEFAULT_KEY,
    },
    base,
  );
  return withExtensions(base, AccountType.Account, opts.extensions ?? []);
}

function transferFeeConfig(bps: number, maximumFee: number, authority: PublicKey): TlvExtension {
  const data = Buffer.alloc(TRANSFER_FEE_CONFIG_SIZE);
  const fee = { epoch: BigInt(0), maximumFee: BigInt(maximumFee), transferFeeBasisPoints: bps };
  TransferFeeConfigLayout.encode(
    {
      transferFeeConfigAuthority: authority,
      withdrawWithheldAuthority: authority,
      withheldAmount: BigInt(0),
      olderTransferFee: fee,
      newerTransferFee: fee,
    },
    data,
  );
  return { type: ExtensionType.TransferFeeConfig, data };
}

function transferFeeAmount(): TlvExtension {
  const data = Buffer.alloc(TRANSFER_FEE_AMOUNT_SIZE);
  TransferFeeAmountLayout.encode({ withheldAmount: BigInt(0) }, data);
  return { type: ExtensionType.TransferFeeAmount, data };
}

const immutableOwner = (): TlvExtension => ({
  type: ExtensionType.ImmutableOwner,
  data: Buffer.alloc(0),
});

// Order a pair of mints the way Raydium's pools require (mintA < mintB).
const ordered = (a: PublicKey, b: PublicKey): [PublicKey, PublicKey] =>
  Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];

export function chainFixture(): SyntheticChain {
  const accounts = new Map<string, ChainAccount>();
  const put = (address: PublicKey | string, owner: string, data: Buffer, lamports?: number) =>
    accounts.set(String(address), {
      data,
      owner,
      lamports: lamports ?? rentExempt(data.length),
    });

  const owner = seeded(7);
  const wallet = owner.publicKey;
  const mintAuthority = key(61);
  const token = new PublicKey(PROGRAM_IDS.token);

  // --- Mints ---------------------------------------------------------------
  const wsol = new PublicKey(WSOL_MINT);
  const syna = key(11); // Token, 9 decimals
  const synb = key(12); // Token, 6 decimals
  const synt = key(13); // Token-2022 with a 1% transfer fee, 6 decimals
  const sync = key(14); // Token, 6 decimals (AMM v4 base)
  const reward = key(15); // Token, 6 decimals (DAMM v2 and CLMM reward)
  const synr1 = key(17); // Token, 6 decimals (CLMM reward)
  const synr2 = key(18); // Token-2022 without extensions, 6 decimals (CLMM reward)
  const decimals = new Map<string, number>([
    [String(wsol), 9],
    [String(syna), 9],
    [String(synb), 6],
    [String(synt), 6],
    [String(sync), 6],
    [String(reward), 6],
    [String(synr1), 6],
    [String(synr2), 6],
  ]);
  const programOf = (mint: PublicKey) =>
    mint.equals(synt) || mint.equals(synr2) ? PROGRAM_IDS.token2022 : PROGRAM_IDS.token;
  const supply = new BN("1000000000000000000");
  put(wsol, PROGRAM_IDS.token, mintData({ decimals: 9, supply: new BN(0) }));
  for (const mint of [syna, synb, sync, reward, synr1])
    put(mint, PROGRAM_IDS.token, mintData({ decimals: decimals.get(String(mint))!, supply, authority: mintAuthority }));
  put(
    synt,
    PROGRAM_IDS.token2022,
    mintData({
      decimals: 6,
      supply,
      authority: mintAuthority,
      extensions: [transferFeeConfig(SYNTHETIC.transferFeeBps, SYNTHETIC.transferFeeMax, key(72))],
    }),
  );
  put(synr2, PROGRAM_IDS.token2022, mintData({ decimals: 6, supply, authority: mintAuthority }));
  if (accounts.get(String(synt))!.data.length !== getMintLen([ExtensionType.TransferFeeConfig]))
    throw new Error("Token-2022 mint length drifted");

  // A token account of `mint`, held by `holder`. wSOL accounts are native:
  // their lamports are the token amount plus the rent reserve.
  const putTokenAccount = (address: PublicKey, mint: PublicKey, holder: PublicKey, amount: BN, ata = false) => {
    const program = programOf(mint);
    if (mint.equals(wsol)) {
      const reserve = rentExempt(ACCOUNT_SIZE);
      const data = tokenAccountData({ mint, owner: holder, amount, nativeReserve: reserve });
      return put(address, program, data, reserve + amount.toNumber());
    }
    const extensions =
      program === PROGRAM_IDS.token2022 ? [...(ata ? [immutableOwner()] : []), transferFeeAmount()] : [];
    put(address, program, tokenAccountData({ mint, owner: holder, amount, extensions }));
  };
  const ownerAta = (mint: PublicKey) =>
    getAssociatedTokenAddressSync(mint, wallet, false, new PublicKey(programOf(mint)));

  // --- The owner -----------------------------------------------------------
  put(wallet, PROGRAM_IDS.system, Buffer.alloc(0), SYNTHETIC.ownerLamports);
  putTokenAccount(ownerAta(syna), syna, wallet, new BN("10000000000"), true);
  putTokenAccount(ownerAta(synb), synb, wallet, new BN(0), true);
  putTokenAccount(ownerAta(synt), synt, wallet, new BN(0), true);
  if (accounts.get(String(ownerAta(synt)))!.data.length !==
    getAccountLen([ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount]))
    throw new Error("Token-2022 account length drifted");
  // No wSOL, SYNC or reward ATA: builders create them idempotently.

  // Clock sysvar, so builders can read the cluster time with getAccountInfo
  // (the pass-through has no getBlockTime). Layout: slot, epoch start
  // timestamp, epoch, leader schedule epoch, unix timestamp (u64/i64 LE).
  const clock = Buffer.alloc(40);
  clock.writeBigUInt64LE(BigInt(SYNTHETIC.clock.slot), 0);
  clock.writeBigInt64LE(BigInt(SYNTHETIC.clock.unixTimestamp - 400), 8);
  clock.writeBigUInt64LE(BigInt(SYNTHETIC.clock.epoch), 16);
  clock.writeBigUInt64LE(BigInt(SYNTHETIC.clock.epoch + 1), 24);
  clock.writeBigInt64LE(BigInt(SYNTHETIC.clock.unixTimestamp), 32);
  put(CLOCK_SYSVAR, PROGRAM_IDS.sysvar, clock);

  // --- Meteora DAMM v2 -----------------------------------------------------
  const D = SYNTHETIC.dammV2;
  const dammConfig = key(41);
  const poolAuthority = derivePoolAuthority();
  const positionMints = {
    unlocked: key(21),
    vested: key(22),
    locked: key(23),
    noFees: key(24),
    transferFee: key(25),
    innerElapsed: key(27),
    innerPartial: key(28),
    innerBeforeCliff: key(29),
  };
  const feeBPerLiquidity = D.feeBAccrued.shln(24); // 2^104 × (X << 24) >> 128 = X
  const rewardEnd = new BN(1_700_000_000); // in the past: no further accrual

  const putDammPool = (opts: {
    mintA: PublicKey;
    mintB: PublicKey;
    liquidity: BN;
    permanentLock: BN;
    activationType: number;
    vaultAmounts: [BN, BN];
    reward?: PublicKey;
  }) => {
    const pool = derivePoolAddress(dammConfig, opts.mintA, opts.mintB);
    const vaultA = deriveTokenVaultAddress(opts.mintA, pool);
    const vaultB = deriveTokenVaultAddress(opts.mintB, pool);
    const flag = (mint: PublicKey) => (programOf(mint) === PROGRAM_IDS.token2022 ? 1 : 0);
    const rewardVault = deriveRewardVaultAddress(pool, 0);
    put(
      pool,
      PROGRAM_IDS.cpAmm,
      encodeCpAmm("Pool", {
        token_a_mint: opts.mintA,
        token_b_mint: opts.mintB,
        token_a_vault: vaultA,
        token_b_vault: vaultB,
        liquidity: opts.liquidity,
        sqrt_min_price: MIN_SQRT_PRICE,
        sqrt_max_price: MAX_SQRT_PRICE,
        sqrt_price: D.sqrtPrice,
        activation_type: opts.activationType,
        token_a_flag: flag(opts.mintA),
        token_b_flag: flag(opts.mintB),
        collect_fee_mode: 0, // both tokens
        fee_version: 1,
        layout_version: 1,
        fee_b_per_liquidity: u256(opts.reward ? feeBPerLiquidity : new BN(0)),
        permanent_lock_liquidity: opts.permanentLock,
        creator: key(63),
        token_a_amount: opts.vaultAmounts[0],
        token_b_amount: opts.vaultAmounts[1],
        reward_infos: opts.reward
          ? {
              0: {
                initialized: 1,
                reward_token_flag: 0,
                mint: opts.reward,
                vault: rewardVault,
                funder: key(62),
                reward_duration: new BN(604_800),
                reward_duration_end: rewardEnd,
                reward_rate: new BN(0),
                last_update_time: rewardEnd,
              },
            }
          : {},
      }),
    );
    putTokenAccount(vaultA, opts.mintA, poolAuthority, opts.vaultAmounts[0]);
    putTokenAccount(vaultB, opts.mintB, poolAuthority, opts.vaultAmounts[1]);
    if (opts.reward) putTokenAccount(rewardVault, opts.reward, poolAuthority, new BN("1000000000"));
    return pool;
  };

  const wsolPool = putDammPool({
    mintA: syna,
    mintB: wsol,
    liquidity: D.poolLiquidity,
    permanentLock: D.halfLiquidity,
    activationType: 1, // timestamp
    vaultAmounts: [new BN("5000000000000"), new BN("5000000000000")],
    reward,
  });
  const transferFeePool = putDammPool({
    mintA: synt,
    mintB: synb,
    liquidity: D.positionLiquidity,
    permanentLock: new BN(0),
    activationType: 0, // slot
    vaultAmounts: [new BN("2000000000000"), new BN("2000000000000")],
  });

  const putDammPosition = (
    pool: PublicKey,
    mint: PublicKey,
    liquidity: { unlocked: BN; vested?: BN; locked?: BN },
    fees: "earning" | "none" | "transferFee",
    innerVesting?: Record<string, BN | number>,
  ): DammV2Fixture => {
    const position = derivePositionAddress(mint);
    const nftAccount = derivePositionNftAccount(mint);
    const earning = fees === "earning";
    put(
      position,
      PROGRAM_IDS.cpAmm,
      encodeCpAmm("Position", {
        pool,
        nft_mint: mint,
        fee_b_per_token_checkpoint: u256(fees === "none" ? feeBPerLiquidity : new BN(0)),
        fee_a_pending: earning ? D.feeAPending : fees === "transferFee" ? D.transferFeePoolFees : new BN(0),
        fee_b_pending: fees === "transferFee" ? D.transferFeePoolFees : new BN(0),
        unlocked_liquidity: liquidity.unlocked,
        vested_liquidity: liquidity.vested ?? new BN(0),
        permanent_locked_liquidity: liquidity.locked ?? new BN(0),
        reward_infos: { 0: { reward_pendings: earning ? D.rewardPending : new BN(0) } },
        ...(innerVesting ? { inner_vesting: innerVesting } : {}),
      }),
    );
    // Position NFTs are Token-2022 mints held in a PDA token account.
    put(mint, PROGRAM_IDS.token2022, mintData({ decimals: 0, supply: new BN(1), authority: poolAuthority }));
    put(
      nftAccount,
      PROGRAM_IDS.token2022,
      tokenAccountData({ mint, owner: wallet, amount: new BN(1) }),
    );
    return {
      pool: String(pool),
      position: String(position),
      positionMint: String(mint),
      positionNftAccount: String(nftAccount),
    };
  };

  const full = D.positionLiquidity;
  const half = D.halfLiquidity;
  const variants = {
    unlocked: putDammPosition(wsolPool, positionMints.unlocked, { unlocked: full }, "earning"),
    vested: putDammPosition(wsolPool, positionMints.vested, { unlocked: half, vested: half }, "earning"),
    locked: putDammPosition(wsolPool, positionMints.locked, { unlocked: half, locked: half }, "earning"),
    noFees: putDammPosition(wsolPool, positionMints.noFees, { unlocked: full }, "none"),
    transferFee: putDammPosition(transferFeePool, positionMints.transferFee, { unlocked: full }, "transferFee"),
    innerElapsed: putDammPosition(wsolPool, positionMints.innerElapsed, { unlocked: new BN(0), vested: half }, "earning", {
      cliff_point: new BN(1_700_000_000),
      period_frequency: new BN(1_000),
      cliff_unlock_liquidity: pow2(102),
      liquidity_per_period: pow2(100),
      number_of_period: 4,
    }),
    innerPartial: putDammPosition(wsolPool, positionMints.innerPartial, { unlocked: half, vested: half }, "earning", {
      cliff_point: new BN(1_700_000_000),
      period_frequency: new BN(100_000_000),
      cliff_unlock_liquidity: pow2(101),
      liquidity_per_period: pow2(100),
      number_of_period: 6,
    }),
    innerBeforeCliff: putDammPosition(wsolPool, positionMints.innerBeforeCliff, { unlocked: half, vested: half }, "earning", {
      cliff_point: new BN(1_900_000_000),
      period_frequency: new BN(100_000_000),
      cliff_unlock_liquidity: pow2(102),
      liquidity_per_period: pow2(100),
      number_of_period: 4,
    }),
  };
  const vesting = key(51);
  put(
    vesting,
    PROGRAM_IDS.cpAmm,
    encodeCpAmm("Vesting", {
      position: new PublicKey(variants.vested.position),
      inner_vesting: {
        cliff_point: new BN(1_700_000_000),
        period_frequency: new BN(1_000_000_000),
        cliff_unlock_liquidity: D.releasableVesting,
        liquidity_per_period: pow2(100),
        total_released_liquidity: new BN(0),
        number_of_period: 4,
      },
    }),
  );
  variants.vested.vesting = String(vesting);

  // --- Raydium CLMM --------------------------------------------------------
  const C = SYNTHETIC.clmm;
  const clmmProgram = new PublicKey(PROGRAM_IDS.clmm);
  const clmmConfig = key(42);
  put(
    clmmConfig,
    PROGRAM_IDS.clmm,
    encodeLayout(
      ClmmConfigLayout,
      {
        bump: 255,
        index: 0,
        owner: key(65),
        protocolFeeRate: 120_000,
        tradeFeeRate: 2_500,
        tickSpacing: C.tickSpacing,
        fundFeeRate: 40_000,
        fundOwner: key(65),
      },
      "AmmConfig",
    ),
  );
  const [clmmMintA, clmmMintB] = ordered(wsol, synt);
  const clmmPoolPda = getPdaPoolId(clmmProgram, clmmConfig, clmmMintA, clmmMintB);
  const clmmPool = clmmPoolPda.publicKey;
  const clmmVaultA = getPdaPoolVaultId(clmmProgram, clmmPool, clmmMintA).publicKey;
  const clmmVaultB = getPdaPoolVaultId(clmmProgram, clmmPool, clmmMintB).publicKey;
  const tickArrayStarts = [C.tickLower, C.tickUpper];
  // Tick-array bitmap: bit (start / (spacing × 60)) + 512 marks an array.
  const bitmap = Buffer.alloc(128);
  for (const start of tickArrayStarts) {
    const bit = start / (C.tickSpacing * 60) + 512;
    bitmap[bit >> 3] |= 1 << (bit & 7);
  }
  put(
    clmmPool,
    PROGRAM_IDS.clmm,
    encodeLayout(
      PoolInfoLayout,
      {
        bump: clmmPoolPda.nonce,
        configId: clmmConfig,
        creator: key(63),
        mintA: clmmMintA,
        mintB: clmmMintB,
        vaultA: clmmVaultA,
        vaultB: clmmVaultB,
        observationId: getPdaObservationAccount(clmmProgram, clmmPool).publicKey,
        mintDecimalsA: decimals.get(String(clmmMintA)),
        mintDecimalsB: decimals.get(String(clmmMintB)),
        tickSpacing: C.tickSpacing,
        liquidity: C.liquidity,
        sqrtPriceX64: C.sqrtPriceX64,
        tickCurrent: 0,
        tickArrayBitmap: bitmap,
      },
      "PoolState",
    ),
  );
  for (const [mint, vault] of [
    [clmmMintA, clmmVaultA],
    [clmmMintB, clmmVaultB],
  ] as const)
    putTokenAccount(vault, mint, clmmPool, new BN("2000000000000"));
  const bitmapExtension = getPdaExBitmapAccount(clmmProgram, clmmPool).publicKey;
  put(
    bitmapExtension,
    PROGRAM_IDS.clmm,
    encodeLayout(TickArrayBitmapExtensionLayout, { poolId: clmmPool }, "TickArrayBitmapExtension"),
  );
  const tickArrays = tickArrayStarts.map((start, i) => {
    const address = getPdaTickArrayAddress(clmmProgram, clmmPool, start).publicKey;
    // Each bound is the first tick of its array; lower adds, upper removes.
    const net = i === 0 ? C.liquidity : C.liquidity.neg();
    put(
      address,
      PROGRAM_IDS.clmm,
      encodeLayout(
        TickArrayLayout,
        {
          poolId: clmmPool,
          startTickIndex: start,
          ticks: { 0: { tick: start, liquidityNet: net, liquidityGross: C.liquidity } },
          initializedTickCount: 1,
        },
        "TickArrayState",
      ),
    );
    return String(address);
  });
  const clmmNftMint = key(26);
  const clmmPositionPda = getPdaPersonalPositionAddress(clmmProgram, clmmNftMint);
  put(
    clmmPositionPda.publicKey,
    PROGRAM_IDS.clmm,
    encodeLayout(
      PersonalPositionLayout,
      {
        bump: clmmPositionPda.nonce,
        nftMint: clmmNftMint,
        poolId: clmmPool,
        tickLower: C.tickLower,
        tickUpper: C.tickUpper,
        liquidity: C.liquidity,
        tokenFeesOwedA: C.feesOwedA,
        tokenFeesOwedB: C.feesOwedB,
      },
      "PersonalPositionState",
    ),
  );
  // A Token-2022 position NFT held in a token account that is not the
  // owner's ATA, so a builder that assumes the ATA fails here.
  put(clmmNftMint, PROGRAM_IDS.token2022, mintData({ decimals: 0, supply: new BN(1) }));
  const clmmNftAccount = key(31);
  put(
    clmmNftAccount,
    PROGRAM_IDS.token2022,
    tokenAccountData({ mint: clmmNftMint, owner: wallet, amount: new BN(1) }),
  );

  // A second CLMM pool: SYNA/wSOL at tick spacing 1, so a position at
  // ±40,000 has tick arrays outside the default bitmap and its decreases
  // carry the bitmap extension; three initialized reward slots.
  const W = C.wide;
  const wideConfig = key(46);
  put(
    wideConfig,
    PROGRAM_IDS.clmm,
    encodeLayout(
      ClmmConfigLayout,
      {
        bump: 255,
        index: 1,
        owner: key(65),
        protocolFeeRate: 120_000,
        tradeFeeRate: 100,
        tickSpacing: W.tickSpacing,
        fundFeeRate: 40_000,
        fundOwner: key(65),
      },
      "AmmConfig",
    ),
  );
  const [wideMintA, wideMintB] = ordered(wsol, syna);
  const widePoolPda = getPdaPoolId(clmmProgram, wideConfig, wideMintA, wideMintB);
  const widePool = widePoolPda.publicKey;
  const wideVaultA = getPdaPoolVaultId(clmmProgram, widePool, wideMintA).publicKey;
  const wideVaultB = getPdaPoolVaultId(clmmProgram, widePool, wideMintB).publicKey;
  const wideRewardMints = [reward, synr1, synr2];
  const wideRewardVaults = wideRewardMints.map((mint) => getPdaPoolRewardVaultId(clmmProgram, widePool, mint).publicKey);
  // Tick arrays hold 60 ticks × spacing; starts round down.
  const wideStarts = [W.tickLower, W.tickUpper].map((tick) => Math.floor(tick / (60 * W.tickSpacing)) * 60 * W.tickSpacing);
  put(
    widePool,
    PROGRAM_IDS.clmm,
    encodeLayout(
      PoolInfoLayout,
      {
        bump: widePoolPda.nonce,
        configId: wideConfig,
        creator: key(63),
        mintA: wideMintA,
        mintB: wideMintB,
        vaultA: wideVaultA,
        vaultB: wideVaultB,
        observationId: getPdaObservationAccount(clmmProgram, widePool).publicKey,
        mintDecimalsA: decimals.get(String(wideMintA)),
        mintDecimalsB: decimals.get(String(wideMintB)),
        tickSpacing: W.tickSpacing,
        liquidity: W.liquidity,
        sqrtPriceX64: C.sqrtPriceX64,
        tickCurrent: 0,
        rewardInfos: Object.fromEntries(
          wideRewardMints.map((mint, i) => [
            i,
            {
              state: 2, // opening
              openTime: new BN(SYNTHETIC.clock.unixTimestamp - 86_400),
              endTime: new BN(SYNTHETIC.clock.unixTimestamp + 86_400),
              lastUpdateTime: new BN(SYNTHETIC.clock.unixTimestamp),
              mint,
              vault: wideRewardVaults[i],
              creator: key(62),
            },
          ]),
        ),
      },
      "PoolState",
    ),
  );
  putTokenAccount(wideVaultA, wideMintA, widePool, new BN("2000000000000"));
  putTokenAccount(wideVaultB, wideMintB, widePool, new BN("2000000000000"));
  wideRewardMints.forEach((mint, i) => putTokenAccount(wideRewardVaults[i], mint, widePool, new BN("1000000000")));
  const wideBitmapExtension = getPdaExBitmapAccount(clmmProgram, widePool).publicKey;
  put(
    wideBitmapExtension,
    PROGRAM_IDS.clmm,
    encodeLayout(TickArrayBitmapExtensionLayout, { poolId: widePool }, "TickArrayBitmapExtension"),
  );
  const wideTickArrays = wideStarts.map((start, i) => {
    const address = getPdaTickArrayAddress(clmmProgram, widePool, start).publicKey;
    const tick = i === 0 ? W.tickLower : W.tickUpper;
    const net = i === 0 ? W.liquidity : W.liquidity.neg();
    put(
      address,
      PROGRAM_IDS.clmm,
      encodeLayout(
        TickArrayLayout,
        {
          poolId: widePool,
          startTickIndex: start,
          ticks: { [(tick - start) / W.tickSpacing]: { tick, liquidityNet: net, liquidityGross: W.liquidity } },
          initializedTickCount: 1,
        },
        "TickArrayState",
      ),
    );
    return String(address);
  });
  // A Token (not Token-2022) position NFT in the owner's ATA.
  const wideNftMint = key(32);
  const widePositionPda = getPdaPersonalPositionAddress(clmmProgram, wideNftMint);
  put(
    widePositionPda.publicKey,
    PROGRAM_IDS.clmm,
    encodeLayout(
      PersonalPositionLayout,
      {
        bump: widePositionPda.nonce,
        nftMint: wideNftMint,
        poolId: widePool,
        tickLower: W.tickLower,
        tickUpper: W.tickUpper,
        liquidity: W.liquidity,
        tokenFeesOwedA: W.feesOwedA,
        tokenFeesOwedB: W.feesOwedB,
        rewardInfos: Object.fromEntries(W.rewardsOwed.map((owed, i) => [i, { rewardAmountOwed: owed }])),
      },
      "PersonalPositionState",
    ),
  );
  put(wideNftMint, PROGRAM_IDS.token, mintData({ decimals: 0, supply: new BN(1) }));
  const wideNftAccount = getAssociatedTokenAddressSync(wideNftMint, wallet, false, token);
  put(wideNftAccount, PROGRAM_IDS.token, tokenAccountData({ mint: wideNftMint, owner: wallet, amount: new BN(1) }));

  // --- Raydium CPMM --------------------------------------------------------
  const P = SYNTHETIC.cpmm;
  const cpmmProgram = new PublicKey(PROGRAM_IDS.cpmm);
  const cpmmConfig = key(43);
  put(
    cpmmConfig,
    PROGRAM_IDS.cpmm,
    encodeLayout(
      CpmmConfigInfoLayout,
      {
        bump: 255,
        index: 0,
        tradeFeeRate: new BN(2_500),
        protocolFeeRate: new BN(120_000),
        fundFeeRate: new BN(40_000),
        protocolOwner: key(65),
        fundOwner: key(65),
      },
      "AmmConfig",
    ),
  );
  const [cpmmMintA, cpmmMintB] = ordered(wsol, synb);
  const cpmmKeys = getCreatePoolKeys({ programId: cpmmProgram, configId: cpmmConfig, mintA: cpmmMintA, mintB: cpmmMintB });
  // Vaults hold reserves plus fees owed elsewhere; reserves exclude them.
  const cpmmFees = new Map([
    [String(wsol), { protocol: new BN(1_000_000), fund: new BN(500_000), reserve: P.reserveWsol }],
    [String(synb), { protocol: new BN(2_000_000), fund: new BN(1_000_000), reserve: P.reserveSynb }],
  ]);
  const feesA = cpmmFees.get(String(cpmmMintA))!;
  const feesB = cpmmFees.get(String(cpmmMintB))!;
  put(
    cpmmKeys.poolId,
    PROGRAM_IDS.cpmm,
    encodeLayout(
      CpmmPoolInfoLayout,
      {
        configId: cpmmConfig,
        poolCreator: key(63),
        vaultA: cpmmKeys.vaultA,
        vaultB: cpmmKeys.vaultB,
        mintLp: cpmmKeys.lpMint,
        mintA: cpmmMintA,
        mintB: cpmmMintB,
        mintProgramA: token,
        mintProgramB: token,
        observationId: cpmmKeys.observationId,
        bump: getPdaPoolAuthority(cpmmProgram).nonce,
        status: 0,
        lpDecimals: 9,
        mintDecimalA: decimals.get(String(cpmmMintA)),
        mintDecimalB: decimals.get(String(cpmmMintB)),
        lpAmount: P.lpSupply,
        protocolFeesMintA: feesA.protocol,
        protocolFeesMintB: feesB.protocol,
        fundFeesMintA: feesA.fund,
        fundFeesMintB: feesB.fund,
        creatorFeesMintA: new BN(0),
        creatorFeesMintB: new BN(0),
      },
      "PoolState",
    ),
  );
  for (const [mint, vault, fees] of [
    [cpmmMintA, cpmmKeys.vaultA, feesA],
    [cpmmMintB, cpmmKeys.vaultB, feesB],
  ] as const)
    putTokenAccount(vault, mint, cpmmKeys.authority, fees.reserve.add(fees.protocol).add(fees.fund));
  put(cpmmKeys.lpMint, PROGRAM_IDS.token, mintData({ decimals: 9, supply: P.lpSupply, authority: cpmmKeys.authority }));
  const cpmmLpAccount = getAssociatedTokenAddressSync(cpmmKeys.lpMint, wallet, false, token);
  putTokenAccount(cpmmLpAccount, cpmmKeys.lpMint, wallet, P.ownerLp);

  // The transfer-fee pool: same config, SYNT and SYNA, with creator fees.
  const T = P.transferFee;
  const [feeMintA, feeMintB] = ordered(synt, syna);
  const feeKeys = getCreatePoolKeys({ programId: cpmmProgram, configId: cpmmConfig, mintA: feeMintA, mintB: feeMintB });
  const feePoolFees = new Map([
    [String(synt), { protocol: new BN(1_000_000), fund: new BN(2_000_000), creator: T.creatorFeeSynt, reserve: T.reserveSynt }],
    [String(syna), { protocol: new BN(5_000_000), fund: new BN(6_000_000), creator: T.creatorFeeSyna, reserve: T.reserveSyna }],
  ]);
  const feeA = feePoolFees.get(String(feeMintA))!;
  const feeB = feePoolFees.get(String(feeMintB))!;
  put(
    feeKeys.poolId,
    PROGRAM_IDS.cpmm,
    encodeLayout(
      CpmmPoolInfoLayout,
      {
        configId: cpmmConfig,
        poolCreator: key(63),
        vaultA: feeKeys.vaultA,
        vaultB: feeKeys.vaultB,
        mintLp: feeKeys.lpMint,
        mintA: feeMintA,
        mintB: feeMintB,
        mintProgramA: new PublicKey(programOf(feeMintA)),
        mintProgramB: new PublicKey(programOf(feeMintB)),
        observationId: feeKeys.observationId,
        bump: getPdaPoolAuthority(cpmmProgram).nonce,
        status: 0,
        lpDecimals: 9,
        mintDecimalA: decimals.get(String(feeMintA)),
        mintDecimalB: decimals.get(String(feeMintB)),
        lpAmount: T.lpSupply,
        protocolFeesMintA: feeA.protocol,
        protocolFeesMintB: feeB.protocol,
        fundFeesMintA: feeA.fund,
        fundFeesMintB: feeB.fund,
        enableCreatorFee: true,
        creatorFeesMintA: feeA.creator,
        creatorFeesMintB: feeB.creator,
      },
      "PoolState",
    ),
  );
  for (const [mint, vault, fees] of [
    [feeMintA, feeKeys.vaultA, feeA],
    [feeMintB, feeKeys.vaultB, feeB],
  ] as const)
    putTokenAccount(vault, mint, feeKeys.authority, fees.reserve.add(fees.protocol).add(fees.fund).add(fees.creator));
  put(feeKeys.lpMint, PROGRAM_IDS.token, mintData({ decimals: 9, supply: T.lpSupply, authority: feeKeys.authority }));
  const feeLpAccount = getAssociatedTokenAddressSync(feeKeys.lpMint, wallet, false, token);
  putTokenAccount(feeLpAccount, feeKeys.lpMint, wallet, T.ownerLp);

  // --- Raydium AMM v4 and its OpenBook market ------------------------------
  const A = SYNTHETIC.ammV4;
  const market = key(45);
  const openBook = new PublicKey(PROGRAM_IDS.openBook);
  const ammKeys = getAssociatedPoolKeys({
    version: 4,
    marketVersion: 3,
    marketId: market,
    baseMint: sync,
    quoteMint: wsol,
    baseDecimals: 6,
    quoteDecimals: 9,
    programId: new PublicKey(PROGRAM_IDS.ammV4),
    marketProgramId: openBook,
  });
  const basePnl = new BN(1_000_000);
  const quotePnl = new BN(2_000_000);
  put(
    ammKeys.id,
    PROGRAM_IDS.ammV4,
    encodeLayout(liquidityStateV4Layout, {
      status: new BN(6),
      nonce: new BN(ammKeys.nonce),
      maxOrder: new BN(7),
      depth: new BN(3),
      baseDecimal: new BN(6),
      quoteDecimal: new BN(9),
      state: new BN(1),
      minSize: new BN(1_000_000),
      volMaxCutRatio: new BN(500),
      amountWaveRatio: new BN(5_000_000),
      baseLotSize: new BN(1_000),
      quoteLotSize: new BN(1),
      minPriceMultiplier: new BN(1),
      maxPriceMultiplier: new BN(1_000_000_000),
      systemDecimalValue: new BN(1_000_000_000),
      minSeparateNumerator: new BN(5),
      minSeparateDenominator: new BN(10_000),
      tradeFeeNumerator: new BN(25),
      tradeFeeDenominator: new BN(10_000),
      pnlNumerator: new BN(12),
      pnlDenominator: new BN(100),
      swapFeeNumerator: new BN(25),
      swapFeeDenominator: new BN(10_000),
      baseNeedTakePnl: basePnl,
      quoteNeedTakePnl: quotePnl,
      baseVault: ammKeys.baseVault,
      quoteVault: ammKeys.quoteVault,
      baseMint: sync,
      quoteMint: wsol,
      lpMint: ammKeys.lpMint,
      openOrders: ammKeys.openOrders,
      marketId: market,
      marketProgramId: openBook,
      targetOrders: ammKeys.targetOrders,
      withdrawQueue: ammKeys.withdrawQueue,
      lpVault: ammKeys.lpVault,
      owner: key(64),
      lpReserve: A.lpSupply,
    }),
  );
  putTokenAccount(ammKeys.baseVault, sync, ammKeys.authority, A.reserveSync.add(basePnl));
  putTokenAccount(ammKeys.quoteVault, wsol, ammKeys.authority, A.reserveWsol.add(quotePnl));
  put(ammKeys.lpMint, PROGRAM_IDS.token, mintData({ decimals: 6, supply: A.lpSupply, authority: ammKeys.authority }));
  const ammLpAccount = getAssociatedTokenAddressSync(ammKeys.lpMint, wallet, false, token);
  putTokenAccount(ammLpAccount, ammKeys.lpMint, wallet, A.ownerLp);

  // The market-less pool. process_initialize2 stores the seed account it was
  // given as `market` and the default key as open orders and market program.
  const M = A.marketless;
  const marketSeed = key(47);
  const freeKeys = getAssociatedPoolKeys({
    version: 4,
    marketVersion: 3,
    marketId: marketSeed,
    baseMint: syna,
    quoteMint: wsol,
    baseDecimals: 9,
    quoteDecimals: 9,
    programId: new PublicKey(PROGRAM_IDS.ammV4),
    marketProgramId: openBook,
  });
  put(
    freeKeys.id,
    PROGRAM_IDS.ammV4,
    encodeLayout(liquidityStateV4Layout, {
      status: new BN(6),
      nonce: new BN(freeKeys.nonce),
      maxOrder: new BN(7),
      depth: new BN(3),
      baseDecimal: new BN(9),
      quoteDecimal: new BN(9),
      state: new BN(1),
      minSize: new BN(1_000_000),
      volMaxCutRatio: new BN(500),
      amountWaveRatio: new BN(5_000_000),
      minPriceMultiplier: new BN(1),
      maxPriceMultiplier: new BN(1_000_000_000),
      systemDecimalValue: new BN(1_000_000_000),
      tradeFeeNumerator: new BN(25),
      tradeFeeDenominator: new BN(10_000),
      pnlNumerator: new BN(12),
      pnlDenominator: new BN(100),
      swapFeeNumerator: new BN(25),
      swapFeeDenominator: new BN(10_000),
      baseVault: freeKeys.baseVault,
      quoteVault: freeKeys.quoteVault,
      baseMint: syna,
      quoteMint: wsol,
      lpMint: freeKeys.lpMint,
      openOrders: DEFAULT_KEY,
      marketId: marketSeed,
      marketProgramId: DEFAULT_KEY,
      targetOrders: freeKeys.targetOrders,
      owner: key(64),
      lpReserve: M.lpSupply,
    }),
  );
  putTokenAccount(freeKeys.baseVault, syna, freeKeys.authority, M.reserveSyna);
  putTokenAccount(freeKeys.quoteVault, wsol, freeKeys.authority, M.reserveWsol);
  put(freeKeys.lpMint, PROGRAM_IDS.token, mintData({ decimals: 9, supply: M.lpSupply, authority: freeKeys.authority }));
  const freeLpAccount = getAssociatedTokenAddressSync(freeKeys.lpMint, wallet, false, token);
  putTokenAccount(freeLpAccount, freeKeys.lpMint, wallet, M.ownerLp);

  const marketSigner = Market.getAssociatedAuthority({ programId: openBook, marketId: market });
  const marketBaseVault = key(66);
  const marketQuoteVault = key(67);
  // MARKET_STATE_LAYOUT_V3 leaves the "serum" head, the account flags and
  // the "padding" tail as unnamed blobs; write them as a live market has them.
  const marketData = encodeLayout(MARKET_STATE_LAYOUT_V3, {
    ownAddress: market,
    vaultSignerNonce: new BN(marketSigner.nonce),
    baseMint: sync,
    quoteMint: wsol,
    baseVault: marketBaseVault,
    quoteVault: marketQuoteVault,
    quoteDustThreshold: new BN(100),
    requestQueue: key(68),
    eventQueue: key(69),
    bids: key(70),
    asks: key(71),
    baseLotSize: new BN(1_000),
    quoteLotSize: new BN(1),
  });
  marketData.write("serum", 0);
  marketData.writeBigUInt64LE(BigInt(1 | 2), 5); // Initialized | Market
  marketData.write("padding", marketData.length - 7);
  put(market, PROGRAM_IDS.openBook, marketData);
  putTokenAccount(marketBaseVault, sync, marketSigner.publicKey, new BN(0));
  putTokenAccount(marketQuoteVault, wsol, marketSigner.publicKey, new BN(0));

  return {
    owner,
    accounts,
    mints: {
      syna: String(syna),
      synb: String(synb),
      synt: String(synt),
      sync: String(sync),
      reward: String(reward),
      wsol: String(wsol),
    },
    dammV2: { ...variants.unlocked, variants },
    clmm: {
      pool: String(clmmPool),
      position: String(clmmPositionPda.publicKey),
      positionMint: String(clmmNftMint),
      positionNftAccount: String(clmmNftAccount),
      tickArrays,
      config: String(clmmConfig),
      bitmapExtension: String(bitmapExtension),
      wide: {
        pool: String(widePool),
        position: String(widePositionPda.publicKey),
        positionMint: String(wideNftMint),
        positionNftAccount: String(wideNftAccount),
        tickArrays: wideTickArrays,
        bitmapExtension: String(wideBitmapExtension),
        rewardMints: wideRewardMints.map(String),
        rewardVaults: wideRewardVaults.map(String),
      },
    },
    cpmm: {
      pool: String(cpmmKeys.poolId),
      lpMint: String(cpmmKeys.lpMint),
      lpAccount: String(cpmmLpAccount),
      config: String(cpmmConfig),
      authority: String(cpmmKeys.authority),
      transferFee: {
        pool: String(feeKeys.poolId),
        lpMint: String(feeKeys.lpMint),
        lpAccount: String(feeLpAccount),
      },
    },
    ammV4: {
      pool: String(ammKeys.id),
      lpMint: String(ammKeys.lpMint),
      lpAccount: String(ammLpAccount),
      market: String(market),
      authority: String(ammKeys.authority),
      marketAuthority: String(marketSigner.publicKey),
      marketless: {
        pool: String(freeKeys.id),
        lpMint: String(freeKeys.lpMint),
        lpAccount: String(freeLpAccount),
        authority: String(freeKeys.authority),
        marketSeed: String(marketSeed),
      },
    },
  };
}
