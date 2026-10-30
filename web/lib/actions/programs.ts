// The programs and instructions the pre-sign check (./verify.ts) allows.
// Pure constants: no web3.js or SDK imports, so the UI may import this file
// statically.
import { ACTION_PROGRAM_IDS, type ActionProtocol } from "./types";

export const CP_AMM_PROGRAM = ACTION_PROGRAM_IDS["meteora-damm-v2"];
export const CLMM_PROGRAM = ACTION_PROGRAM_IDS["raydium-clmm"];
export const CPMM_PROGRAM = ACTION_PROGRAM_IDS["raydium-cpmm"];
export const AMM_V4_PROGRAM = ACTION_PROGRAM_IDS["raydium-amm-v4"];
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Every program a transaction may invoke at the top level. Not System, and
 * not Memo: no builder sends a memo, and a memo's text would show in the
 * wallet as if Doxxd wrote it. Raydium instructions still name the Memo
 * program as an account, which is fine.
 */
export const ALLOWED_PROGRAMS: readonly string[] = [
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  CP_AMM_PROGRAM,
  CLMM_PROGRAM,
  CPMM_PROGRAM,
  AMM_V4_PROGRAM,
];

/** Token programs an expected mint may belong to. */
export const TOKEN_PROGRAMS: readonly string[] = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** µlamports per compute unit. */
export const MAX_COMPUTE_UNIT_PRICE = 1_000_000;

// Compute Budget instruction tags (first data byte).
export const SET_COMPUTE_UNIT_LIMIT = 2; // data: tag, u32 LE
export const SET_COMPUTE_UNIT_PRICE = 3; // data: tag, u64 LE
// Associated Token Account program: empty data or 0 = Create, 1 = CreateIdempotent.
export const ATA_CREATE = 0;
export const ATA_CREATE_IDEMPOTENT = 1;
// SPL Token / Token-2022 instruction tag.
export const TOKEN_CLOSE_ACCOUNT = 9;

/**
 * What an account at a given index of an allowed instruction is to the
 * connected wallet. The pre-sign check enforces:
 * - `owner`: the connected wallet, and a signer;
 * - `ownedTokenAccount` (receives tokens): the wallet's ATA of an expected
 *   mint (derived by the check), or the wallet itself;
 * - `positionNftAccount`: the NFT account of an expected position of the
 *   instruction's protocol;
 * - `rentReceiver`: the connected wallet;
 * - `pool` and `lpSource` (liquidity-removing instructions only): in a
 *   withdraw, the pool the visitor chose to withdraw from and, for CPMM and
 *   AMM v4, the LP token account the LP tokens are burned from, both taken
 *   from the position's `withdraw` expectation;
 * - `position` (close_position only): the position account the expectation
 *   lists with the instruction's position NFT account.
 * Indexes without a role are left to the program's own constraints.
 */
export type AccountRole =
  | "owner"
  | "ownedTokenAccount"
  | "positionNftAccount"
  | "rentReceiver"
  | "pool"
  | "lpSource"
  | "position";

/**
 * Accounts after the fixed list:
 * - `none`: exactly `accounts` accounts;
 * - `vestings`: any number of cp-amm vesting accounts (refresh_vesting);
 * - `optionalPool`: at most one more (CLMM close_position's pool);
 * - `clmmRewards`: an optional tick-array bitmap extension, then reward
 *   triples (pool reward vault, the wallet's reward account, reward mint).
 */
export type RemainingAccounts = "none" | "vestings" | "optionalPool" | "clmmRewards";

/**
 * What the visitor asked for. Set by the UI from the visitor's intent. A
 * "close" closes empty positions: it may collect their fees and rewards and
 * close them, never remove liquidity.
 */
export type ActionKind = "claim" | "withdraw" | "close";

/**
 * An instruction's data, decoded with an exact length:
 * - `length`: the whole data length, discriminator included;
 * - `amount`: the liquidity or LP amount removed, little-endian at `offset`;
 * - `minimums`: offsets of the u64 little-endian minimum outputs;
 * - `zeroFlags`: single-byte flags that must be 0, by offset and name.
 */
export type InstructionArgs = {
  length: number;
  amount?: { offset: number; bytes: 8 | 16 };
  minimums: readonly number[];
  zeroFlags?: readonly { offset: number; name: string; why: string }[];
};

export type InstructionSpec = {
  protocol: ActionProtocol;
  name: string;
  /** The 8-byte Anchor discriminator, or AMM v4's 1-byte tag. */
  discriminator: readonly number[];
  /** The kinds of action this instruction may appear in. */
  kinds: readonly ActionKind[];
  args: InstructionArgs;
  /**
   * A zero amount collects fees and rewards without removing liquidity
   * (CLMM decrease_liquidity_v2). It needs no minimums.
   */
  collectWhenZero?: true;
  /**
   * Removes liquidity: by the `amount` argument, or all of it
   * (remove_all_liquidity). In a withdraw, the pool, the amount and the
   * minimums must equal the position's `withdraw` expectation exactly.
   */
  removes?: "amount" | "all";
  /** Closes the position: allowed only when the withdraw expectation closes it. */
  closes?: true;
  /** Length of the fixed account list. */
  accounts: number;
  remaining: RemainingAccounts;
  roles: Readonly<Record<number, { role: AccountRole; name: string }>>;
};

// Index → role tables. Sources (paths under web/node_modules/):
// - cp-amm: the IDL embedded in @meteora-ag/cp-amm-sdk/dist/index.js (1.5.1),
//   whose account order Anchor's builders follow;
// - Raydium: the instruction builders in @raydium-io/raydium-sdk-v2/src
//   (0.2.77-alpha).
// verify.test.ts checks each table against those sources.

// The four cp-amm instructions that pay out tokens share one account order:
// claim_position_fee (dist/index.js:181), remove_all_liquidity (:2286) and
// remove_liquidity (:2409): 0 pool_authority, 1 pool, 2 position,
// 3 token_a_account, 4 token_b_account, 5 token_a_vault, 6 token_b_vault,
// 7 token_a_mint, 8 token_b_mint, 9 position_nft_account, 10 signer,
// 11 token_a_program, 12 token_b_program, 13 event_authority, 14 program.
const CP_AMM_PAYOUT_ROLES = {
  3: { role: "ownedTokenAccount", name: "token_a_account" },
  4: { role: "ownedTokenAccount", name: "token_b_account" },
  9: { role: "positionNftAccount", name: "position_nft_account" },
  10: { role: "owner", name: "signer" },
} as const;

// remove_liquidity and remove_all_liquidity also name the pool (index 1).
const CP_AMM_REMOVAL_ROLES = {
  1: { role: "pool", name: "pool" },
  ...CP_AMM_PAYOUT_ROLES,
} as const;

export const ALLOWED_INSTRUCTIONS: Readonly<Record<string, readonly InstructionSpec[]>> = {
  [CP_AMM_PROGRAM]: [
    {
      protocol: "meteora-damm-v2",
      name: "claim_position_fee", // dist/index.js:181
      discriminator: [180, 38, 154, 17, 133, 33, 162, 211],
      kinds: ["claim", "withdraw", "close"],
      args: { length: 8, minimums: [] },
      accounts: 15,
      remaining: "none",
      roles: CP_AMM_PAYOUT_ROLES,
    },
    {
      protocol: "meteora-damm-v2",
      name: "claim_reward", // dist/index.js:367
      discriminator: [149, 95, 181, 242, 94, 90, 158, 162],
      kinds: ["claim", "withdraw", "close"],
      // reward_index: u8, skip_reward: u8 (dist/index.js:427-438). A
      // non-zero skip_reward clears the pending reward without paying it
      // (damm-v2 ix_claim_reward.rs), so it must be 0.
      args: {
        length: 10,
        minimums: [],
        zeroFlags: [{ offset: 9, name: "skip_reward", why: "a skipped reward is never paid out" }],
      },
      // 0 pool_authority, 1 pool, 2 position, 3 reward_vault, 4 reward_mint,
      // 5 user_token_account, 6 position_nft_account, 7 signer,
      // 8 token_program, 9 event_authority, 10 program.
      accounts: 11,
      remaining: "none",
      roles: {
        5: { role: "ownedTokenAccount", name: "user_token_account" },
        6: { role: "positionNftAccount", name: "position_nft_account" },
        7: { role: "owner", name: "signer" },
      },
    },
    {
      protocol: "meteora-damm-v2",
      name: "remove_liquidity", // dist/index.js:2409
      discriminator: [80, 85, 209, 72, 24, 206, 177, 108],
      kinds: ["withdraw"],
      // RemoveLiquidityParameters (dist/index.js:6482): liquidity_delta u128,
      // token_a_amount_threshold u64, token_b_amount_threshold u64.
      args: { length: 40, amount: { offset: 8, bytes: 16 }, minimums: [24, 32] },
      removes: "amount",
      accounts: 15,
      remaining: "none",
      roles: CP_AMM_REMOVAL_ROLES,
    },
    {
      protocol: "meteora-damm-v2",
      name: "remove_all_liquidity", // dist/index.js:2286
      discriminator: [10, 51, 61, 35, 112, 105, 24, 85],
      kinds: ["withdraw"],
      // token_a_amount_threshold u64, token_b_amount_threshold u64
      // (dist/index.js:2397-2406). It removes all, so it has no amount.
      args: { length: 24, minimums: [8, 16] },
      removes: "all",
      accounts: 15,
      remaining: "none",
      roles: CP_AMM_REMOVAL_ROLES,
    },
    {
      protocol: "meteora-damm-v2",
      name: "close_position", // dist/index.js:514
      discriminator: [123, 134, 81, 0, 49, 68, 98, 98],
      kinds: ["withdraw", "close"],
      args: { length: 8, minimums: [] },
      closes: true,
      // 0 position_nft_mint, 1 position_nft_account, 2 pool, 3 position,
      // 4 pool_authority, 5 rent_receiver, 6 owner, 7 token_program,
      // 8 event_authority, 9 program.
      accounts: 10,
      remaining: "none",
      roles: {
        1: { role: "positionNftAccount", name: "position_nft_account" },
        3: { role: "position", name: "position" },
        5: { role: "rentReceiver", name: "rent_receiver" },
        6: { role: "owner", name: "owner" },
      },
    },
    {
      protocol: "meteora-damm-v2",
      name: "refresh_vesting", // dist/index.js:2251
      discriminator: [9, 94, 216, 14, 116, 204, 247, 0],
      kinds: ["withdraw", "close"],
      args: { length: 8, minimums: [] },
      // 0 pool, 1 position, 2 position_nft_account, 3 owner, then the
      // position's vesting accounts (buildRefreshVestingInstruction,
      // dist/index.js:11955).
      accounts: 4,
      remaining: "vestings",
      roles: {
        2: { role: "positionNftAccount", name: "position_nft_account" },
        3: { role: "owner", name: "owner" },
      },
    },
  ],
  [CLMM_PROGRAM]: [
    {
      protocol: "raydium-clmm",
      name: "decrease_liquidity_v2",
      // src/raydium/clmm/instrument.ts:59 (insId), keys at :566-591:
      // 0 nftOwner, 1 nftAccount, 2 personalPosition, 3 poolId,
      // 4 protocolPosition, 5 vaultA, 6 vaultB, 7 tickArrayLower,
      // 8 tickArrayUpper, 9 ownerVaultA, 10 ownerVaultB, 11 token program,
      // 12 Token-2022 program, 13 memo program, 14 mintA, 15 mintB, then an
      // optional exTickArrayBitmap and reward triples (:584-591).
      discriminator: [58, 127, 188, 62, 79, 82, 196, 96],
      kinds: ["claim", "withdraw", "close"],
      // liquidity u128, amountMinA u64, amountMinB u64 (instrument.ts:564).
      // Liquidity 0 with minimums 0 is the fee and reward collect a claim (and
      // a close) uses.
      args: { length: 40, amount: { offset: 8, bytes: 16 }, minimums: [24, 32] },
      collectWhenZero: true,
      removes: "amount",
      accounts: 16,
      remaining: "clmmRewards",
      roles: {
        0: { role: "owner", name: "nft_owner" },
        1: { role: "positionNftAccount", name: "nft_account" },
        3: { role: "pool", name: "pool_state" },
        9: { role: "ownedTokenAccount", name: "recipient_token_account_0" },
        10: { role: "ownedTokenAccount", name: "recipient_token_account_1" },
      },
    },
    {
      protocol: "raydium-clmm",
      name: "close_position",
      // src/raydium/clmm/instrument.ts:57 (insId), keys at :348-355:
      // 0 nftOwner (receives the rent), 1 positionNftMint,
      // 2 positionNftAccount, 3 personalPosition, 4 system program,
      // 5 token program, then the optional poolId (:358).
      discriminator: [123, 134, 81, 0, 49, 68, 98, 98],
      kinds: ["withdraw", "close"],
      args: { length: 8, minimums: [] },
      closes: true,
      accounts: 6,
      remaining: "optionalPool",
      roles: {
        0: { role: "owner", name: "nft_owner" },
        2: { role: "positionNftAccount", name: "position_nft_account" },
        3: { role: "position", name: "personal_position" },
      },
    },
  ],
  [CPMM_PROGRAM]: [
    {
      protocol: "raydium-cpmm",
      name: "withdraw",
      // src/raydium/cpmm/instruction.ts:28 (anchorDataBuf), keys at :190-205:
      // 0 owner, 1 authority, 2 poolId, 3 userLpAccount, 4 userVaultA,
      // 5 userVaultB, 6 vaultA, 7 vaultB, 8 token program, 9 Token-2022
      // program, 10 mintA, 11 mintB, 12 lpMint, 13 memo program.
      discriminator: [183, 18, 70, 156, 148, 109, 161, 34],
      kinds: ["withdraw"],
      // lpAmount u64, amountMinA u64, amountMinB u64 (instruction.ts:188).
      args: { length: 32, amount: { offset: 8, bytes: 8 }, minimums: [16, 24] },
      removes: "amount",
      accounts: 14,
      remaining: "none",
      roles: {
        0: { role: "owner", name: "owner" },
        // poolId and userLpAccount (instruction.ts:193-194); raydium-cp-swap
        // calls them pool_state and owner_lp_token.
        2: { role: "pool", name: "pool_state" },
        3: { role: "lpSource", name: "owner_lp_token" },
        4: { role: "ownedTokenAccount", name: "token_0_account" },
        5: { role: "ownedTokenAccount", name: "token_1_account" },
      },
    },
  ],
  [AMM_V4_PROGRAM]: [
    {
      protocol: "raydium-amm-v4",
      name: "withdraw",
      // src/raydium/liquidity/instruction.ts:109 (instruction: 4), keys at
      // :117-152 for version 4: 0 token program, 1 amm, 2 authority,
      // 3 openOrders, 4 targetOrders, 5 lpMint, 6 baseVault, 7 quoteVault,
      // 8-9 amm again (:133-134), 10 market program, 11 market,
      // 12 marketBaseVault, 13 marketQuoteVault, 14 marketAuthority,
      // 15 user lpTokenAccount, 16 user baseTokenAccount,
      // 17 user quoteTokenAccount, 18 owner, 19 eventQueue, 20 bids, 21 asks.
      // The program also accepts 20, 21 and 23 accounts with shifted user
      // accounts; only this form and the 11-account form below are allowed.
      discriminator: [4],
      kinds: ["withdraw"],
      // removeLiquidityLayout (src/raydium/liquidity/layout.ts:142): tag u8,
      // lpAmount u64, baseAmountMin u64, quoteAmountMin u64. The program
      // treats the minimums as optional by length; a withdraw must carry them.
      args: { length: 25, amount: { offset: 1, bytes: 8 }, minimums: [9, 17] },
      removes: "amount",
      accounts: 22,
      remaining: "none",
      roles: {
        // poolKeys.id (liquidity/instruction.ts:121) and
        // userKeys.lpTokenAccount (:145).
        1: { role: "pool", name: "amm" },
        15: { role: "lpSource", name: "user_lp_token_account" },
        16: { role: "ownedTokenAccount", name: "user_base_token_account" },
        17: { role: "ownedTokenAccount", name: "user_quote_token_account" },
        18: { role: "owner", name: "owner" },
      },
    },
    {
      protocol: "raydium-amm-v4",
      name: "withdraw",
      // The OpenBook-free form, "Recommended use due to openbook has not
      // supported" (raydium-amm program/src/processor.rs:1561-1590, master
      // 91739d8; added by "Remove openbook dependency (#69)", 27f461d, after
      // which pools are created without a market): 0 token program, 1 amm,
      // 2 authority, 3 targetOrders, 4 lpMint, 5 coin (base) vault, 6 pc
      // (quote) vault, 7 user lpTokenAccount, 8 user coin (base) account,
      // 9 user pc (quote) account, 10 owner. Same data as the 22-account form.
      // The pre-sign check picks between the two by account count.
      discriminator: [4],
      kinds: ["withdraw"],
      args: { length: 25, amount: { offset: 1, bytes: 8 }, minimums: [9, 17] },
      removes: "amount",
      accounts: 11,
      remaining: "none",
      roles: {
        // amm_info and user's source LP account (processor.rs:1561-1590).
        1: { role: "pool", name: "amm" },
        7: { role: "lpSource", name: "user_lp_token_account" },
        8: { role: "ownedTokenAccount", name: "user_base_token_account" },
        9: { role: "ownedTokenAccount", name: "user_quote_token_account" },
        10: { role: "owner", name: "owner" },
      },
    },
  ],
};
