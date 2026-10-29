// @vitest-environment node
// web3.js derives program addresses with Node's crypto; jsdom's realm breaks
// that, so this suite runs in the node environment.
import { createHash } from "node:crypto";
import { CpAmm, CpAmmIdl, getTokenProgram, type PoolState } from "@meteora-ag/cp-amm-sdk";
import {
  ClmmInstrument,
  CpmmPoolInfoLayout,
  MARKET_STATE_LAYOUT_V3,
  PersonalPositionLayout,
  PoolInfoLayout,
  getPdaExBitmapAccount,
  getPdaProtocolPositionAddress,
  liquidityStateV4Layout,
  makeWithdrawCpmmInInstruction,
  removeLiquidityInstruction,
} from "@raydium-io/raydium-sdk-v2";
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type VersionedMessage,
} from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { chainFixture, PROGRAM_IDS, SYNTHETIC, type DammV2Fixture, type SyntheticChain } from "@/tests/fixtures/actions-chain";
import { MOCK_BLOCKHASH, mockConnection } from "@/tests/fixtures/mock-action-rpc";
import { ALLOWED_INSTRUCTIONS, ATA_PROGRAM, MEMO_PROGRAM } from "./programs";
import { decodeInstructionArgs, verifyMessage, type Expectation } from "./verify";

const pk = (address: string) => new PublicKey(address);
const seededKey = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey;
const STRANGER = seededKey(99);
const UNKNOWN_PROGRAM = seededKey(98);
const STRANGER_MINT = seededKey(97);
const MEMO = pk(MEMO_PROGRAM);

type Ctx = {
  chain: SyntheticChain;
  owner: PublicKey;
  cpAmm: CpAmm;
  expectation: Expectation;
  programOf: (mint: string) => PublicKey;
  ata: (mint: string, holder?: PublicKey) => PublicKey;
};

function setup(): Ctx {
  const chain = chainFixture();
  const owner = chain.owner.publicKey;
  const programOf = (mint: string) => (mint === chain.mints.synt ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  const { syna, synb, synt, sync, reward, wsol } = chain.mints;
  const expectation: Expectation = {
    kind: "claim",
    owner: owner.toBase58(),
    mints: [syna, synb, synt, sync, reward, wsol].map((mint) => ({
      mint,
      tokenProgram: programOf(mint).toBase58(),
    })),
    positions: [
      ...Object.values(chain.dammV2.variants).map((v) => ({
        position: v.position,
        nftAccount: v.positionNftAccount,
        protocol: "meteora-damm-v2" as const,
      })),
      { position: chain.clmm.position, nftAccount: chain.clmm.positionNftAccount, protocol: "raydium-clmm" },
    ],
  };
  return {
    chain,
    owner,
    cpAmm: new CpAmm(mockConnection(chain)),
    expectation,
    programOf,
    ata: (mint, holder = owner) => getAssociatedTokenAddressSync(pk(mint), holder, false, programOf(mint)),
  };
}

function compile(
  ctx: Ctx,
  instructions: TransactionInstruction[],
  opts: { payer?: PublicKey; lookups?: AddressLookupTableAccount[] } = {},
): VersionedMessage {
  return new TransactionMessage({
    payerKey: opts.payer ?? ctx.owner,
    recentBlockhash: MOCK_BLOCKHASH,
    instructions,
  }).compileToV0Message(opts.lookups);
}

const withdrawing = (ctx: Ctx): Expectation => ({ ...ctx.expectation, kind: "withdraw" });

const budget = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
];

/** Replace the account at `index`, keeping it a non-signer. */
function withKey(ix: TransactionInstruction, index: number, pubkey: PublicKey): TransactionInstruction {
  const keys = ix.keys.map((meta, i) => (i === index ? { ...meta, pubkey, isSigner: false } : meta));
  return new TransactionInstruction({ programId: ix.programId, keys, data: ix.data });
}

const only = (ixs: TransactionInstruction[], program: string) =>
  ixs.filter((ix) => ix.programId.toBase58() === program);

// --- SDK-built instructions over the synthetic chain ------------------------

async function dammAccounts(ctx: Ctx, v: DammV2Fixture = ctx.chain.dammV2) {
  const pool = await ctx.cpAmm.fetchPoolState(pk(v.pool));
  return {
    pool,
    accounts: {
      owner: ctx.owner,
      pool: pk(v.pool),
      position: pk(v.position),
      positionNftAccount: pk(v.positionNftAccount),
      tokenAMint: pool.tokenAMint,
      tokenBMint: pool.tokenBMint,
      tokenAVault: pool.tokenAVault,
      tokenBVault: pool.tokenBVault,
      tokenAProgram: getTokenProgram(pool.tokenAFlag),
      tokenBProgram: getTokenProgram(pool.tokenBFlag),
    },
  };
}

async function dammClaim(ctx: Ctx, receiver = ctx.owner, v?: DammV2Fixture) {
  const { accounts } = await dammAccounts(ctx, v);
  return (await ctx.cpAmm.claimPositionFee2({ ...accounts, receiver })).instructions;
}

async function dammClaimReward(ctx: Ctx) {
  const v = ctx.chain.dammV2;
  const poolState: PoolState = await ctx.cpAmm.fetchPoolState(pk(v.pool));
  const positionState = await ctx.cpAmm.fetchPositionState(pk(v.position));
  const tx = await ctx.cpAmm.claimReward({
    user: ctx.owner,
    position: pk(v.position),
    positionNftAccount: pk(v.positionNftAccount),
    poolState,
    positionState,
    rewardIndex: 0,
    isSkipReward: false,
  });
  return tx.instructions;
}

const now = () => new BN(SYNTHETIC.clock.unixTimestamp);

type Mins = { a?: BN; b?: BN };
const minA = (m: Mins) => m.a ?? new BN(1);
const minB = (m: Mins) => m.b ?? new BN(1);

async function dammRemoveVested(ctx: Ctx, opts: Mins & { delta?: BN } = {}) {
  const v = ctx.chain.dammV2.variants.vested;
  const { accounts } = await dammAccounts(ctx, v);
  // The SDK's getAllVestingsByPosition uses a filter the pass-through
  // refuses, so read the fixture's known vesting account directly.
  const vestingState = await ctx.cpAmm._program.account.vesting.fetch(pk(v.vesting!));
  const vestings = [{ account: pk(v.vesting!), vestingState }];
  const tx = await ctx.cpAmm.removeLiquidity({
    ...accounts,
    liquidityDelta: opts.delta ?? new BN(1).shln(100),
    tokenAAmountThreshold: minA(opts),
    tokenBAmountThreshold: minB(opts),
    vestings,
    currentPoint: now(),
  });
  return tx.instructions;
}

async function dammRemoveAll(ctx: Ctx, opts: Mins = {}) {
  const { accounts } = await dammAccounts(ctx);
  const tx = await ctx.cpAmm.removeAllLiquidity({
    ...accounts,
    tokenAAmountThreshold: minA(opts),
    tokenBAmountThreshold: minB(opts),
    vestings: [],
    currentPoint: now(),
  });
  return tx.instructions;
}

async function dammClose(ctx: Ctx) {
  const v = ctx.chain.dammV2;
  const tx = await ctx.cpAmm.closePosition({
    owner: ctx.owner,
    pool: pk(v.pool),
    position: pk(v.position),
    positionNftMint: pk(v.positionMint),
    positionNftAccount: pk(v.positionNftAccount),
  });
  return tx.instructions;
}

function clmmKeys(ctx: Ctx) {
  const c = ctx.chain.clmm;
  const program = pk(PROGRAM_IDS.clmm);
  const pool = PoolInfoLayout.decode(ctx.chain.accounts.get(c.pool)!.data);
  const position = PersonalPositionLayout.decode(ctx.chain.accounts.get(c.position)!.data);
  return {
    program,
    pool,
    protocolPosition: getPdaProtocolPositionAddress(program, pk(c.pool), position.tickLower, position.tickUpper)
      .publicKey,
    bitmap: getPdaExBitmapAccount(program, pk(c.pool)).publicKey,
  };
}

type RewardAccounts = { poolRewardVault: PublicKey; ownerRewardVault: PublicKey; rewardMint: PublicKey }[];

function clmmDecrease(
  ctx: Ctx,
  opts: { recipientA?: PublicKey; rewards?: RewardAccounts; bitmap?: boolean; liquidity?: BN } & Mins = {},
) {
  const c = ctx.chain.clmm;
  const { program, pool, protocolPosition, bitmap } = clmmKeys(ctx);
  return ClmmInstrument.decreaseLiquidityV2Instruction(
    program,
    ctx.owner,
    pk(c.positionNftAccount),
    pk(c.position),
    pk(c.pool),
    protocolPosition,
    pk(c.tickArrays[0]),
    pk(c.tickArrays[1]),
    opts.recipientA ?? ctx.ata(pool.mintA.toBase58()),
    ctx.ata(pool.mintB.toBase58()),
    pool.vaultA,
    pool.vaultB,
    pool.mintA,
    pool.mintB,
    opts.rewards ?? [],
    opts.liquidity ?? new BN(0),
    opts.a ?? new BN(0),
    opts.b ?? new BN(0),
    opts.bitmap === false ? undefined : bitmap,
  );
}

const rewardTriple = (ctx: Ctx, recipient = ctx.ata(ctx.chain.mints.reward)) => ({
  poolRewardVault: seededKey(96),
  ownerRewardVault: recipient,
  rewardMint: pk(ctx.chain.mints.reward),
});

function clmmClose(ctx: Ctx) {
  const c = ctx.chain.clmm;
  return ClmmInstrument.closePositionInstruction(
    pk(PROGRAM_IDS.clmm),
    ctx.owner,
    pk(c.positionMint),
    pk(c.positionNftAccount),
    pk(c.position),
    true,
    pk(c.pool),
  );
}

function cpmmWithdraw(ctx: Ctx, opts: Mins & { lp?: BN } = {}) {
  const c = ctx.chain.cpmm;
  const pool = CpmmPoolInfoLayout.decode(ctx.chain.accounts.get(c.pool)!.data);
  return makeWithdrawCpmmInInstruction(
    pk(PROGRAM_IDS.cpmm),
    ctx.owner,
    pk(c.authority),
    pk(c.pool),
    getAssociatedTokenAddressSync(pk(c.lpMint), ctx.owner),
    ctx.ata(pool.mintA.toBase58()),
    ctx.ata(pool.mintB.toBase58()),
    pool.vaultA,
    pool.vaultB,
    pool.mintA,
    pool.mintB,
    pool.mintLp,
    opts.lp ?? SYNTHETIC.cpmm.ownerLp.divn(2),
    minA(opts),
    minB(opts),
  );
}

function ammV4Withdraw(ctx: Ctx, opts: Mins & { lp?: BN } = {}) {
  const a = ctx.chain.ammV4;
  const amm = liquidityStateV4Layout.decode(ctx.chain.accounts.get(a.pool)!.data);
  const market = MARKET_STATE_LAYOUT_V3.decode(ctx.chain.accounts.get(a.market)!.data);
  const poolKeys = {
    programId: PROGRAM_IDS.ammV4,
    id: a.pool,
    authority: a.authority,
    openOrders: amm.openOrders.toBase58(),
    targetOrders: amm.targetOrders.toBase58(),
    mintLp: { address: a.lpMint },
    vault: { A: amm.baseVault.toBase58(), B: amm.quoteVault.toBase58() },
    marketProgramId: PROGRAM_IDS.openBook,
    marketId: a.market,
    marketBaseVault: market.baseVault.toBase58(),
    marketQuoteVault: market.quoteVault.toBase58(),
    marketAuthority: a.marketAuthority,
    marketEventQueue: market.eventQueue.toBase58(),
    marketBids: market.bids.toBase58(),
    marketAsks: market.asks.toBase58(),
  };
  return removeLiquidityInstruction({
    poolInfo: { pooltype: [] } as unknown as Parameters<typeof removeLiquidityInstruction>[0]["poolInfo"],
    poolKeys: poolKeys as unknown as Parameters<typeof removeLiquidityInstruction>[0]["poolKeys"],
    userKeys: {
      lpTokenAccount: getAssociatedTokenAddressSync(pk(a.lpMint), ctx.owner),
      baseTokenAccount: ctx.ata(ctx.chain.mints.sync),
      quoteTokenAccount: ctx.ata(ctx.chain.mints.wsol),
      owner: ctx.owner,
    },
    lpAmount: opts.lp ?? SYNTHETIC.ammV4.ownerLp.divn(2),
    baseAmountMin: minA(opts),
    quoteAmountMin: minB(opts),
  });
}

const spec = (program: string, name: string) => {
  const found = ALLOWED_INSTRUCTIONS[program].find((s) => s.name === name);
  if (!found) throw new Error(`no spec ${name}`);
  return found;
};

const OK = { ok: true };
const rejected = (reason: string) => ({ ok: false, reason });

// --- Tables against their sources -------------------------------------------

describe("ALLOWED_INSTRUCTIONS", () => {
  it("matches the cp-amm IDL: discriminators, account counts and role names", () => {
    for (const s of ALLOWED_INSTRUCTIONS[PROGRAM_IDS.cpAmm]) {
      const idl = CpAmmIdl.instructions.find((ix) => ix.name === s.name);
      expect(idl, s.name).toBeDefined();
      expect([...s.discriminator]).toEqual([...idl!.discriminator]);
      expect(s.accounts).toBe(idl!.accounts.length);
      for (const [index, role] of Object.entries(s.roles))
        expect(idl!.accounts[Number(index)].name, `${s.name} ${index}`).toBe(role.name);
    }
    expect(ALLOWED_INSTRUCTIONS[PROGRAM_IDS.cpAmm].map((s) => s.name).sort()).toEqual(
      [
        "claim_position_fee",
        "claim_reward",
        "close_position",
        "refresh_vesting",
        "remove_all_liquidity",
        "remove_liquidity",
      ],
    );
  });

  it("uses Anchor discriminators for the Raydium CLMM and CPMM instructions", () => {
    for (const program of [PROGRAM_IDS.clmm, PROGRAM_IDS.cpmm])
      for (const s of ALLOWED_INSTRUCTIONS[program])
        expect(Buffer.from(s.discriminator)).toEqual(
          createHash("sha256").update(`global:${s.name}`).digest().subarray(0, 8),
        );
    expect(ALLOWED_INSTRUCTIONS[PROGRAM_IDS.ammV4].map((s) => [...s.discriminator])).toEqual([[4]]);
  });

  it("places the Raydium roles where the SDK builders put those accounts", () => {
    const ctx = setup();
    const at = (ix: TransactionInstruction, i: number) => ix.keys[i].pubkey.toBase58();
    const { pool } = clmmKeys(ctx);

    const decrease = clmmDecrease(ctx, { bitmap: false });
    const d = spec(PROGRAM_IDS.clmm, "decrease_liquidity_v2");
    expect(decrease.data.subarray(0, 8)).toEqual(Buffer.from(d.discriminator));
    expect(decrease.keys).toHaveLength(d.accounts);
    expect(Object.keys(d.roles).map((i) => at(decrease, Number(i)))).toEqual([
      ctx.owner.toBase58(),
      ctx.chain.clmm.positionNftAccount,
      ctx.ata(pool.mintA.toBase58()).toBase58(),
      ctx.ata(pool.mintB.toBase58()).toBase58(),
    ]);

    const close = clmmClose(ctx);
    const c = spec(PROGRAM_IDS.clmm, "close_position");
    expect(close.data).toEqual(Buffer.from(c.discriminator));
    expect(close.keys).toHaveLength(c.accounts + 1);
    expect(Object.keys(c.roles).map((i) => at(close, Number(i)))).toEqual([
      ctx.owner.toBase58(),
      ctx.chain.clmm.positionNftAccount,
    ]);

    const cpmm = cpmmWithdraw(ctx);
    const w = spec(PROGRAM_IDS.cpmm, "withdraw");
    const cpmmPool = CpmmPoolInfoLayout.decode(ctx.chain.accounts.get(ctx.chain.cpmm.pool)!.data);
    expect(cpmm.data.subarray(0, 8)).toEqual(Buffer.from(w.discriminator));
    expect(cpmm.keys).toHaveLength(w.accounts);
    expect(Object.keys(w.roles).map((i) => at(cpmm, Number(i)))).toEqual([
      ctx.owner.toBase58(),
      ctx.ata(cpmmPool.mintA.toBase58()).toBase58(),
      ctx.ata(cpmmPool.mintB.toBase58()).toBase58(),
    ]);

    const amm = ammV4Withdraw(ctx);
    const v4 = spec(PROGRAM_IDS.ammV4, "withdraw");
    expect(amm.data[0]).toBe(4);
    expect(amm.keys).toHaveLength(v4.accounts);
    expect(Object.keys(v4.roles).map((i) => at(amm, Number(i)))).toEqual([
      ctx.ata(ctx.chain.mints.sync).toBase58(),
      ctx.ata(ctx.chain.mints.wsol).toBase58(),
      ctx.owner.toBase58(),
    ]);
  });
});

// --- Accepted ---------------------------------------------------------------

describe("verifyMessage accepts", () => {
  it("a cp-amm fee claim with ATA creates, the wSOL unwrap, compute budget and a memo", async () => {
    const ctx = setup();
    const ixs = await dammClaim(ctx);
    const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("doxxd") });
    expect(ixs.map((ix) => ix.programId.toBase58())).toEqual([
      ATA_PROGRAM,
      ATA_PROGRAM,
      PROGRAM_IDS.cpAmm,
      PROGRAM_IDS.token,
    ]);
    expect(verifyMessage(compile(ctx, [...budget(), ...ixs, memo]), ctx.expectation)).toEqual(OK);
  });

  it("a cp-amm reward claim", async () => {
    const ctx = setup();
    const ixs = await dammClaimReward(ctx);
    expect(only(ixs, PROGRAM_IDS.cpAmm)).toHaveLength(1);
    expect(verifyMessage(compile(ctx, ixs), ctx.expectation)).toEqual(OK);
  });

  it("a cp-amm partial removal led by refresh_vesting", async () => {
    const ctx = setup();
    const ixs = await dammRemoveVested(ctx);
    const cpAmmIxs = only(ixs, PROGRAM_IDS.cpAmm);
    expect(cpAmmIxs.map((ix) => [...ix.data.subarray(0, 8)])).toEqual([
      [...spec(PROGRAM_IDS.cpAmm, "refresh_vesting").discriminator],
      [...spec(PROGRAM_IDS.cpAmm, "remove_liquidity").discriminator],
    ]);
    expect(cpAmmIxs[0].keys).toHaveLength(5); // 4 fixed + 1 vesting account
    expect(verifyMessage(compile(ctx, [...budget(), ...ixs]), withdrawing(ctx))).toEqual(OK);
  });

  it("a cp-amm refresh_vesting on its own", async () => {
    const ctx = setup();
    const v = ctx.chain.dammV2.variants.vested;
    const tx = await ctx.cpAmm.refreshVesting({
      owner: ctx.owner,
      position: pk(v.position),
      positionNftAccount: pk(v.positionNftAccount),
      pool: pk(v.pool),
      vestingAccounts: [pk(v.vesting!)],
    });
    expect(verifyMessage(compile(ctx, tx.instructions), withdrawing(ctx))).toEqual(OK);
  });

  it("a cp-amm remove_all_liquidity", async () => {
    const ctx = setup();
    const ixs = await dammRemoveAll(ctx);
    expect(only(ixs, PROGRAM_IDS.cpAmm)[0].data.subarray(0, 8)).toEqual(
      Buffer.from(spec(PROGRAM_IDS.cpAmm, "remove_all_liquidity").discriminator),
    );
    expect(verifyMessage(compile(ctx, ixs), withdrawing(ctx))).toEqual(OK);
  });

  it("a cp-amm close_position", async () => {
    const ctx = setup();
    expect(verifyMessage(compile(ctx, await dammClose(ctx)), withdrawing(ctx))).toEqual(OK);
  });

  it("the SDK's combined remove-all-and-close transaction", async () => {
    const ctx = setup();
    const v = ctx.chain.dammV2;
    const poolState = await ctx.cpAmm.fetchPoolState(pk(v.pool));
    const positionState = await ctx.cpAmm.fetchPositionState(pk(v.position));
    const tx = await ctx.cpAmm.removeAllLiquidityAndClosePosition({
      owner: ctx.owner,
      position: pk(v.position),
      positionNftAccount: pk(v.positionNftAccount),
      poolState,
      positionState,
      tokenAAmountThreshold: new BN(1),
      tokenBAmountThreshold: new BN(1),
      vestings: [],
      currentPoint: now(),
    });
    expect(only(tx.instructions, PROGRAM_IDS.cpAmm).length).toBeGreaterThanOrEqual(3);
    expect(verifyMessage(compile(ctx, tx.instructions), withdrawing(ctx))).toEqual(OK);
  });

  it("a Token-2022 fee claim", async () => {
    const ctx = setup();
    const ixs = await dammClaim(ctx, ctx.owner, ctx.chain.dammV2.variants.transferFee);
    expect(ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID)))).toBe(true);
    expect(verifyMessage(compile(ctx, ixs), ctx.expectation)).toEqual(OK);
  });

  it("a Raydium CLMM decrease_liquidity_v2 with the bitmap extension and a reward", () => {
    const ctx = setup();
    const ix = clmmDecrease(ctx, { rewards: [rewardTriple(ctx)] });
    expect(ix.keys).toHaveLength(16 + 1 + 3);
    expect(ix.keys[13].pubkey.toBase58()).toBe(MEMO_PROGRAM); // memo as an account is fine
    expect(verifyMessage(compile(ctx, [...budget(), ix]), ctx.expectation)).toEqual(OK);
  });

  it("a Raydium CLMM decrease_liquidity_v2 without remaining accounts", () => {
    const ctx = setup();
    expect(verifyMessage(compile(ctx, [clmmDecrease(ctx, { bitmap: false })]), ctx.expectation)).toEqual(OK);
  });

  it("a Raydium CLMM full decrease with minimums, then close_position", () => {
    const ctx = setup();
    const decrease = clmmDecrease(ctx, { liquidity: SYNTHETIC.clmm.liquidity, a: new BN(1) });
    expect(verifyMessage(compile(ctx, [decrease, clmmClose(ctx)]), withdrawing(ctx))).toEqual(OK);
  });

  it("a Raydium CPMM withdraw with idempotent ATA creates and the wSOL unwrap", () => {
    const ctx = setup();
    const { wsol, synb } = ctx.chain.mints;
    const ixs = [
      ...[wsol, synb].map((mint) =>
        createAssociatedTokenAccountIdempotentInstruction(ctx.owner, ctx.ata(mint), ctx.owner, pk(mint)),
      ),
      cpmmWithdraw(ctx),
      createCloseAccountInstruction(ctx.ata(wsol), ctx.owner, ctx.owner),
    ];
    expect(verifyMessage(compile(ctx, ixs), withdrawing(ctx))).toEqual(OK);
  });

  it("a Raydium AMM v4 withdraw, a plain ATA create and a Token-2022 close", () => {
    const ctx = setup();
    const { sync, synt } = ctx.chain.mints;
    const ixs = [
      createAssociatedTokenAccountInstruction(ctx.owner, ctx.ata(sync), ctx.owner, pk(sync)),
      ammV4Withdraw(ctx),
      createCloseAccountInstruction(ctx.ata(synt), ctx.owner, ctx.owner, [], TOKEN_2022_PROGRAM_ID),
    ];
    expect(verifyMessage(compile(ctx, ixs), withdrawing(ctx))).toEqual(OK);
  });
});

// --- Rejected: the brief's fifteen ------------------------------------------

describe("verifyMessage rejects", () => {
  it("1. a stranger as fee payer", async () => {
    const ctx = setup();
    const message = compile(ctx, await dammClaim(ctx), { payer: STRANGER });
    expect(verifyMessage(message, ctx.expectation)).toEqual(rejected("fee payer is not the connected wallet"));
  });

  it("2. a second signer", async () => {
    const ctx = setup();
    const memo = new TransactionInstruction({
      programId: MEMO,
      keys: [{ pubkey: STRANGER, isSigner: true, isWritable: false }],
      data: Buffer.from("hi"),
    });
    const message = compile(ctx, [...(await dammClaim(ctx)), memo]);
    expect(verifyMessage(message, ctx.expectation)).toEqual(
      rejected("only the connected wallet may sign (the message needs 2 signatures)"),
    );
  });

  it("3. a System transfer", async () => {
    const ctx = setup();
    const transfer = SystemProgram.transfer({ fromPubkey: ctx.owner, toPubkey: STRANGER, lamports: 1_000 });
    const message = compile(ctx, [...(await dammClaim(ctx)), transfer]);
    expect(verifyMessage(message, ctx.expectation)).toEqual(
      rejected("program 11111111111111111111111111111111 is not allowed"),
    );
  });

  it("4. a Token Transfer", () => {
    const ctx = setup();
    const { syna } = ctx.chain.mints;
    const transfer = createTransferInstruction(ctx.ata(syna), ctx.ata(syna, STRANGER), ctx.owner, 1_000);
    expect(verifyMessage(compile(ctx, [transfer]), ctx.expectation)).toEqual(
      rejected("Token instruction 3 is not allowed"),
    );
  });

  it("5. a Token Approve and a Token SetAuthority", () => {
    const ctx = setup();
    const { syna, synt } = ctx.chain.mints;
    const approve = createApproveInstruction(ctx.ata(syna), STRANGER, ctx.owner, 1_000);
    expect(verifyMessage(compile(ctx, [approve]), ctx.expectation)).toEqual(
      rejected("Token instruction 4 is not allowed"),
    );
    const setAuthority = createSetAuthorityInstruction(
      ctx.ata(synt),
      ctx.owner,
      AuthorityType.CloseAccount,
      STRANGER,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    expect(verifyMessage(compile(ctx, [setAuthority]), ctx.expectation)).toEqual(
      rejected("Token-2022 instruction 6 is not allowed"),
    );
  });

  it("6. a CloseAccount whose destination is a stranger", () => {
    const ctx = setup();
    const close = createCloseAccountInstruction(ctx.ata(ctx.chain.mints.wsol), STRANGER, ctx.owner);
    expect(verifyMessage(compile(ctx, [close]), ctx.expectation)).toEqual(
      rejected("CloseAccount destination is not the connected wallet"),
    );
  });

  it("7. a claim whose receiver ATA belongs to a stranger", async () => {
    const ctx = setup();
    const ixs = await dammClaim(ctx, STRANGER);
    // The SDK puts the stranger's token A ATA in the claim (wSOL stays the owner's).
    const claim = only(ixs, PROGRAM_IDS.cpAmm)[0];
    expect(claim.keys[3].pubkey.toBase58()).toBe(ctx.ata(ctx.chain.mints.syna, STRANGER).toBase58());
    expect(verifyMessage(compile(ctx, [claim]), ctx.expectation)).toEqual(
      rejected(
        "meteora-damm-v2 claim_position_fee account 3 (token_a_account) is not the connected wallet's own token account",
      ),
    );
    // The whole SDK transaction fails earlier, on the ATA create for the stranger.
    expect(verifyMessage(compile(ctx, ixs), ctx.expectation)).toEqual(
      rejected("ATA create wallet is not the connected wallet"),
    );
  });

  it("8. a CLMM decrease whose recipient account is a stranger", () => {
    const ctx = setup();
    const { pool } = clmmKeys(ctx);
    const ix = clmmDecrease(ctx, { recipientA: ctx.ata(pool.mintA.toBase58(), STRANGER) });
    expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(
      rejected(
        "raydium-clmm decrease_liquidity_v2 account 9 (recipient_token_account_0) is not the connected wallet's own token account",
      ),
    );
  });

  it("9. an unknown program", () => {
    const ctx = setup();
    const ix = new TransactionInstruction({
      programId: UNKNOWN_PROGRAM,
      keys: [{ pubkey: ctx.owner, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    });
    expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(
      rejected(`program ${UNKNOWN_PROGRAM.toBase58()} is not allowed`),
    );
  });

  it("10. a cp-amm instruction outside the list (add_liquidity)", async () => {
    const ctx = setup();
    const { accounts } = await dammAccounts(ctx);
    const tx = await ctx.cpAmm.addLiquidity({
      ...accounts,
      liquidityDelta: new BN(1_000),
      maxAmountTokenA: new BN(1_000),
      maxAmountTokenB: new BN(1_000),
      tokenAAmountThreshold: new BN(1_000),
      tokenBAmountThreshold: new BN(1_000),
    });
    const add = only(tx.instructions, PROGRAM_IDS.cpAmm);
    expect(add).toHaveLength(1);
    const hex = Buffer.from(add[0].data.subarray(0, 8)).toString("hex");
    expect(hex).toBe(createHash("sha256").update("global:add_liquidity").digest().subarray(0, 8).toString("hex"));
    expect(verifyMessage(compile(ctx, add), ctx.expectation)).toEqual(
      rejected(`meteora-damm-v2 instruction ${hex} is not allowed`),
    );
  });

  it("11. a position NFT account not in positions", async () => {
    const ctx = setup();
    const ixs = await dammClaim(ctx);
    const expectation = {
      ...ctx.expectation,
      positions: ctx.expectation.positions.filter((p) => p.nftAccount !== ctx.chain.dammV2.positionNftAccount),
    };
    expect(verifyMessage(compile(ctx, ixs), expectation)).toEqual(
      rejected(
        "meteora-damm-v2 claim_position_fee account 9 (position_nft_account) is not an expected meteora-damm-v2 position",
      ),
    );
  });

  it("12. a compute-unit price of 1,000,001", async () => {
    const ctx = setup();
    const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_001 }), ...(await dammClaim(ctx))];
    expect(verifyMessage(compile(ctx, ixs), ctx.expectation)).toEqual(
      rejected("compute-unit price 1000001 is above 1000000 µlamports"),
    );
    const atCap = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), ...(await dammClaim(ctx))];
    expect(verifyMessage(compile(ctx, atCap), ctx.expectation)).toEqual(OK);
  });

  it("13. two SetComputeUnitLimit instructions", async () => {
    const ctx = setup();
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ...(await dammClaim(ctx)),
    ];
    expect(verifyMessage(compile(ctx, ixs), ctx.expectation)).toEqual(
      rejected("more than one SetComputeUnitLimit"),
    );
  });

  it("14. a message with an address-table lookup", async () => {
    const ctx = setup();
    const ixs = await dammClaim(ctx);
    const table = new AddressLookupTableAccount({
      key: seededKey(95),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [pk(ctx.chain.dammV2.pool)],
      },
    });
    const message = compile(ctx, ixs, { lookups: [table] });
    expect(message.addressTableLookups).toHaveLength(1);
    expect(verifyMessage(message, ctx.expectation)).toEqual(rejected("address-table lookups are not allowed"));
  });

  it("15. an ATA create for a mint not in mints", () => {
    const ctx = setup();
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      ctx.owner,
      getAssociatedTokenAddressSync(STRANGER_MINT, ctx.owner),
      ctx.owner,
      STRANGER_MINT,
    );
    expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(
      rejected(`ATA create for unexpected mint ${STRANGER_MINT.toBase58()}`),
    );
  });
});

// --- Rejected: further rules ------------------------------------------------

function rawMessage(ctx: Ctx, keys: PublicKey[], accountKeyIndexes: number[], programIdIndex: number) {
  return new MessageV0({
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    staticAccountKeys: keys,
    recentBlockhash: MOCK_BLOCKHASH,
    compiledInstructions: [{ programIdIndex, accountKeyIndexes, data: new Uint8Array([1]) }],
    addressTableLookups: [],
  });
}

describe("verifyMessage also rejects", () => {
  it("a duplicate account key (the owner again as a non-signer)", () => {
    const ctx = setup();
    const message = rawMessage(ctx, [ctx.owner, ctx.owner, MEMO], [1], 2);
    expect(verifyMessage(message, ctx.expectation)).toEqual(rejected("duplicate account key"));
  });

  it("an account index outside the message", () => {
    const ctx = setup();
    expect(verifyMessage(rawMessage(ctx, [ctx.owner, MEMO], [5], 1), ctx.expectation)).toEqual(
      rejected("instruction 0 references a missing account"),
    );
    expect(verifyMessage(rawMessage(ctx, [ctx.owner, MEMO], [0], 7), ctx.expectation)).toEqual(
      rejected("instruction 0 references a missing account"),
    );
  });

  it("an owner that is not a valid wallet address, without throwing", () => {
    const ctx = setup();
    const message = compile(ctx, [clmmClose(ctx)]);
    expect(verifyMessage(message, { ...ctx.expectation, owner: "not-a-key" })).toEqual(
      rejected("owner is not a valid wallet address"),
    );
    const offCurve = pk(ctx.chain.dammV2.position).toBase58(); // a PDA
    expect(verifyMessage(message, { ...ctx.expectation, owner: offCurve })).toEqual(
      rejected("owner is not a valid wallet address"),
    );
  });

  it("an expected mint whose token program is not Token or Token-2022", () => {
    const ctx = setup();
    const expectation = {
      ...ctx.expectation,
      mints: [...ctx.expectation.mints, { mint: STRANGER_MINT.toBase58(), tokenProgram: UNKNOWN_PROGRAM.toBase58() }],
    };
    expect(verifyMessage(compile(ctx, [clmmClose(ctx)]), expectation)).toEqual(
      rejected(`expected mint ${STRANGER_MINT.toBase58()} has unknown token program ${UNKNOWN_PROGRAM.toBase58()}`),
    );
  });

  it("compute-budget limits and kinds outside the caps", () => {
    const ctx = setup();
    const cases: [TransactionInstruction[], string][] = [
      [[ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 })], "compute-unit limit 1400001 is above 1400000"],
      [
        [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ],
        "more than one SetComputeUnitPrice",
      ],
      [[ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 })], "Compute Budget instruction 1 is not allowed"],
      [
        [
          new TransactionInstruction({
            programId: ComputeBudgetProgram.programId,
            keys: [],
            data: Buffer.from([2, 1, 0]),
          }),
        ],
        "Compute Budget instruction 2 is malformed",
      ],
    ];
    for (const [ixs, reason] of cases)
      expect(verifyMessage(compile(ctx, [...ixs, clmmDecrease(ctx)]), ctx.expectation)).toEqual(rejected(reason));
    const atCap = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), clmmDecrease(ctx)];
    expect(verifyMessage(compile(ctx, atCap), ctx.expectation)).toEqual(OK);
  });

  it("ATA instructions that are not the owner's own create", () => {
    const ctx = setup();
    const { syna, synt } = ctx.chain.mints;
    const create = (payer: PublicKey, ata: PublicKey, wallet: PublicKey, mint: string, program = TOKEN_PROGRAM_ID) =>
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, wallet, pk(mint), program);
    const good = create(ctx.owner, ctx.ata(syna), ctx.owner, syna);
    const cases: [TransactionInstruction, string][] = [
      [withKey(good, 0, STRANGER), "ATA create payer is not the connected wallet"],
      [
        create(ctx.owner, ctx.ata(syna, STRANGER), STRANGER, syna),
        "ATA create wallet is not the connected wallet",
      ],
      // Token-2022 mint with a Token-program ATA.
      [
        create(ctx.owner, getAssociatedTokenAddressSync(pk(synt), ctx.owner), ctx.owner, synt),
        `ATA create account is not the connected wallet's ATA of ${synt}`,
      ],
      [withKey(good, 1, ctx.ata(synt)), `ATA create account is not the connected wallet's ATA of ${syna}`],
      [
        new TransactionInstruction({ programId: good.programId, keys: good.keys, data: Buffer.from([2]) }),
        "ATA instruction 2 is not allowed",
      ],
      [
        new TransactionInstruction({
          programId: good.programId,
          keys: [...good.keys, { pubkey: STRANGER, isSigner: false, isWritable: true }],
          data: good.data,
        }),
        "ATA create has 7 accounts; expected 6",
      ],
    ];
    for (const [ix, reason] of cases)
      expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(rejected(reason));
  });

  it("CloseAccount on anything but the owner's ATA of an expected mint, to the owner", () => {
    const ctx = setup();
    const { wsol, synt } = ctx.chain.mints;
    const good = createCloseAccountInstruction(ctx.ata(wsol), ctx.owner, ctx.owner);
    const cases: [TransactionInstruction, string][] = [
      [withKey(good, 2, STRANGER), "CloseAccount authority is not the connected wallet"],
      [
        createCloseAccountInstruction(ctx.ata(wsol, STRANGER), ctx.owner, ctx.owner),
        "CloseAccount account is not the connected wallet's token account of an expected mint",
      ],
      // The owner's Token-2022 ATA closed through the Token program.
      [
        createCloseAccountInstruction(ctx.ata(synt), ctx.owner, ctx.owner),
        "CloseAccount account is not the connected wallet's token account of an expected mint",
      ],
      [
        new TransactionInstruction({
          programId: good.programId,
          keys: [...good.keys, { pubkey: STRANGER, isSigner: false, isWritable: false }],
          data: good.data,
        }),
        "CloseAccount must have exactly 3 accounts",
      ],
    ];
    for (const [ix, reason] of cases)
      expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(rejected(reason));
  });

  it("CloseAccount on a position NFT account, even one that is an expected ATA", () => {
    const ctx = setup();
    const nftMint = seededKey(94);
    const nftAccount = getAssociatedTokenAddressSync(nftMint, ctx.owner, false, TOKEN_2022_PROGRAM_ID);
    const expectation: Expectation = {
      ...ctx.expectation,
      mints: [...ctx.expectation.mints, { mint: nftMint.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }],
      positions: [
        ...ctx.expectation.positions,
        { position: seededKey(93).toBase58(), nftAccount: nftAccount.toBase58(), protocol: "raydium-clmm" },
      ],
    };
    const close = createCloseAccountInstruction(nftAccount, ctx.owner, ctx.owner, [], TOKEN_2022_PROGRAM_ID);
    expect(verifyMessage(compile(ctx, [close]), expectation)).toEqual(
      rejected("CloseAccount on a position NFT account"),
    );
  });

  it("a position of another protocol", () => {
    const ctx = setup();
    const expectation: Expectation = {
      ...ctx.expectation,
      positions: ctx.expectation.positions.map((p) =>
        p.protocol === "raydium-clmm" ? { ...p, protocol: "meteora-damm-v2" } : p,
      ),
    };
    expect(verifyMessage(compile(ctx, [clmmDecrease(ctx)]), expectation)).toEqual(
      rejected(
        "raydium-clmm decrease_liquidity_v2 account 1 (nft_account) is not an expected raydium-clmm position",
      ),
    );
  });

  it("a cp-amm close_position whose rent receiver is a stranger", async () => {
    const ctx = setup();
    const [close] = await dammClose(ctx);
    expect(verifyMessage(compile(ctx, [withKey(close, 5, STRANGER)]), withdrawing(ctx))).toEqual(
      rejected("meteora-damm-v2 close_position account 5 (rent_receiver) is not the connected wallet"),
    );
  });

  it("a protocol instruction whose owner account is someone else", () => {
    const ctx = setup();
    expect(verifyMessage(compile(ctx, [withKey(cpmmWithdraw(ctx), 0, STRANGER)]), withdrawing(ctx))).toEqual(
      rejected("raydium-cpmm withdraw account 0 (owner) is not the connected wallet"),
    );
  });

  it("CPMM and AMM v4 withdrawals paying a stranger", () => {
    const ctx = setup();
    expect(
      verifyMessage(compile(ctx, [withKey(cpmmWithdraw(ctx), 5, STRANGER)]), withdrawing(ctx)),
    ).toEqual(rejected("raydium-cpmm withdraw account 5 (token_1_account) is not the connected wallet's own token account"));
    const strangerWsol = ctx.ata(ctx.chain.mints.wsol, STRANGER);
    expect(
      verifyMessage(compile(ctx, [withKey(ammV4Withdraw(ctx), 17, strangerWsol)]), withdrawing(ctx)),
    ).toEqual(
      rejected(
        "raydium-amm-v4 withdraw account 17 (user_quote_token_account) is not the connected wallet's own token account",
      ),
    );
  });

  it("protocol instructions with the wrong number of accounts", async () => {
    const ctx = setup();
    const claim = only(await dammClaim(ctx), PROGRAM_IDS.cpAmm)[0];
    const extra = { pubkey: STRANGER, isSigner: false, isWritable: true };
    const padded = new TransactionInstruction({
      programId: claim.programId,
      keys: [...claim.keys, extra],
      data: claim.data,
    });
    expect(verifyMessage(compile(ctx, [padded]), ctx.expectation)).toEqual(
      rejected("meteora-damm-v2 claim_position_fee has 16 accounts; expected 15"),
    );
    const amm = ammV4Withdraw(ctx);
    const short = new TransactionInstruction({ programId: amm.programId, keys: amm.keys.slice(0, 21), data: amm.data });
    expect(verifyMessage(compile(ctx, [short]), withdrawing(ctx))).toEqual(
      rejected("raydium-amm-v4 withdraw has 21 accounts; expected 22"),
    );
    const close = clmmClose(ctx);
    const long = new TransactionInstruction({ programId: close.programId, keys: [...close.keys, extra], data: close.data });
    expect(verifyMessage(compile(ctx, [long]), withdrawing(ctx))).toEqual(
      rejected("raydium-clmm close_position has 8 accounts; expected 6 or 7"),
    );
  });

  it("an AMM v4 instruction other than withdraw", () => {
    const ctx = setup();
    const amm = ammV4Withdraw(ctx);
    const swap = new TransactionInstruction({ programId: amm.programId, keys: amm.keys, data: Buffer.from([9, 0]) });
    expect(verifyMessage(compile(ctx, [swap]), ctx.expectation)).toEqual(
      rejected("raydium-amm-v4 instruction 9 is not allowed"),
    );
  });

  it("a CLMM reward paid to a stranger", () => {
    const ctx = setup();
    const ix = clmmDecrease(ctx, {
      rewards: [rewardTriple(ctx, ctx.ata(ctx.chain.mints.reward, STRANGER))],
    });
    expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(
      rejected(
        "raydium-clmm decrease_liquidity_v2 account 18 (reward recipient) is not the connected wallet's own token account",
      ),
    );
  });

  it("CLMM reward accounts that could be read two ways", () => {
    const ctx = setup();
    const { bitmap } = clmmKeys(ctx);
    const own = ctx.ata(ctx.chain.mints.reward);
    // Without a bitmap, [vault, stranger, own, x] would pass a parse that
    // assumed a leading bitmap, while the program pays the stranger.
    const shifted = clmmDecrease(ctx, {
      bitmap: false,
      rewards: [rewardTriple(ctx, ctx.ata(ctx.chain.mints.reward, STRANGER))],
    });
    shifted.keys[18] = { ...shifted.keys[18], pubkey: own };
    shifted.keys.push({ pubkey: seededKey(92), isSigner: false, isWritable: false });
    expect(verifyMessage(compile(ctx, [shifted]), ctx.expectation)).toEqual(
      rejected("raydium-clmm decrease_liquidity_v2 has 4 reward accounts; expected a multiple of 3"),
    );
    // The bitmap extension only ever comes first.
    const late = clmmDecrease(ctx, { bitmap: false, rewards: [rewardTriple(ctx)] });
    late.keys.push({ pubkey: bitmap, isSigner: false, isWritable: true });
    expect(verifyMessage(compile(ctx, [late]), ctx.expectation)).toEqual(
      rejected("raydium-clmm decrease_liquidity_v2 has the tick-array bitmap extension out of place"),
    );
  });
});

// --- Action kinds and instruction arguments (ruling R-T6b) -------------------

describe("verifyMessage by action kind", () => {
  const big = (n: BN | number) => BigInt(n.toString());
  const cpAmmIxs = async (ixs: Promise<TransactionInstruction[]>) => only(await ixs, PROGRAM_IDS.cpAmm);

  it("rejects a claim that is really a full CLMM withdrawal with no minimums, then a close", () => {
    const ctx = setup();
    const attack = [clmmDecrease(ctx, { liquidity: new BN(1).shln(127) }), clmmClose(ctx)];
    expect(verifyMessage(compile(ctx, attack), ctx.expectation)).toEqual(
      rejected("raydium-clmm decrease_liquidity_v2 in a claim must remove 0 liquidity with 0 minimums"),
    );
    expect(verifyMessage(compile(ctx, attack), withdrawing(ctx))).toEqual(
      rejected("raydium-clmm decrease_liquidity_v2 has no minimum amounts"),
    );
  });

  it("rejects a CLMM collect in a claim that sets a minimum", () => {
    const ctx = setup();
    expect(verifyMessage(compile(ctx, [clmmDecrease(ctx, { b: new BN(1) })]), ctx.expectation)).toEqual(
      rejected("raydium-clmm decrease_liquidity_v2 in a claim must remove 0 liquidity with 0 minimums"),
    );
  });

  it("rejects every removal and close instruction in a claim, and allows each in a withdraw", async () => {
    const ctx = setup();
    const [refresh, remove] = await cpAmmIxs(dammRemoveVested(ctx));
    const cases: [TransactionInstruction, string][] = [
      [refresh, "meteora-damm-v2 refresh_vesting"],
      [remove, "meteora-damm-v2 remove_liquidity"],
      [(await cpAmmIxs(dammRemoveAll(ctx)))[0], "meteora-damm-v2 remove_all_liquidity"],
      [(await dammClose(ctx))[0], "meteora-damm-v2 close_position"],
      [clmmClose(ctx), "raydium-clmm close_position"],
      [cpmmWithdraw(ctx), "raydium-cpmm withdraw"],
      [ammV4Withdraw(ctx), "raydium-amm-v4 withdraw"],
    ];
    for (const [ix, label] of cases) {
      expect(verifyMessage(compile(ctx, [ix]), ctx.expectation)).toEqual(
        rejected(`${label} is not allowed in a claim`),
      );
      expect(verifyMessage(compile(ctx, [ix]), withdrawing(ctx)), label).toEqual(OK);
    }
  });

  it("rejects withdrawals whose minimums are all zero, for each protocol", async () => {
    const ctx = setup();
    const zero = { a: new BN(0), b: new BN(0) };
    const cases: [TransactionInstruction, string][] = [
      [(await cpAmmIxs(dammRemoveVested(ctx, zero)))[1], "meteora-damm-v2 remove_liquidity"],
      [(await cpAmmIxs(dammRemoveAll(ctx, zero)))[0], "meteora-damm-v2 remove_all_liquidity"],
      [clmmDecrease(ctx, { liquidity: SYNTHETIC.clmm.liquidity, ...zero }), "raydium-clmm decrease_liquidity_v2"],
      [cpmmWithdraw(ctx, zero), "raydium-cpmm withdraw"],
      [ammV4Withdraw(ctx, zero), "raydium-amm-v4 withdraw"],
    ];
    for (const [ix, label] of cases)
      expect(verifyMessage(compile(ctx, [ix]), withdrawing(ctx))).toEqual(
        rejected(`${label} has no minimum amounts`),
      );
    // One non-zero minimum is enough (a single-sided position).
    const oneSided = cpmmWithdraw(ctx, { a: new BN(0), b: new BN(5) });
    expect(verifyMessage(compile(ctx, [oneSided]), withdrawing(ctx))).toEqual(OK);
  });

  it("rejects zero-amount removals but allows the CLMM zero-liquidity collect in both kinds", async () => {
    const ctx = setup();
    // The SDK refuses a zero liquidity delta, so zero it in the encoded data.
    const remove = (await cpAmmIxs(dammRemoveVested(ctx)))[1];
    const data = Buffer.from(remove.data);
    data.fill(0, 8, 24);
    const zeroRemove = new TransactionInstruction({ programId: remove.programId, keys: remove.keys, data });
    const cases: [TransactionInstruction, string][] = [
      [zeroRemove, "meteora-damm-v2 remove_liquidity removes nothing"],
      [cpmmWithdraw(ctx, { lp: new BN(0) }), "raydium-cpmm withdraw removes nothing"],
      [ammV4Withdraw(ctx, { lp: new BN(0) }), "raydium-amm-v4 withdraw removes nothing"],
    ];
    for (const [ix, reason] of cases)
      expect(verifyMessage(compile(ctx, [ix]), withdrawing(ctx))).toEqual(rejected(reason));
    expect(verifyMessage(compile(ctx, [clmmDecrease(ctx)]), withdrawing(ctx))).toEqual(OK);
    expect(verifyMessage(compile(ctx, [clmmDecrease(ctx)]), ctx.expectation)).toEqual(OK);
  });

  it("rejects allowed instructions whose data has the wrong length", async () => {
    const ctx = setup();
    const claim = (await cpAmmIxs(dammClaim(ctx)))[0];
    const padded = new TransactionInstruction({
      programId: claim.programId,
      keys: claim.keys,
      data: Buffer.concat([claim.data, Buffer.from([0])]),
    });
    expect(verifyMessage(compile(ctx, [padded]), ctx.expectation)).toEqual(
      rejected("meteora-damm-v2 claim_position_fee has 9 data bytes; expected 8"),
    );
    // An AMM v4 withdraw without its optional minimums.
    const amm = ammV4Withdraw(ctx);
    const noMinimums = new TransactionInstruction({ programId: amm.programId, keys: amm.keys, data: amm.data.subarray(0, 9) });
    expect(verifyMessage(compile(ctx, [noMinimums]), withdrawing(ctx))).toEqual(
      rejected("raydium-amm-v4 withdraw has 9 data bytes; expected 25"),
    );
    const decrease = clmmDecrease(ctx);
    const short = new TransactionInstruction({
      programId: decrease.programId,
      keys: decrease.keys,
      data: decrease.data.subarray(0, 24),
    });
    expect(verifyMessage(compile(ctx, [short]), ctx.expectation)).toEqual(
      rejected("raydium-clmm decrease_liquidity_v2 has 24 data bytes; expected 40"),
    );
  });

  it("rejects an unknown action kind", () => {
    const ctx = setup();
    const expectation = { ...ctx.expectation, kind: "swap" } as unknown as Expectation;
    expect(verifyMessage(compile(ctx, [clmmDecrease(ctx)]), expectation)).toEqual(rejected("unknown action kind"));
  });

  it("decodes arguments exactly as the SDK builders encode them", async () => {
    const ctx = setup();
    const decode = (program: string, name: string, ix: TransactionInstruction) => {
      const s = spec(program, name);
      expect(ix.data.length, name).toBe(s.args.length);
      return decodeInstructionArgs(s.args, ix.data);
    };
    const delta = new BN(1).shln(100).addn(5);
    const [, remove] = await cpAmmIxs(dammRemoveVested(ctx, { delta, a: new BN(111), b: new BN(222) }));
    expect(decode(PROGRAM_IDS.cpAmm, "remove_liquidity", remove)).toEqual({
      amount: big(delta),
      minimums: [big(111), big(222)],
    });
    const [removeAll] = await cpAmmIxs(dammRemoveAll(ctx, { a: new BN(333), b: new BN(444) }));
    expect(decode(PROGRAM_IDS.cpAmm, "remove_all_liquidity", removeAll)).toEqual({
      amount: null,
      minimums: [big(333), big(444)],
    });
    const liquidity = new BN(1).shln(127).addn(9);
    const decrease = clmmDecrease(ctx, { liquidity, a: new BN(555), b: new BN(666) });
    expect(decode(PROGRAM_IDS.clmm, "decrease_liquidity_v2", decrease)).toEqual({
      amount: big(liquidity),
      minimums: [big(555), big(666)],
    });
    const cpmm = cpmmWithdraw(ctx, { lp: new BN(12_345), a: new BN(777), b: new BN(888) });
    expect(decode(PROGRAM_IDS.cpmm, "withdraw", cpmm)).toEqual({
      amount: big(12_345),
      minimums: [big(777), big(888)],
    });
    const amm = ammV4Withdraw(ctx, { lp: new BN(54_321), a: new BN(999), b: new BN(1_010) });
    expect(decode(PROGRAM_IDS.ammV4, "withdraw", amm)).toEqual({
      amount: big(54_321),
      minimums: [big(999), big(1_010)],
    });
    // Instructions without amounts still have exactly the encoded length.
    decode(PROGRAM_IDS.cpAmm, "claim_position_fee", (await cpAmmIxs(dammClaim(ctx)))[0]);
    decode(PROGRAM_IDS.cpAmm, "claim_reward", (await cpAmmIxs(dammClaimReward(ctx)))[0]);
    decode(PROGRAM_IDS.cpAmm, "refresh_vesting", (await cpAmmIxs(dammRemoveVested(ctx)))[0]);
    decode(PROGRAM_IDS.cpAmm, "close_position", (await dammClose(ctx))[0]);
    decode(PROGRAM_IDS.clmm, "close_position", clmmClose(ctx));
  });
});
