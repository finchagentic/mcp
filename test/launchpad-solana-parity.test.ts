// PARITY: the MCP's Solana swap builders vs the backend modules (sibling repo), byte for byte.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey, ComputeBudgetProgram, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import * as mine from "../src/launchpad-solana.js";
// backend source of truth
import * as beSwap from "../../finchagentic/convex/_meteoraSwapIx.js";
import * as beSpl from "../../finchagentic/convex/_splIx.js";
import { SWAP_PROGRAMS as beSwapPrograms } from "../../finchagentic/convex/_solanaTxGuard.js";

const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const b58 = (k: { toBase58(): string }) => k.toBase58();
const dump = (ix: TransactionInstruction) => ({
  program: ix.programId.toBase58(), data: Buffer.from(ix.data).toString("hex"),
  keys: ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
});
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/finch-pool-account.json"), "utf8"));
const poolBuf = (): Buffer => Buffer.from(fixture.data, "base64");

describe("constants", () => {
  it("program ids and allowlist match the backend", () => {
    expect(b58(mine.METEORA_CP_AMM_PROGRAM)).toBe(b58(beSwap.METEORA_CP_AMM_PROGRAM));
    expect(b58(mine.METEORA_POOL_AUTHORITY)).toBe(b58(beSwap.METEORA_POOL_AUTHORITY));
    expect(b58(mine.METEORA_EVENT_AUTHORITY)).toBe(b58(beSwap.METEORA_EVENT_AUTHORITY));
    expect(b58(mine.WSOL_MINT)).toBe(b58(beSwap.WSOL_MINT));
    expect(new Set(mine.SOLANA_SWAP_PROGRAMS)).toEqual(new Set(beSwapPrograms));
  });
  it("SWAP_RESERVE and priority fee equal the backend's (source check)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../finchagentic/convex/meteoraDirectSwap.ts"), "utf8");
    expect(src).toContain("const SWAP_RESERVE = 10_000_000n;");
    expect(src).toContain("microLamports: 50_000");
    expect(mine.SWAP_RESERVE).toBe(10_000_000n);
    expect(mine.PRIORITY_MICROLAMPORTS).toBe(50_000);
  });
});

describe("SPL instruction builders: identical bytes", () => {
  it("ata address, create-idempotent, close, sync-native", () => {
    const owner = pk(1), mint = pk(2), ata = pk(3), prog = new PublicKey(beSpl.TOKEN_PROGRAM.toBase58());
    expect(b58(mine.ataAddress(mint, owner, prog))).toBe(b58(beSpl.ataAddress(mint, owner, prog)));
    expect(dump(mine.createAtaIdempotentIx(owner, ata, owner, mint, prog))).toEqual(dump(beSpl.createAtaIdempotentIx(owner, ata, owner, mint, prog)));
    expect(dump(mine.closeAccountIx(ata, owner, owner, prog))).toEqual(dump(beSpl.closeAccountIx(ata, owner, owner, prog)));
    expect(dump(mine.syncNativeIx(ata))).toEqual(dump(beSpl.syncNativeIx(ata)));
  });
});

describe("cp-amm swap instruction: identical bytes", () => {
  it("encodeSwapData over edge amounts", () => {
    for (const [a, m] of [[1n, 1n], [10_000_000n, 0n], [2n ** 64n - 1n, 2n ** 64n - 1n], [123456789012345n, 98765n]] as const) {
      expect(mine.encodeSwapData(a, m).toString("hex")).toBe(beSwap.encodeSwapData(a, m).toString("hex"));
    }
    expect(() => mine.encodeSwapData(2n ** 64n, 0n)).toThrow();
    expect(() => mine.encodeSwapData(-1n, 0n)).toThrow();
  });
  it("createSwapIx keys/flags/data", () => {
    const args = {
      payer: pk(10), pool: pk(11), inputTokenAccount: pk(12), outputTokenAccount: pk(13), tokenAVault: pk(14), tokenBVault: pk(15),
      tokenAMint: pk(16), tokenBMint: pk(17), tokenAProgram: pk(18), tokenBProgram: pk(19), amountIn: 777n, minimumAmountOut: 555n,
    };
    expect(dump(mine.createSwapIx(args))).toEqual(dump(beSwap.createSwapIx(args)));
  });
});

describe("pool decode + quote: identical output", () => {
  const dumpState = (s: any) => JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  it("decodeSwapPool on the REAL mainnet pool account", () => {
    expect(dumpState(mine.decodeSwapPool(poolBuf()))).toEqual(dumpState(beSwap.decodeSwapPool(poolBuf())));
  });
  it("quoteExactIn over many amounts / slippages / both directions / mutated pool states", () => {
    let n = 0;
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let v = 0; v < 12; v++) {
      const buf = poolBuf();
      if (v > 0) {
        // emulate a pool that has traded: raise sqrtPrice above sqrtMin (u128 @456) and vary the fee (u64 @8) / liquidity
        const lo = buf.readBigUInt64LE(456), hi = buf.readBigUInt64LE(464);
        buf.writeBigUInt64LE(lo + BigInt(Math.floor(rnd() * 1e12)), 456); void hi;
        buf.writeBigUInt64LE(BigInt(Math.floor(rnd() * 5e7)), 8);
        buf.writeUInt8(v % 2, 486);
      }
      const a = mine.decodeSwapPool(buf), b = beSwap.decodeSwapPool(buf);
      const tok = a.tokenAMint.equals(mine.WSOL_MINT) ? a.tokenBMint : a.tokenAMint;
      for (const inMint of [mine.WSOL_MINT, tok]) {
        for (const amt of [1n, 1000n, 10_000_000n, 123_456_789n, 500_000_000n, 3_000_000_000n, 10n ** 12n]) {
          for (const slip of [1, 100, 500, 10_000]) {
            const run = (f: () => any) => { try { return dumpState(f()); } catch (e: any) { return { err: String(e.message) }; } };
            const m1 = run(() => mine.quoteExactIn(a, inMint, amt, slip, 9, 9, 1_700_000_000n));
            const m2 = run(() => beSwap.quoteExactIn(b, new PublicKey(inMint.toBase58()), amt, slip, 9, 9, 1_700_000_000n));
            expect(m1, `v=${v} in=${inMint.toBase58().slice(0, 4)} amt=${amt} slip=${slip}`).toEqual(m2);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(600);
  });
});

describe("full swap instruction list: identical to the backend flow", () => {
  /** Reference = swapMeteoraDirect's instruction sequence, written with the BACKEND's own builders (meteoraDirectSwap.ts lines 149-175). */
  function reference(wallet: PublicKey, pool: PublicKey, state: ReturnType<typeof beSwap.decodeSwapPool>, inputMint: PublicKey, amount: bigint, minOut: bigint) {
    const TP = beSpl.TOKEN_PROGRAM;
    const outputMint = inputMint.equals(state.tokenAMint) ? state.tokenBMint : state.tokenAMint;
    const inIsSol = inputMint.toBase58() === beSwap.WSOL_MINT.toBase58();
    const outIsSol = outputMint.toBase58() === beSwap.WSOL_MINT.toBase58();
    const inputAta = beSpl.ataAddress(inputMint, wallet, TP), outputAta = beSpl.ataAddress(outputMint, wallet, TP);
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
    ixs.push(beSpl.createAtaIdempotentIx(wallet, inputAta, wallet, inputMint, TP));
    ixs.push(beSpl.createAtaIdempotentIx(wallet, outputAta, wallet, outputMint, TP));
    if (inIsSol) { ixs.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: inputAta, lamports: amount })); ixs.push(beSpl.syncNativeIx(inputAta)); }
    ixs.push(beSwap.createSwapIx({
      payer: wallet, pool, inputTokenAccount: inputAta, outputTokenAccount: outputAta,
      tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint,
      tokenAProgram: TP, tokenBProgram: TP, amountIn: amount, minimumAmountOut: minOut,
    }));
    if (inIsSol) ixs.push(beSpl.closeAccountIx(inputAta, wallet, wallet, TP));
    if (outIsSol) ixs.push(beSpl.closeAccountIx(outputAta, wallet, wallet, TP));
    return ixs;
  }
  const sameIxs = (x: TransactionInstruction[], y: TransactionInstruction[]) => expect(x.map(dump)).toEqual(y.map(dump));

  for (const side of ["buy", "sell"] as const) {
    it(`${side} on the real pool`, () => {
      const wallet = Keypair.generate().publicKey;
      const pool = new PublicKey("ETzvYneJnVMoDkUU4NAfzV1jWHsrcS27Z5oc5sNNYop8");
      const state = mine.decodeSwapPool(poolBuf());
      const bstate = beSwap.decodeSwapPool(poolBuf());
      const tok = state.tokenAMint.equals(mine.WSOL_MINT) ? state.tokenBMint : state.tokenAMint;
      const inputMint = side === "buy" ? mine.WSOL_MINT : tok;
      const mineIxs = mine.buildSwapInstructions({ wallet, pool, state, inputMint, amountIn: 12_345_678n, minOut: 7_654_321n, tokenAProgram: mine.TOKEN_PROGRAM, tokenBProgram: mine.TOKEN_PROGRAM });
      sameIxs(mineIxs, reference(wallet, pool, bstate, new PublicKey(inputMint.toBase58()), 12_345_678n, 7_654_321n));
      expect(mineIxs.length).toBe(side === "buy" ? 7 : 5); // [fee, ata, ata, transfer, sync, swap, close] / [fee, ata, ata, swap, close]
    });
  }
  it("a mint that is not in the pool is refused", () => {
    const state = mine.decodeSwapPool(poolBuf());
    expect(() => mine.buildSwapInstructions({ wallet: pk(1), pool: pk(2), state, inputMint: pk(9), amountIn: 1n, minOut: 1n, tokenAProgram: mine.TOKEN_PROGRAM, tokenBProgram: mine.TOKEN_PROGRAM })).toThrow(/not part of this pool/);
  });
});
