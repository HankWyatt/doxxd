// @vitest-environment node
// web3.js derives program addresses with Node's crypto; jsdom's realm breaks
// that, so these suites run in the node environment.
import { createHash } from "node:crypto";
import {
  CpAmm,
  deriveRewardVaultAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  getAvailableVestingLiquidity,
  getUnClaimLpFee,
} from "@meteora-ag/cp-amm-sdk";
import {
  CpmmPoolInfoLayout,
  MARKET_STATE_LAYOUT_V3,
  Market,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickArrayLayout,
  getAssociatedPoolKeys,
  getCreatePoolKeys,
  getPdaPersonalPositionAddress,
  getPdaPoolVaultId,
  getPdaTickArrayAddress,
  liquidityStateV4Layout,
} from "@raydium-io/raydium-sdk-v2";
import {
  getAssociatedTokenAddressSync,
  getTransferFeeAmount,
  getTransferFeeConfig,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { VESTING_POSITION_OFFSET, VESTING_SIZE } from "@/lib/rpc/policy";
import {
  PROGRAM_IDS,
  SYNTHETIC,
  chainFixture,
  tokenAccountData,
  type SyntheticChain,
} from "./actions-chain";
import { mockActionRpc, postStatesFrom } from "./mock-action-rpc";

const pk = (address: string) => new PublicKey(address);
const anchorDiscriminator = (name: string) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

async function account(chain: SyntheticChain, address: string) {
  const info = await mockActionRpc(chain).connection.getAccountInfo(pk(address));
  if (!info) throw new Error(`missing ${address}`);
  return info;
}

describe("chainFixture: Meteora DAMM v2", () => {
  it("decodes the pool with CpAmm.fetchPoolState back to the encoded values", async () => {
    const chain = chainFixture();
    const cpAmm = new CpAmm(mockActionRpc(chain).connection);
    const poolKey = pk(chain.dammV2.pool);
    const pool = await cpAmm.fetchPoolState(poolKey);

    expect(pool.tokenAMint.toBase58()).toBe(chain.mints.syna);
    expect(pool.tokenBMint.toBase58()).toBe(chain.mints.wsol);
    expect(pool.tokenAVault.toBase58()).toBe(
      deriveTokenVaultAddress(pk(chain.mints.syna), poolKey).toBase58(),
    );
    expect(pool.tokenBVault.toBase58()).toBe(
      deriveTokenVaultAddress(pk(chain.mints.wsol), poolKey).toBase58(),
    );
    expect([pool.tokenAFlag, pool.tokenBFlag]).toEqual([0, 0]);
    expect(pool.liquidity.toString()).toBe(SYNTHETIC.dammV2.poolLiquidity.toString());
    expect(pool.permanentLockLiquidity.toString()).toBe(
      SYNTHETIC.dammV2.halfLiquidity.toString(),
    );
    expect(pool.sqrtPrice.toString()).toBe(SYNTHETIC.dammV2.sqrtPrice.toString());
    expect(pool.activationType).toBe(1);
    expect(pool.collectFeeMode).toBe(0);
    expect(pool.rewardInfos[0].initialized).toBe(1);
    expect(pool.rewardInfos[0].mint.toBase58()).toBe(chain.mints.reward);
    expect(pool.rewardInfos[0].vault.toBase58()).toBe(
      deriveRewardVaultAddress(poolKey, 0).toBase58(),
    );
    expect(pool.rewardInfos[1].initialized).toBe(0);
    expect((await account(chain, chain.dammV2.pool)).owner.toBase58()).toBe(PROGRAM_IDS.cpAmm);
  });

  it("holds unlocked, vested and permanently locked positions with live fees", async () => {
    const chain = chainFixture();
    const cpAmm = new CpAmm(mockActionRpc(chain).connection);
    const pool = await cpAmm.fetchPoolState(pk(chain.dammV2.pool));
    const { unlocked, vested, locked, noFees } = chain.dammV2.variants;
    const half = SYNTHETIC.dammV2.halfLiquidity.toString();
    const full = SYNTHETIC.dammV2.positionLiquidity.toString();

    for (const variant of [unlocked, vested, locked, noFees]) {
      expect(variant.position).toBe(derivePositionAddress(pk(variant.positionMint)).toBase58());
      expect(variant.positionNftAccount).toBe(
        derivePositionNftAccount(pk(variant.positionMint)).toBase58(),
      );
      const nft = unpackAccount(
        pk(variant.positionNftAccount),
        await account(chain, variant.positionNftAccount),
        pk(PROGRAM_IDS.token2022),
      );
      expect(nft.owner.toBase58()).toBe(chain.owner.publicKey.toBase58());
      expect(nft.mint.toBase58()).toBe(variant.positionMint);
      expect(nft.amount).toBe(BigInt(1));
    }
    expect(chain.dammV2.position).toBe(unlocked.position);

    const states = await Promise.all(
      [unlocked, vested, locked].map((v) => cpAmm.fetchPositionState(pk(v.position))),
    );
    expect(states.map((s) => s.pool.toBase58())).toEqual(Array(3).fill(chain.dammV2.pool));
    expect(
      states.map((s) => [
        s.unlockedLiquidity.toString(),
        s.vestedLiquidity.toString(),
        s.permanentLockedLiquidity.toString(),
      ]),
    ).toEqual([
      [full, "0", "0"],
      [half, half, "0"],
      [half, "0", half],
    ]);
    for (const state of states) {
      const fees = getUnClaimLpFee(pool, state, new BN(SYNTHETIC.clock.unixTimestamp));
      expect(fees.feeTokenA.toString()).toBe(SYNTHETIC.dammV2.feeAPending.toString());
      expect(fees.feeTokenB.toString()).toBe(SYNTHETIC.dammV2.feeBAccrued.toString());
      expect(fees.rewards[0].toString()).toBe(SYNTHETIC.dammV2.rewardPending.toString());
    }

    const empty = await cpAmm.fetchPositionState(pk(noFees.position));
    const none = getUnClaimLpFee(pool, empty, new BN(SYNTHETIC.clock.unixTimestamp));
    expect([none.feeTokenA, none.feeTokenB, ...none.rewards].map(String)).toEqual([
      "0",
      "0",
      "0",
      "0",
    ]);
  });

  it("finds the vesting account through the pass-through's vesting filter", async () => {
    const chain = chainFixture();
    const rpc = mockActionRpc(chain);
    const { vested } = chain.dammV2.variants;
    expect(vested.vesting).toBeDefined();
    const found = await rpc.connection.getProgramAccounts(pk(PROGRAM_IDS.cpAmm), {
      filters: [
        { dataSize: VESTING_SIZE },
        { memcmp: { offset: VESTING_POSITION_OFFSET, bytes: vested.position } },
      ],
    });
    expect(found.map((a) => a.pubkey.toBase58())).toEqual([vested.vesting]);

    const vesting = await new CpAmm(rpc.connection)._program.account.vesting.fetch(
      pk(vested.vesting!),
    );
    expect(vesting.position.toBase58()).toBe(vested.position);
    const now = new BN(SYNTHETIC.clock.unixTimestamp);
    expect(getAvailableVestingLiquidity(vesting, now).toString()).toBe(
      SYNTHETIC.dammV2.releasableVesting.toString(),
    );
    // The SDK's own lookup adds a discriminator filter the pass-through
    // refuses (ruling R-P2), so builders query with the shape above.
    await expect(
      new CpAmm(rpc.connection).getAllVestingsByPosition(pk(vested.position)),
    ).rejects.toThrow(/Invalid params/);
  });

  it("holds inner-vesting positions: fully elapsed, partly elapsed and before the cliff", async () => {
    const chain = chainFixture();
    const cpAmm = new CpAmm(mockActionRpc(chain).connection);
    const { innerElapsed, innerPartial, innerBeforeCliff } = chain.dammV2.variants;
    const now = new BN(SYNTHETIC.clock.unixTimestamp);
    const half = SYNTHETIC.dammV2.halfLiquidity;
    const released = [];
    for (const variant of [innerElapsed, innerPartial, innerBeforeCliff]) {
      const state = await cpAmm.fetchPositionState(pk(variant.position));
      expect(state.pool.toBase58()).toBe(chain.dammV2.pool);
      expect(state.vestedLiquidity.toString()).toBe(half.toString());
      const { innerVesting } = state;
      // Each schedule vests exactly the position's vested liquidity.
      expect(
        innerVesting.cliffUnlockLiquidity.add(innerVesting.liquidityPerPeriod.muln(innerVesting.numberOfPeriod)).toString(),
      ).toBe(half.toString());
      released.push(getAvailableVestingLiquidity({ innerVesting } as never, now).toString());
    }
    expect(released).toEqual([half.toString(), SYNTHETIC.dammV2.innerPartialReleasable.toString(), "0"]);
    // None of them has a Vesting account.
    const vestings = await mockActionRpc(chain).connection.getProgramAccounts(pk(PROGRAM_IDS.cpAmm), {
      filters: [
        { dataSize: VESTING_SIZE },
        { memcmp: { offset: VESTING_POSITION_OFFSET, bytes: innerPartial.position } },
      ],
    });
    expect(vestings).toEqual([]);
  });

  it("has a Token-2022 transfer-fee mint in a second pool", async () => {
    const chain = chainFixture();
    const cpAmm = new CpAmm(mockActionRpc(chain).connection);
    const { transferFee } = chain.dammV2.variants;
    const pool = await cpAmm.fetchPoolState(pk(transferFee.pool));
    expect(pool.tokenAMint.toBase58()).toBe(chain.mints.synt);
    expect([pool.tokenAFlag, pool.tokenBFlag]).toEqual([1, 0]);

    const mintInfo = await account(chain, chain.mints.synt);
    expect(mintInfo.owner.toBase58()).toBe(PROGRAM_IDS.token2022);
    const mint = unpackMint(pk(chain.mints.synt), mintInfo, pk(PROGRAM_IDS.token2022));
    const config = getTransferFeeConfig(mint);
    expect(config?.newerTransferFee.transferFeeBasisPoints).toBe(SYNTHETIC.transferFeeBps);
    expect(config?.olderTransferFee.transferFeeBasisPoints).toBe(SYNTHETIC.transferFeeBps);

    const vault = unpackAccount(
      pool.tokenAVault,
      await account(chain, pool.tokenAVault.toBase58()),
      pk(PROGRAM_IDS.token2022),
    );
    expect(vault.mint.toBase58()).toBe(chain.mints.synt);
    expect(getTransferFeeAmount(vault)?.withheldAmount).toBe(BigInt(0));
  });
});

describe("chainFixture: Raydium", () => {
  it("round-trips the CLMM pool, position and tick arrays", async () => {
    const chain = chainFixture();
    const program = pk(PROGRAM_IDS.clmm);
    const poolKey = pk(chain.clmm.pool);
    const info = await account(chain, chain.clmm.pool);
    expect(info.owner.toBase58()).toBe(PROGRAM_IDS.clmm);
    expect(info.data.subarray(0, 8)).toEqual(anchorDiscriminator("PoolState"));
    const pool = PoolInfoLayout.decode(info.data);
    const mints = [chain.mints.wsol, chain.mints.synt].sort((a, b) =>
      Buffer.compare(pk(a).toBuffer(), pk(b).toBuffer()),
    );
    expect([pool.mintA.toBase58(), pool.mintB.toBase58()]).toEqual(mints);
    expect(pool.vaultA.toBase58()).toBe(
      getPdaPoolVaultId(program, poolKey, pool.mintA).publicKey.toBase58(),
    );
    expect(pool.vaultB.toBase58()).toBe(
      getPdaPoolVaultId(program, poolKey, pool.mintB).publicKey.toBase58(),
    );
    expect(pool.liquidity.toString()).toBe(SYNTHETIC.clmm.liquidity.toString());
    expect(pool.sqrtPriceX64.toString()).toBe(SYNTHETIC.clmm.sqrtPriceX64.toString());
    expect(pool.tickCurrent).toBe(0);
    expect(pool.tickSpacing).toBe(SYNTHETIC.clmm.tickSpacing);

    const positionInfo = await account(chain, chain.clmm.position);
    expect(positionInfo.data.subarray(0, 8)).toEqual(anchorDiscriminator("PersonalPositionState"));
    const position = PersonalPositionLayout.decode(positionInfo.data);
    expect(chain.clmm.position).toBe(
      getPdaPersonalPositionAddress(program, pk(chain.clmm.positionMint)).publicKey.toBase58(),
    );
    expect(position.poolId.toBase58()).toBe(chain.clmm.pool);
    expect(position.nftMint.toBase58()).toBe(chain.clmm.positionMint);
    expect([position.tickLower, position.tickUpper]).toEqual([
      SYNTHETIC.clmm.tickLower,
      SYNTHETIC.clmm.tickUpper,
    ]);
    expect(position.liquidity.toString()).toBe(SYNTHETIC.clmm.liquidity.toString());
    expect(position.tokenFeesOwedA.toString()).toBe(SYNTHETIC.clmm.feesOwedA.toString());

    expect(chain.clmm.tickArrays).toEqual(
      [SYNTHETIC.clmm.tickLower, SYNTHETIC.clmm.tickUpper].map((start) =>
        getPdaTickArrayAddress(program, poolKey, start).publicKey.toBase58(),
      ),
    );
    for (const [i, address] of chain.clmm.tickArrays.entries()) {
      const arrayInfo = await account(chain, address);
      expect(arrayInfo.data.subarray(0, 8)).toEqual(anchorDiscriminator("TickArrayState"));
      const array = TickArrayLayout.decode(arrayInfo.data);
      const tick = i === 0 ? SYNTHETIC.clmm.tickLower : SYNTHETIC.clmm.tickUpper;
      expect(array.poolId.toBase58()).toBe(chain.clmm.pool);
      expect(array.startTickIndex).toBe(tick);
      expect(array.ticks[0].tick).toBe(tick);
      expect(array.ticks[0].liquidityGross.toString()).toBe(SYNTHETIC.clmm.liquidity.toString());
    }

    // The NFT sits in a token account that is not the owner's ATA.
    const nftProgram = pk(PROGRAM_IDS.token2022);
    const nft = unpackAccount(
      pk(chain.clmm.positionNftAccount),
      await account(chain, chain.clmm.positionNftAccount),
      nftProgram,
    );
    expect(nft.owner.toBase58()).toBe(chain.owner.publicKey.toBase58());
    expect(nft.amount).toBe(BigInt(1));
    expect(chain.clmm.positionNftAccount).not.toBe(
      getAssociatedTokenAddressSync(
        pk(chain.clmm.positionMint),
        chain.owner.publicKey,
        false,
        nftProgram,
      ).toBase58(),
    );
  });

  it("round-trips the CPMM pool with live reserves net of protocol, fund and creator fees", async () => {
    const chain = chainFixture();
    const info = await account(chain, chain.cpmm.pool);
    expect(info.owner.toBase58()).toBe(PROGRAM_IDS.cpmm);
    expect(info.data.subarray(0, 8)).toEqual(anchorDiscriminator("PoolState"));
    const pool = CpmmPoolInfoLayout.decode(info.data);
    const keys = getCreatePoolKeys({
      programId: pk(PROGRAM_IDS.cpmm),
      configId: pool.configId,
      mintA: pool.mintA,
      mintB: pool.mintB,
    });
    expect(keys.poolId.toBase58()).toBe(chain.cpmm.pool);
    expect(pool.mintLp.toBase58()).toBe(chain.cpmm.lpMint);
    expect(keys.lpMint.toBase58()).toBe(chain.cpmm.lpMint);
    expect([pool.vaultA, pool.vaultB].map(String)).toEqual([keys.vaultA, keys.vaultB].map(String));
    expect([pool.mintA, pool.mintB].map(String).sort()).toEqual(
      [chain.mints.wsol, chain.mints.synb].sort(),
    );
    expect(pool.mintProgramA.toBase58()).toBe(PROGRAM_IDS.token);
    expect(pool.lpAmount.toString()).toBe(SYNTHETIC.cpmm.lpSupply.toString());

    const lpMint = unpackMint(pool.mintLp, await account(chain, chain.cpmm.lpMint));
    expect(lpMint.supply.toString()).toBe(SYNTHETIC.cpmm.lpSupply.toString());
    const reserves = await Promise.all(
      [
        [pool.vaultA, pool.protocolFeesMintA, pool.fundFeesMintA, pool.creatorFeesMintA],
        [pool.vaultB, pool.protocolFeesMintB, pool.fundFeesMintB, pool.creatorFeesMintB],
      ].map(async ([vault, ...fees]) => {
        const token = unpackAccount(vault as PublicKey, await account(chain, String(vault)));
        return (fees as BN[]).reduce((sum, fee) => sum.sub(fee), new BN(token.amount.toString()));
      }),
    );
    const byMint = Object.fromEntries(
      [pool.mintA, pool.mintB].map((mint, i) => [mint.toBase58(), reserves[i].toString()]),
    );
    expect(byMint[chain.mints.wsol]).toBe(SYNTHETIC.cpmm.reserveWsol.toString());
    expect(byMint[chain.mints.synb]).toBe(SYNTHETIC.cpmm.reserveSynb.toString());
  });

  it("round-trips the AMM v4 pool and its OpenBook market", async () => {
    const chain = chainFixture();
    const info = await account(chain, chain.ammV4.pool);
    expect(info.owner.toBase58()).toBe(PROGRAM_IDS.ammV4);
    const amm = liquidityStateV4Layout.decode(info.data);
    const keys = getAssociatedPoolKeys({
      version: 4,
      marketVersion: 3,
      marketId: pk(chain.ammV4.market),
      baseMint: pk(chain.mints.sync),
      quoteMint: pk(chain.mints.wsol),
      baseDecimals: 6,
      quoteDecimals: 9,
      programId: pk(PROGRAM_IDS.ammV4),
      marketProgramId: pk(PROGRAM_IDS.openBook),
    });
    expect(keys.id.toBase58()).toBe(chain.ammV4.pool);
    expect(amm.lpMint.toBase58()).toBe(chain.ammV4.lpMint);
    expect(
      [amm.baseVault, amm.quoteVault, amm.lpMint, amm.openOrders, amm.targetOrders, amm.marketId].map(
        String,
      ),
    ).toEqual(
      [keys.baseVault, keys.quoteVault, keys.lpMint, keys.openOrders, keys.targetOrders, keys.marketId].map(
        String,
      ),
    );
    expect(amm.marketProgramId.toBase58()).toBe(PROGRAM_IDS.openBook);
    expect(amm.nonce.toNumber()).toBe(keys.nonce);
    expect(amm.lpReserve.toString()).toBe(SYNTHETIC.ammV4.lpSupply.toString());

    const marketInfo = await account(chain, chain.ammV4.market);
    expect(marketInfo.owner.toBase58()).toBe(PROGRAM_IDS.openBook);
    expect(marketInfo.data.subarray(0, 5).toString()).toBe("serum");
    expect(marketInfo.data.subarray(-7).toString()).toBe("padding");
    const market = MARKET_STATE_LAYOUT_V3.decode(marketInfo.data);
    expect(market.ownAddress.toBase58()).toBe(chain.ammV4.market);
    expect([market.baseMint, market.quoteMint].map(String)).toEqual([
      chain.mints.sync,
      chain.mints.wsol,
    ]);
    const signer = Market.getAssociatedAuthority({
      programId: pk(PROGRAM_IDS.openBook),
      marketId: pk(chain.ammV4.market),
    });
    expect(market.vaultSignerNonce.toNumber()).toBe(signer.nonce);
    expect(chain.ammV4.marketAuthority).toBe(signer.publicKey.toBase58());
    const marketVault = unpackAccount(market.baseVault, await account(chain, String(market.baseVault)));
    expect(marketVault.owner.toBase58()).toBe(signer.publicKey.toBase58());

    const lpMint = unpackMint(amm.lpMint, await account(chain, chain.ammV4.lpMint));
    expect(lpMint.supply.toString()).toBe(SYNTHETIC.ammV4.lpSupply.toString());
    const quoteVault = unpackAccount(amm.quoteVault, await account(chain, String(amm.quoteVault)));
    expect(quoteVault.isNative).toBe(true);
    expect(new BN(quoteVault.amount.toString()).sub(amm.quoteNeedTakePnl).toString()).toBe(
      SYNTHETIC.ammV4.reserveWsol.toString(),
    );
  });
});

describe("chainFixture: shape", () => {
  it("is deterministic and synthetic", () => {
    const a = chainFixture();
    const b = chainFixture();
    expect(a.owner.publicKey.toBase58()).toBe(b.owner.publicKey.toBase58());
    expect([...a.accounts.entries()]).toEqual([...b.accounts.entries()]);
    // A fresh map per call, so a test can delete or edit accounts.
    a.accounts.delete(a.dammV2.position);
    expect(b.accounts.has(b.dammV2.position)).toBe(true);
  });

  it("gives every account a known owner program and a rent-exempt balance", () => {
    const chain = chainFixture();
    const owners = new Set<string>([
      PROGRAM_IDS.system,
      PROGRAM_IDS.sysvar,
      PROGRAM_IDS.token,
      PROGRAM_IDS.token2022,
      PROGRAM_IDS.cpAmm,
      PROGRAM_IDS.clmm,
      PROGRAM_IDS.cpmm,
      PROGRAM_IDS.ammV4,
      PROGRAM_IDS.openBook,
    ]);
    for (const [address, info] of chain.accounts) {
      expect(owners.has(info.owner), address).toBe(true);
      const rent = (info.data.length + 128) * 6_960;
      expect(info.lamports, address).toBeGreaterThanOrEqual(rent);
    }
    expect(chain.accounts.get(chain.owner.publicKey.toBase58())?.owner).toBe(PROGRAM_IDS.system);
  });

  it("unwraps cleanly: wSOL token accounts are native with rent held back", () => {
    const chain = chainFixture();
    let wsolAccounts = 0;
    for (const [address, info] of chain.accounts) {
      if (info.owner !== PROGRAM_IDS.token || info.data.length !== 165) continue;
      const token = unpackAccount(pk(address), { ...info, owner: pk(info.owner), executable: false });
      if (!token.mint.equals(pk(chain.mints.wsol))) continue;
      wsolAccounts++;
      expect(token.isNative).toBe(true);
      expect(BigInt(info.lamports)).toBe(token.amount + (token.rentExemptReserve ?? BigInt(0)));
    }
    expect(wsolAccounts).toBeGreaterThanOrEqual(4);
  });
});

describe("mockActionRpc", () => {
  const memo = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  function transaction(signer: Keypair): VersionedTransaction {
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(9)),
      instructions: [new TransactionInstruction({ programId: memo, keys: [], data: Buffer.from("x") })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([signer]);
    return tx;
  }

  it("simulates, sends and confirms with fixed answers", async () => {
    const chain = chainFixture();
    const rpc = mockActionRpc(chain);
    const tx = transaction(chain.owner);
    const missing = Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58();

    const sim = await rpc.simulate(tx, [chain.dammV2.pool, missing]);
    expect(sim).toMatchObject({ err: null, unitsConsumed: 60_000 });
    const pool = chain.accounts.get(chain.dammV2.pool)!;
    expect(sim.accounts[0]).toEqual({ data: pool.data, lamports: pool.lamports, owner: pool.owner });
    expect(sim.accounts[1]).toBeNull();

    const raw = tx.serialize();
    const signature = await rpc.send(raw);
    expect(signature).toBe(bs58.encode(tx.signatures[0]));
    expect(rpc.sent).toEqual([raw]);
    await expect(rpc.statuses([signature])).resolves.toEqual([
      { slot: 1_000, confirmationStatus: "confirmed", err: null },
    ]);
    const latest = await rpc.latestBlockhash();
    expect(latest.lastValidBlockHeight).toBeGreaterThan(await rpc.blockHeight());
    expect((await rpc.priorityFees([chain.dammV2.pool])).length).toBeGreaterThan(0);
  });

  it("reports post-transaction states for watched accounts when given postStates", async () => {
    const chain = chainFixture();
    const wallet = chain.owner.publicKey;
    const ownerKey = wallet.toBase58();
    const synaAta = getAssociatedTokenAddressSync(pk(chain.mints.syna), wallet).toBase58();
    const wsolAta = getAssociatedTokenAddressSync(pk(chain.mints.wsol), wallet).toBase58();
    const before = chain.accounts.get(ownerKey)!;
    const ataBefore = unpackAccount(pk(synaAta), {
      ...chain.accounts.get(synaAta)!,
      owner: pk(PROGRAM_IDS.token),
      executable: false,
    });
    const claimed = BigInt(250_000_000);
    const rpc = mockActionRpc(chain, {
      postStates: postStatesFrom({
        // A claim paid SYNA, and a wSOL unwrap closed the temporary ATA and
        // paid its balance to the owner.
        [ownerKey]: { ...before, lamports: before.lamports + 125_000_000 },
        [synaAta]: {
          ...chain.accounts.get(synaAta)!,
          data: tokenAccountData({
            mint: pk(chain.mints.syna),
            owner: wallet,
            amount: new BN((ataBefore.amount + claimed).toString()),
          }),
        },
        [wsolAta]: null,
      }),
    });

    const sim = await rpc.simulate(transaction(chain.owner), [ownerKey, synaAta, wsolAta, chain.dammV2.pool]);
    expect(sim.accounts[0]).toMatchObject({
      lamports: before.lamports + 125_000_000,
      owner: PROGRAM_IDS.system,
    });
    const after = unpackAccount(pk(synaAta), {
      ...sim.accounts[1]!,
      owner: pk(sim.accounts[1]!.owner),
      executable: false,
    });
    expect(after.amount - ataBefore.amount).toBe(claimed);
    expect(sim.accounts[2]).toBeNull();
    expect(sim.accounts[3]?.data).toEqual(chain.accounts.get(chain.dammV2.pool)!.data);
    // The chain itself is untouched.
    expect(chain.accounts.get(ownerKey)!.lamports).toBe(before.lamports);
  });

  it("applies overrides and still records every send attempt", async () => {
    const chain = chainFixture();
    let attempts = 0;
    const rpc = mockActionRpc(chain, {
      simulate: async () => ({ err: { InstructionError: [0, "Custom"] }, logs: [], unitsConsumed: 1, accounts: [] }),
      send: async () => {
        attempts++;
        throw new Error("busy");
      },
    });
    const tx = transaction(chain.owner);
    expect((await rpc.simulate(tx)).err).not.toBeNull();
    await expect(rpc.send(tx.serialize())).rejects.toThrow("busy");
    expect(attempts).toBe(1);
    expect(rpc.sent).toHaveLength(1);
  });

  it("refuses what the pass-through refuses", async () => {
    const chain = chainFixture();
    const { connection } = mockActionRpc(chain);
    await expect(connection.getParsedAccountInfo(pk(chain.dammV2.pool))).rejects.toThrow(
      /Invalid params/,
    );
    await expect(
      connection.getTokenAccountsByOwner(chain.owner.publicKey, { mint: pk(chain.mints.syna) }),
    ).rejects.toThrow(/Method not allowed/);
  });
});
