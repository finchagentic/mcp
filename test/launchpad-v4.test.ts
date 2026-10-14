// Pure-helper tests: slippage / min-out math, price impact, drift, pool key, calldata layout, and
// BYTE PARITY with the production backend encoders (finchagentic convex/_walletRhDex.ts executed directly;
// convex/walletActions.ts buildV4ExactInputParams extracted from source and executed).
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  CHAINS, slippagePctToBps, minOutFromQuote, priceImpactBps, driftExceeded, finchPoolKey, poolIdOf, buildSwap,
  encodeExactInputParams, swapQuoteId, MAX_SLIPPAGE_BPS, USDG_ROBINHOOD, ETH_ADDR,
} from "../src/launchpad-v4.js";

const BACKEND = path.resolve(__dirname, "../../finchagentic/convex");
const haveBackend = fs.existsSync(path.join(BACKEND, "_walletRhDex.ts")) && fs.existsSync(path.join(BACKEND, "walletActions.ts"));
const coder = ethers.AbiCoder.defaultAbiCoder();
const TOKEN = "0x1688E6cE60FE0C7743ff07ce0b578942Dd4F1723";
const WHO = "0x00000000000000000000000000000000DeaDBeef";
afterEach(() => { vi.useRealTimers(); });

describe("slippage / minOut math", () => {
  it("defaults to 1% and accepts up to the 5% hard ceiling", () => {
    expect(slippagePctToBps(undefined)).toBe(100);
    expect(slippagePctToBps(0.5)).toBe(50);
    expect(slippagePctToBps("2.5")).toBe(250);
    expect(slippagePctToBps(5)).toBe(MAX_SLIPPAGE_BPS);
  });
  it("rejects above 5%, zero, negative, junk", () => {
    for (const v of [5.01, 6, 50, 0, -1, "abc", NaN, Infinity]) expect(() => slippagePctToBps(v as any)).toThrow();
  });
  it("minOut = quote*(1-slippage), rounded DOWN, never above quote", () => {
    expect(minOutFromQuote(1_000_000n, 100)).toBe(990_000n);
    expect(minOutFromQuote(1_000_000n, 500)).toBe(950_000n);
    expect(minOutFromQuote(1_000_000n, 0)).toBe(1_000_000n);
    expect(minOutFromQuote(123_456_789n, 100)).toBe(122_222_221n); // 123456789*0.99 = 122222221.11 -> floor
    expect(minOutFromQuote(1n, 100)).toBe(0n);                       // floor, caller must reject zero
    expect(minOutFromQuote(99n, 1)).toBe(98n);                       // 99*0.9999 = 98.99 -> 98
    const big = 98_732_930_619_741_087_692_340n;
    expect(minOutFromQuote(big, 100)).toBe((big * 9900n) / 10000n);
    expect(minOutFromQuote(big, 100) < big).toBe(true);
  });
  it("minOut rejects out-of-range slippage", () => {
    expect(() => minOutFromQuote(100n, 501)).toThrow();
    expect(() => minOutFromQuote(100n, -1)).toThrow();
    expect(() => minOutFromQuote(-1n, 100)).toThrow();
  });
  it("drift: >0.5% worse min-out is exceeded, exactly 0.5% is not, better is fine", () => {
    expect(driftExceeded(1_000_000n, 995_000n)).toBe(false);
    expect(driftExceeded(1_000_000n, 994_999n)).toBe(true);
    expect(driftExceeded(1_000_000n, 2_000_000n)).toBe(false);
    expect(driftExceeded(1_000_000n, 900_000n)).toBe(true);
  });
  it("price impact in bps vs spot, fee removed, rounded up", () => {
    // sqrtP = 2^96 -> price 1.0; zeroForOne in 1000 -> spot 1000; fee 1% -> expected 990
    const sq = 1n << 96n;
    expect(priceImpactBps(sq, true, 1000n, 990n, 10000)).toBe(0);
    expect(priceImpactBps(sq, true, 1000n, 1000n, 10000)).toBe(0);
    expect(priceImpactBps(sq, true, 1000n, 891n, 10000)).toBe(1000); // 10% below expected 990
    expect(priceImpactBps(sq, true, 1000n, 940n, 10000)).toBe(506);  // (50/990)*1e4 = 505.05 -> up
    expect(priceImpactBps(sq, false, 1000n, 500n, 0)).toBe(5000);
    expect(() => priceImpactBps(0n, true, 1n, 1n, 0)).toThrow();
  });
});

describe("pool key / id", () => {
  it("pool key = (quote, token, lpFee, 200, 0x0)", () => {
    const k = finchPoolKey(ETH_ADDR, TOKEN, 10000);
    expect(k).toEqual({ currency0: ETH_ADDR, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: ETH_ADDR });
    // verified on mainnet: StateView.getSlot0(poolIdOf(key)) returned the pool's live slot0 (see live test)
    expect(poolIdOf(k)).toBe("0x" + ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [ETH_ADDR, TOKEN, 10000, 200, ETH_ADDR])).slice(2));
  });
});

describe("calldata layout", () => {
  const deadline = 1_900_000_000n;
  const iface = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
  it("Base buy (ETH in): commands 0x1004, value=amountIn, SWEEP(ETH, recipient, 0), actions 0x070c0f", () => {
    const b = buildSwap({ chain: "base", side: "buy", quote: ETH_ADDR, token: TOKEN, lpFee: 10000, amountIn: 10n ** 15n, minOut: 12345n, recipient: WHO, deadline });
    expect(b.to).toBe(CHAINS.base.universalRouter);
    expect(b.value).toBe((10n ** 15n).toString());
    const d = iface.decodeFunctionData("execute", b.data);
    expect(d[0]).toBe("0x1004");
    expect(d[2]).toBe(deadline);
    expect(d[1].length).toBe(2);
    const [acts, params] = coder.decode(["bytes", "bytes[]"], d[1][0]);
    expect(acts).toBe("0x070c0f");
    expect(coder.decode(["address", "uint256"], params[1])).toEqual([ETH_ADDR, 10n ** 15n]);
    expect(coder.decode(["address", "uint256"], params[2])).toEqual([TOKEN, 12345n]);
    expect(coder.decode(["address", "address", "uint160"], d[1][1])).toEqual([ETH_ADDR, WHO, 0n]);
    expect(b.permit2Token).toBeNull();
  });
  it("Base sell: commands 0x10 only, value 0, settle=token, take=ETH, needs Permit2", () => {
    const b = buildSwap({ chain: "base", side: "sell", quote: ETH_ADDR, token: TOKEN, lpFee: 10000, amountIn: 5n * 10n ** 18n, minOut: 777n, recipient: WHO, deadline });
    const d = iface.decodeFunctionData("execute", b.data);
    expect(d[0]).toBe("0x10");
    expect(d[1].length).toBe(1);
    expect(b.value).toBe("0");
    const [acts, params] = coder.decode(["bytes", "bytes[]"], d[1][0]);
    expect(acts).toBe("0x070c0f");
    expect(coder.decode(["address", "uint256"], params[1])).toEqual([TOKEN, 5n * 10n ** 18n]);
    expect(coder.decode(["address", "uint256"], params[2])).toEqual([ETH_ADDR, 777n]);
    expect(b.permit2Token).toBe(TOKEN);
  });
  it("Robinhood: single-hop layout (actions 0x060c0f), commands 0x10, no SWEEP, USDG buy needs Permit2", () => {
    const b = buildSwap({ chain: "robinhood", side: "buy", quote: USDG_ROBINHOOD, token: TOKEN, lpFee: 30000, amountIn: 1_000_000n, minOut: 5n, recipient: WHO, deadline });
    const d = iface.decodeFunctionData("execute", b.data);
    expect(d[0]).toBe("0x10");
    expect(d[1].length).toBe(1);
    expect(b.value).toBe("0");
    expect(b.permit2Token).toBe(ethers.getAddress(USDG_ROBINHOOD));
    const [acts] = coder.decode(["bytes", "bytes[]"], d[1][0]);
    expect(acts).toBe("0x060c0f");
  });
  it("refuses zero/overflow amounts", () => {
    const base = { chain: "base" as const, side: "buy" as const, quote: ETH_ADDR, token: TOKEN, lpFee: 10000, recipient: WHO, deadline };
    expect(() => buildSwap({ ...base, amountIn: 0n, minOut: 1n })).toThrow();
    expect(() => buildSwap({ ...base, amountIn: 1n, minOut: 0n })).toThrow();
    expect(() => buildSwap({ ...base, amountIn: 1n << 128n, minOut: 1n })).toThrow();
  });
  it("quoteId is deterministic and sensitive to every field", () => {
    const q = { chain: "base", token: TOKEN, side: "buy", amountIn: 1n, minOut: 2n, slippageBps: 100 };
    const id = swapQuoteId(q);
    expect(swapQuoteId({ ...q })).toBe(id);
    for (const m of [{ chain: "robinhood" }, { side: "sell" }, { amountIn: 2n }, { minOut: 3n }, { slippageBps: 101 }, { token: ETH_ADDR }]) expect(swapQuoteId({ ...q, ...m })).not.toBe(id);
  });
});

describe.skipIf(!haveBackend)("byte parity with the production backend encoders", () => {
  it("Robinhood (ETH-quoted; the backend helper hard-codes native ETH as the other leg so USDG-quoted pools are covered by live simulation instead): buildSwap == backend buildRhV4SwapCalldata (single route), buy & sell, several inputs", async () => {
    const mod: any = await import(/* @vite-ignore */ path.join(BACKEND, "_walletRhDex.ts"));
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = BigInt(Math.floor(Date.now() / 1000));
    let n = 0;
    for (const [quote, fee] of [[ETH_ADDR, 30000], [ETH_ADDR, 10000], [ETH_ADDR, 0], [ETH_ADDR, 20000]] as const) {
      for (const side of ["buy", "sell"] as const) {
        for (const [amountIn, minOut] of [[10n ** 15n, 98_000_000_000n], [123_456_789_012_345_678n, 1n], [10n ** 24n, 10n ** 23n + 7n]]) {
          const pool = { poolId: "0x", currency0: quote, currency1: ethers.getAddress(TOKEN), fee, tickSpacing: 200, hooks: ETH_ADDR, liquidityUsd: 0, quote: "ETH" };
          const ref = mod.buildRhV4SwapCalldata({ tokenCa: TOKEN, route: { kind: "single", pool }, side, amountIn, minOut });
          const mine = buildSwap({ chain: "robinhood", side, quote, token: TOKEN, lpFee: fee, amountIn, minOut, recipient: WHO, deadline: now + 1200n });
          expect(mine.data).toBe(ref.data);
          expect(mine.to.toLowerCase()).toBe(ref.to.toLowerCase());
          expect(mine.value).toBe(ref.value);
          n++;
        }
      }
    }
    console.log(`robinhood parity vectors compared byte-for-byte: ${n}`);
    expect(n).toBe(24);
  });

  it("Base: SWAP_EXACT_IN param encoder == backend buildV4ExactInputParams (extracted from walletActions.ts and executed)", async () => {
    const src = fs.readFileSync(path.join(BACKEND, "walletActions.ts"), "utf8");
    const flaunch = src.match(/const FLAUNCH = \{[\s\S]*?\n\};/)![0];
    const fn = src.match(/function buildV4ExactInputParams\([\s\S]*?\n\}\n/)![0];
    const ts = await import("typescript");
    const js = ts.transpileModule(`${flaunch}\n${fn}\nmodule.exports = { buildV4ExactInputParams, FLAUNCH };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const m: any = { exports: {} };
    new Function("module", "exports", "ethers", js)(m, m.exports, ethers);
    const { buildV4ExactInputParams, FLAUNCH } = m.exports;
    const pm = "0x" + "11".repeat(20);
    let n = 0;
    for (const isSell of [false, true]) {
      for (const [amountIn, minOut] of [[10n ** 15n, 5n * 10n ** 20n], [1n, 1n], [(1n << 128n) + 5n, 3n], [10n ** 24n, (1n << 130n)]]) {
        const ref: string = buildV4ExactInputParams(coder, isSell, TOKEN, amountIn, minOut, pm);
        // mine, given the backend's own path for this call (the Flaunch 2-hop path is pool-specific; the encoder around it is what we port)
        const hd = coder.encode(["address"], [FLAUNCH.ETH_ADDR]);
        const path2 = isSell
          ? [{ intermediateCurrency: FLAUNCH.FLETH, fee: 0, tickSpacing: 60, hooks: pm, hookData: hd }, { intermediateCurrency: FLAUNCH.ETH_ADDR, fee: 0, tickSpacing: 60, hooks: FLAUNCH.FLETH_HOOKS, hookData: "0x" }]
          : [{ intermediateCurrency: FLAUNCH.FLETH, fee: 0, tickSpacing: 60, hooks: FLAUNCH.FLETH_HOOKS, hookData: "0x" }, { intermediateCurrency: TOKEN, fee: 0, tickSpacing: 60, hooks: pm, hookData: hd }];
        const mine = encodeExactInputParams(isSell ? TOKEN : FLAUNCH.ETH_ADDR, path2, amountIn, minOut);
        expect(mine).toBe(ref);
        n++;
      }
    }
    console.log(`base SWAP_EXACT_IN param vectors compared byte-for-byte: ${n}`);
  });

  it("Base envelope literals still present in backend source (actions, commands, settle/take/sweep types)", () => {
    const src = fs.readFileSync(path.join(BACKEND, "walletActions.ts"), "utf8");
    for (const lit of ['const v4Actions = "0x070c0f";', '"0x1004"', '["address", "uint256"],\n      [ETH_ADDR, amountBigInt]', '["address", "address", "uint160"],\n      [ETH_ADDR, signerAddress, 0n]', '["bytes", "bytes[]"],\n      [v4Actions, [v4ExactInputParams, settleParams, takeParams]]', 'execute(\n      "0x10",\n      [v4RouterData]']) {
      expect(src.includes(lit), lit).toBe(true);
    }
  });
});
