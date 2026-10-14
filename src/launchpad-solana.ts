// Solana side of the Finch launchpad: DIRECT Meteora DAMM v2 (cp-amm) swap builders + quote math.
//
// This is a byte-for-byte port of the backend builders (finchagentic/convex/_meteoraSwapIx.ts, _splIx.ts and the
// instruction flow of meteoraDirectSwap.ts#swapMeteoraDirect). test/launchpad-solana-parity.test.ts imports the
// backend modules by relative path and asserts IDENTICAL instruction bytes / keys / quote output for the same
// inputs. Do not "improve" anything here without changing the backend in lockstep.
//
// Why direct: Jupiter refuses fresh single-sided Finch pools (100% impact on buy, NO_ROUTES on sell) although the
// pool is fully liquid, so Finch trades straight against its own cp-amm pool.

import {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";

export const METEORA_CP_AMM_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const METEORA_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const METEORA_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Program allowlist for assertSafeTx: cp-amm + token programs + ATA + system + compute budget (== backend SWAP_PROGRAMS). */
export const SOLANA_SWAP_PROGRAMS: string[] = [
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  TOKEN_PROGRAM.toBase58(),
  TOKEN_2022_PROGRAM_ID,
  ATA_PROGRAM.toBase58(),
  METEORA_CP_AMM_PROGRAM.toBase58(),
];

export const SWAP_RESERVE = 10_000_000n;          // 0.01 SOL: fees, rent and wSOL account churn (== backend SWAP_RESERVE)
export const PRIORITY_MICROLAMPORTS = 50_000;     // == backend setComputeUnitPrice
/** Spec: price impact above 5% is refused (the backend allows 10%; the MCP is stricter). */
export const MAX_PRICE_IMPACT_PCT = 5;

// ── SPL instruction builders (== convex/_splIx.ts) ───────────────────────────
export function ataAddress(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/** AssociatedTokenAccount::CreateIdempotent (instruction byte 1). */
export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** Token::CloseAccount (instruction 9). */
export function closeAccountIx(account: PublicKey, destination: PublicKey, owner: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

/** Token::SyncNative (instruction 17). */
export function syncNativeIx(wsolAccount: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: wsolAccount, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });
}

// ── cp-amm swap instruction (== convex/_meteoraSwapIx.ts) ────────────────────
const SWAP_DISCRIMINATOR = Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]); // sha256("global:swap")[:8]

function u64le(x: bigint): Buffer {
  if (x < 0n || x > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const b = Buffer.alloc(8); b.writeBigUInt64LE(x, 0); return b;
}
export function encodeSwapData(amountIn: bigint, minimumAmountOut: bigint): Buffer {
  return Buffer.concat([SWAP_DISCRIMINATOR, u64le(amountIn), u64le(minimumAmountOut)]);
}

export interface SwapIxArgs {
  payer: PublicKey; pool: PublicKey;
  inputTokenAccount: PublicKey; outputTokenAccount: PublicKey;
  tokenAVault: PublicKey; tokenBVault: PublicKey; tokenAMint: PublicKey; tokenBMint: PublicKey;
  tokenAProgram: PublicKey; tokenBProgram: PublicKey;
  amountIn: bigint; minimumAmountOut: bigint;
}
export function createSwapIx(a: SwapIxArgs): TransactionInstruction {
  const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: METEORA_CP_AMM_PROGRAM,
    keys: [
      meta(METEORA_POOL_AUTHORITY, false, false),
      meta(a.pool, false, true),
      meta(a.inputTokenAccount, false, true),
      meta(a.outputTokenAccount, false, true),
      meta(a.tokenAVault, false, true),
      meta(a.tokenBVault, false, true),
      meta(a.tokenAMint, false, false),
      meta(a.tokenBMint, false, false),
      meta(a.payer, true, false),
      meta(a.tokenAProgram, false, false),
      meta(a.tokenBProgram, false, false),
      meta(METEORA_CP_AMM_PROGRAM, false, false),
      meta(METEORA_EVENT_AUTHORITY, false, false),
      meta(METEORA_CP_AMM_PROGRAM, false, false),
    ],
    data: encodeSwapData(a.amountIn, a.minimumAmountOut),
  });
}

// ── Pool decode + ExactIn quote (== convex/_meteoraSwapIx.ts) ────────────────
export const POOL_ACCOUNT_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const POOL_SWAP_OFF = {
  baseFeeData: 8, dynamicFeeInitialized: 56,
  tokenAMint: 168, tokenBMint: 200, tokenAVault: 232, tokenBVault: 264,
  liquidity: 360, sqrtMinPrice: 424, sqrtMaxPrice: 440, sqrtPrice: 456,
  activationPoint: 472, activationType: 480, collectFeeMode: 484, feeVersion: 486,
} as const;
export const MIN_POOL_ACCOUNT_BYTES = 488;

function readU128LE(data: Buffer, o: number): bigint {
  return (data.readBigUInt64LE(o + 8) << 64n) | data.readBigUInt64LE(o);
}

export interface SwapPoolState {
  tokenAMint: PublicKey; tokenBMint: PublicKey; tokenAVault: PublicKey; tokenBVault: PublicKey;
  liquidity: bigint; sqrtMinPrice: bigint; sqrtMaxPrice: bigint; sqrtPrice: bigint;
  activationPoint: bigint; activationType: number; collectFeeMode: number; feeVersion: number;
  dynamicFeeInitialized: number;
  cliffFeeNumerator: bigint; baseFeeMode: number; numberOfPeriod: number; periodFrequency: bigint; reductionFactor: bigint;
}

export function decodeSwapPool(data: Buffer): SwapPoolState {
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  const bf = POOL_SWAP_OFF.baseFeeData;
  return {
    tokenAMint: pk(POOL_SWAP_OFF.tokenAMint), tokenBMint: pk(POOL_SWAP_OFF.tokenBMint),
    tokenAVault: pk(POOL_SWAP_OFF.tokenAVault), tokenBVault: pk(POOL_SWAP_OFF.tokenBVault),
    liquidity: readU128LE(data, POOL_SWAP_OFF.liquidity),
    sqrtMinPrice: readU128LE(data, POOL_SWAP_OFF.sqrtMinPrice),
    sqrtMaxPrice: readU128LE(data, POOL_SWAP_OFF.sqrtMaxPrice),
    sqrtPrice: readU128LE(data, POOL_SWAP_OFF.sqrtPrice),
    activationPoint: data.readBigUInt64LE(POOL_SWAP_OFF.activationPoint),
    activationType: data.readUInt8(POOL_SWAP_OFF.activationType),
    collectFeeMode: data.readUInt8(POOL_SWAP_OFF.collectFeeMode),
    feeVersion: data.readUInt8(POOL_SWAP_OFF.feeVersion),
    dynamicFeeInitialized: data.readUInt8(POOL_SWAP_OFF.dynamicFeeInitialized),
    cliffFeeNumerator: data.readBigUInt64LE(bf + 0),
    baseFeeMode: data.readUInt8(bf + 8),
    numberOfPeriod: data.readUInt16LE(bf + 14),
    periodFrequency: data.readBigUInt64LE(bf + 16),
    reductionFactor: data.readBigUInt64LE(bf + 24),
  };
}

const FEE_DENOMINATOR = 1_000_000_000n;
const SCALE_SHIFT = 128n;
const MAX_FEE_NUMERATOR_V0 = 500_000_000n;
const MAX_FEE_NUMERATOR_V1 = 990_000_000n;

function mulDiv(x: bigint, y: bigint, denominator: bigint, roundUp: boolean): bigint {
  const prod = x * y;
  const div = prod / denominator;
  if (roundUp && prod % denominator !== 0n) return div + 1n;
  return div;
}
function getMaxFeeNumerator(feeVersion: number): bigint {
  if (feeVersion === 0) return MAX_FEE_NUMERATOR_V0;
  if (feeVersion === 1) return MAX_FEE_NUMERATOR_V1;
  throw new Error("invalid pool fee version");
}
function baseFeeNumerator(p: SwapPoolState, currentPoint: bigint): bigint {
  if (p.periodFrequency === 0n) return p.cliffFeeNumerator;
  let period: bigint;
  if (currentPoint < p.activationPoint) period = BigInt(p.numberOfPeriod);
  else {
    period = (currentPoint - p.activationPoint) / p.periodFrequency;
    if (period > BigInt(p.numberOfPeriod)) period = BigInt(p.numberOfPeriod);
  }
  if (p.baseFeeMode === 0) return p.cliffFeeNumerator - period * p.reductionFactor;
  if (period === 0n) return p.cliffFeeNumerator;
  const BP = 10_000n;
  let num = p.cliffFeeNumerator;
  const factorNum = BP - p.reductionFactor;
  for (let i = 0n; i < period; i++) num = (num * factorNum) / BP;
  return num;
}
function totalFeeNumerator(p: SwapPoolState, currentPoint: bigint): bigint {
  const total = baseFeeNumerator(p, currentPoint);
  const max = getMaxFeeNumerator(p.feeVersion);
  return total < max ? total : max;
}
function nextSqrtPriceFromInputAtoB(sqrtPrice: bigint, liquidity: bigint, amountIn: bigint): bigint {
  if (amountIn === 0n) return sqrtPrice;
  const denominator = liquidity + amountIn * sqrtPrice;
  return mulDiv(liquidity, sqrtPrice, denominator, true);
}
function nextSqrtPriceFromInputBtoA(sqrtPrice: bigint, liquidity: bigint, amountIn: bigint): bigint {
  const quotient = (amountIn << SCALE_SHIFT) / liquidity;
  return sqrtPrice + quotient;
}
function amountBFromDelta(lower: bigint, upper: bigint, liquidity: bigint): bigint {
  return (liquidity * (upper - lower)) >> SCALE_SHIFT;
}
function amountAFromDelta(lower: bigint, upper: bigint, liquidity: bigint): bigint {
  return mulDiv(liquidity, upper - lower, lower * upper, false);
}

export interface MeteoraQuote { grossOut: bigint; outAmount: bigint; minOut: bigint; priceImpactPct: number; nextSqrtPrice: bigint }

export function quoteExactIn(
  p: SwapPoolState, inputMint: PublicKey, amountIn: bigint, slippageBps: number,
  tokenADecimal: number, tokenBDecimal: number, currentPoint: bigint,
): MeteoraQuote {
  if (amountIn <= 0n) throw new Error("amountIn must be > 0");
  const aToB = p.tokenAMint.equals(inputMint);
  const feeNum = totalFeeNumerator(p, currentPoint);
  let grossOut: bigint, nextSqrtPrice: bigint;
  if (aToB) {
    nextSqrtPrice = nextSqrtPriceFromInputAtoB(p.sqrtPrice, p.liquidity, amountIn);
    if (nextSqrtPrice < p.sqrtMinPrice) throw new Error("price range violation (A->B)");
    grossOut = amountBFromDelta(nextSqrtPrice, p.sqrtPrice, p.liquidity);
  } else {
    nextSqrtPrice = nextSqrtPriceFromInputBtoA(p.sqrtPrice, p.liquidity, amountIn);
    if (nextSqrtPrice > p.sqrtMaxPrice) throw new Error("price range violation (B->A)");
    grossOut = amountAFromDelta(p.sqrtPrice, nextSqrtPrice, p.liquidity);
  }
  const tradingFee = mulDiv(grossOut, feeNum, FEE_DENOMINATOR, true);
  const outAmount = grossOut - tradingFee;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  const minOut = bps > 0n ? (outAmount * (10_000n - bps)) / 10_000n : outAmount;
  const priceImpactPct = computePriceImpact(amountIn, outAmount, p.sqrtPrice, aToB, tokenADecimal, tokenBDecimal);
  return { grossOut, outAmount, minOut, priceImpactPct, nextSqrtPrice };
}

function computePriceImpact(amountIn: bigint, amountOut: bigint, sqrtPrice: bigint, aToB: boolean, decA: number, decB: number): number {
  if (amountIn === 0n || amountOut === 0n) return 0;
  const sp = Number(sqrtPrice) / 2 ** 64;
  const spotPrice = sp * sp * 10 ** (decA - decB);
  const execRaw = (Number(amountIn) / Number(amountOut)) * 10 ** (aToB ? decB - decA : decA - decB);
  const actualExec = aToB ? 1 / execRaw : execRaw;
  if (spotPrice === 0) return 0;
  return (Math.abs(actualExec - spotPrice) / spotPrice) * 100;
}

// ── Swap transaction (== the instruction flow of swapMeteoraDirect) ──────────
export interface SwapPlan {
  wallet: PublicKey; pool: PublicKey; state: SwapPoolState;
  inputMint: PublicKey; amountIn: bigint; minOut: bigint;
  tokenAProgram: PublicKey; tokenBProgram: PublicKey;
}

/** The exact instruction list the backend builds: [priority fee, ATA(in), ATA(out), (wrap: transfer + syncNative), swap, (close WSOL ATA)]. */
export function buildSwapInstructions(p: SwapPlan): TransactionInstruction[] {
  const { state, wallet, inputMint } = p;
  if (!inputMint.equals(state.tokenAMint) && !inputMint.equals(state.tokenBMint)) throw new Error("That token is not part of this pool.");
  const inIsSol = inputMint.equals(WSOL_MINT);
  const outputMint = inputMint.equals(state.tokenAMint) ? state.tokenBMint : state.tokenAMint;
  const outIsSol = outputMint.equals(WSOL_MINT);
  const inputProgram = inputMint.equals(state.tokenAMint) ? p.tokenAProgram : p.tokenBProgram;
  const outputProgram = outputMint.equals(state.tokenAMint) ? p.tokenAProgram : p.tokenBProgram;
  const inputAta = ataAddress(inputMint, wallet, inputProgram);
  const outputAta = ataAddress(outputMint, wallet, outputProgram);

  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS })];
  ixs.push(createAtaIdempotentIx(wallet, inputAta, wallet, inputMint, inputProgram));
  ixs.push(createAtaIdempotentIx(wallet, outputAta, wallet, outputMint, outputProgram));
  if (inIsSol) {
    ixs.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: inputAta, lamports: p.amountIn }));
    ixs.push(syncNativeIx(inputAta));
  }
  ixs.push(createSwapIx({
    payer: wallet, pool: p.pool, inputTokenAccount: inputAta, outputTokenAccount: outputAta,
    tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint,
    tokenAProgram: p.tokenAProgram, tokenBProgram: p.tokenBProgram, amountIn: p.amountIn, minimumAmountOut: p.minOut,
  }));
  if (inIsSol) ixs.push(closeAccountIx(inputAta, wallet, wallet, TOKEN_PROGRAM));
  if (outIsSol) ixs.push(closeAccountIx(outputAta, wallet, wallet, TOKEN_PROGRAM));
  return ixs;
}

export function compileSwapTx(wallet: PublicKey, blockhash: string, ixs: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
}

/**
 * The compiled tx must contain EXACTLY the instructions we built (same programs, account keys and data, in order).
 * Defense in depth on top of assertSafeTx: nothing can be added between building and signing.
 */
export function assertTxMatchesPlan(tx: VersionedTransaction, ixs: TransactionInstruction[]): void {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  const ci = msg.compiledInstructions;
  if ((msg.addressTableLookups?.length ?? 0) !== 0) throw new Error("Refusing to sign: unexpected address lookup tables.");
  if (ci.length !== ixs.length) throw new Error(`Refusing to sign: transaction has ${ci.length} instructions, expected ${ixs.length}.`);
  ci.forEach((c, i) => {
    const want = ixs[i];
    if (!keys[c.programIdIndex].equals(want.programId)) throw new Error(`Refusing to sign: instruction ${i} targets the wrong program.`);
    if (Buffer.compare(Buffer.from(c.data), want.data) !== 0) throw new Error(`Refusing to sign: instruction ${i} data differs from the plan.`);
    if (c.accountKeyIndexes.length !== want.keys.length) throw new Error(`Refusing to sign: instruction ${i} account count differs from the plan.`);
    c.accountKeyIndexes.forEach((k, j) => {
      if (!keys[k].equals(want.keys[j].pubkey)) throw new Error(`Refusing to sign: instruction ${i} account ${j} differs from the plan.`);
    });
  });
}
