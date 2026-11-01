// LIVE read-only mainnet proof for the Solana launchpad swap (simulateTransaction only; NOTHING is ever sent). Run with:
//   LIVE_SOL_SIM=1 [FINCH_SOLANA_RPC_URL=...] npx vitest run test/launchpad-solana-live.test.ts --testTimeout=120000
// The payer is a REAL funded mainnet address (SOL buy) / a real holder of the token (sell). It does not sign: sigVerify=false.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import * as L from "../src/launchpad-solana.js";
import { solRpc, resolveSolanaLaunch, quoteSolanaSwap } from "../src/tools/launchpad-solana.js";
import { assertSafeTx } from "../src/tools/solana.js";

const LIVE = process.env.LIVE_SOL_SIM === "1";
const MINT = "AJgGt1EGPzYdXRzVovtjgTW2qAbYGzEPHeBp727c8FJq";
const POOL = "ETzvYneJnVMoDkUU4NAfzV1jWHsrcS27Z5oc5sNNYop8";
// The production backend does not serve chain=solana on /launchpad/token until Worker A's routes are deployed: answer ONLY
// that one read with the documented shape; every Solana RPC call below is REAL mainnet.
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    if (String(url).includes("/launchpad/token?chain=solana")) {
      return new Response(JSON.stringify({ chain: "solana", token: MINT, name: "Test", symbol: "TST", source: "finch", poolId: POOL }), { status: 200 });
    }
    return real(url, init);
  });
});

async function simulate(tx: any, payer: string) {
  const r = await solRpc("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), {
    encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [payer] },
  }]);
  return r.value;
}

describe.skipIf(!LIVE)("live simulation of direct cp-amm swaps on the real Finch test token", () => {
  it("BUY (SOL -> token) simulates OK on mainnet", async () => {
    const li = await resolveSolanaLaunch(MINT);
    // any funded system account works as payer when signatures are not verified; take the largest-balance candidate we can read
    const payer = new PublicKey(process.env.LIVE_PAYER ?? "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS");
    const bal = BigInt((await solRpc("getBalance", [payer.toBase58()])).value);
    console.log(`[buy] payer ${payer.toBase58()} balance ${bal} lamports`);
    const amountIn = 10_000_000n;
    const qt = quoteSolanaSwap(li, "buy", amountIn, 100);
    const ixs = L.buildSwapInstructions({ wallet: payer, pool: li.pool, state: li.state, inputMint: L.WSOL_MINT, amountIn, minOut: qt.minOut, tokenAProgram: L.TOKEN_PROGRAM, tokenBProgram: L.TOKEN_PROGRAM });
    const tx = L.compileSwapTx(payer, "11111111111111111111111111111111", ixs);
    await assertSafeTx(tx, { wallet: payer, allowedPrograms: L.SOLANA_SWAP_PROGRAMS, maxLamportsOut: amountIn, allowedSolDestinations: [L.ataAddress(L.WSOL_MINT, payer, L.TOKEN_PROGRAM).toBase58()], lookupTables: [] });
    const v = await simulate(tx, payer.toBase58());
    console.log(`[buy] err=${JSON.stringify(v.err)} units=${v.unitsConsumed} quote out=${qt.outAmount} minOut=${qt.minOut} impact=${qt.priceImpactPct.toFixed(3)}%`);
    console.log((v.logs ?? []).slice(-8).join("\n"));
    const post = BigInt(v.accounts[0].lamports);
    console.log(`[buy] SOL change ${post - bal} lamports (fees+ATA rent+${amountIn} swap input)`);
    expect(v.err).toBeNull();
    // (the payer is a busy exchange wallet whose balance moves between RPC calls, so the SOL delta is informational only)
  });

  it("SELL (token -> SOL): the pool has never traded, so no wallet holds the token; structural simulation only", async () => {
    // The test pool is still at its opening price floor: nobody holds the token except the pool vault (verified via the pool's
    // transaction history: only the creation tx exists), so a sell quote itself is impossible ("price range violation") and a
    // successful sell simulation would need an account override (Solana RPC has none). What CAN be proven read-only: with the
    // launcher wallet (holds 0 tokens, ATA exists) the swap instruction is parsed by cp-amm and fails with PriceRangeViolation (6015), exactly what the local quote predicts.
    const li = await resolveSolanaLaunch(MINT);
    expect(() => quoteSolanaSwap(li, "sell", 1_000_000_000n, 100)).toThrow(/price range violation/);
    const payer = new PublicKey(process.env.LIVE_SELL_PAYER ?? "DKStJjdiA7hmVvhkWe26nmGAtRGF6CnMoyHvtbs16Wi6");
    const ixs = L.buildSwapInstructions({ wallet: payer, pool: li.pool, state: li.state, inputMint: new PublicKey(MINT), amountIn: 1_000_000_000n, minOut: 1n, tokenAProgram: L.TOKEN_PROGRAM, tokenBProgram: L.TOKEN_PROGRAM });
    const tx = L.compileSwapTx(payer, "11111111111111111111111111111111", ixs);
    await assertSafeTx(tx, { wallet: payer, allowedPrograms: L.SOLANA_SWAP_PROGRAMS, maxLamportsOut: 0n, allowedSolDestinations: [], lookupTables: [] });
    const v = await simulate(tx, payer.toBase58());
    console.log(`[sell] err=${JSON.stringify(v.err)}\n${(v.logs ?? []).slice(-8).join("\n")}`);
    expect(JSON.stringify(v.err)).toContain("6015"); // cp-amm PriceRangeViolation: the same refusal our local quote predicts
    expect((v.logs ?? []).join("\n")).toContain(L.METEORA_CP_AMM_PROGRAM.toBase58());
  });
});
