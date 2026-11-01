// LIVE read-only mainnet proof (eth_call only, throwaway sender, state overrides). Run with:
//   LIVE_SIM=1 npx vitest run test/launchpad-swap-live.test.ts
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { CHAINS, buildSwap, encodeExactInputSingleParams, finchPoolKey, minOutFromQuote, LaunchChain, FINCH_FACTORY } from "../src/launchpad-v4.js";
import { resolveLaunch, quoteSwap, simulateSwap } from "../src/tools/launchpad-swap.js";

const LIVE = process.env.LIVE_SIM === "1";
const coder = ethers.AbiCoder.defaultAbiCoder();
const WHO = ethers.getAddress("0x00000000000000000000000000000000DeaDBeef"); // throwaway, no key
const P2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
async function rawCall(chain: LaunchChain, to: string, data: string, ov: unknown) {
  const r = await fetch(CHAINS[chain].rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest", ov] }) });
  const j: any = await r.json(); if (j.error) throw new Error(j.error.message); return j.result as string;
}
const BASE_RPC = process.env.LIVE_BASE_RPC || "https://base-rpc.publicnode.com";

const targets: { name: string; chain: LaunchChain; token: string; rpc?: string }[] = [
  { name: "base ETH-quoted (launched ~recent)", chain: "base", token: "0x1688E6cE60FE0C7743ff07ce0b578942Dd4F1723", rpc: BASE_RPC },
  { name: "robinhood ETH-quoted", chain: "robinhood", token: "0x4aD72182d4d4FaA94c1EAE341FD225E280bF7357" },
  { name: "robinhood USDG-quoted", chain: "robinhood", token: "0xbDcE5aA183BB93B775f627aDcaBB715d3bC39A0f" },
];

const slotBal = ethers.keccak256(coder.encode(["address", "uint256"], [WHO, 0]));
const slotAllow = (tok: string) => { void tok; return ethers.keccak256(coder.encode(["address", "bytes32"], [P2, ethers.keccak256(coder.encode(["address", "uint256"], [WHO, 1]))])); };
function p2Slot(token: string, spender: string) {
  const l1 = ethers.keccak256(coder.encode(["address", "uint256"], [WHO, 1]));
  const l2 = ethers.keccak256(coder.encode(["address", "bytes32"], [token, l1]));
  return ethers.keccak256(coder.encode(["address", "bytes32"], [spender, l2]));
}

describe.skipIf(!LIVE)("live eth_call simulation of UR execute()", () => {
  for (const t of targets) {
    it(t.name, async () => {
      if (t.rpc) (CHAINS[t.chain] as any).rpc = t.rpc;
      const cfg = CHAINS[t.chain];
      const li = await resolveLaunch(t.chain, t.token);
      console.log(`[${t.name}] launch: quote=${li.quoteSymbol} lpFee=${li.lpFee} launcher=${li.launcher} symbol=${li.symbol}`);

      // ── BUY ──
      const amtIn = li.quoteKey === "eth" ? ethers.parseEther("0.001") : 1_000_000n;
      const bq = await quoteSwap(t.chain, li, "buy", amtIn);
      const bmin = minOutFromQuote(bq.amountOut, 100);
      console.log(`  BUY quote: in=${amtIn} out=${bq.amountOut} impactBps=${bq.impactBps} minOut=${bmin}`);
      const buy = buildSwap({ chain: t.chain, side: "buy", quote: li.quote, token: li.token, lpFee: li.lpFee, amountIn: amtIn, minOut: bmin, recipient: WHO, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) });
      const buyOv: any = { [WHO]: { balance: "0x" + ethers.parseEther("1").toString(16) } };
      if (li.quoteKey === "usdg") {
        const bi = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
        let balSlotIdx = -1, alwSlotIdx = -1;
        for (let sIdx = 0; sIdx < 12 && (balSlotIdx < 0 || alwSlotIdx < 0); sIdx++) {
          const bs = ethers.keccak256(coder.encode(["address", "uint256"], [WHO, sIdx]));
          const r = await rawCall(t.chain, li.quote, bi.encodeFunctionData("balanceOf", [WHO]), { [li.quote]: { stateDiff: { [bs]: ethers.toBeHex(777n, 32) } } });
          if (BigInt(r) === 777n && balSlotIdx < 0) balSlotIdx = sIdx;
          const as = ethers.keccak256(coder.encode(["address", "bytes32"], [P2, ethers.keccak256(coder.encode(["address", "uint256"], [WHO, sIdx]))]));
          const r2 = await rawCall(t.chain, li.quote, bi.encodeFunctionData("allowance", [WHO, P2]), { [li.quote]: { stateDiff: { [as]: ethers.toBeHex(888n, 32) } } });
          if (BigInt(r2) === 888n && alwSlotIdx < 0) alwSlotIdx = sIdx;
        }
        console.log(`  USDG storage slots: balance=${balSlotIdx} allowance=${alwSlotIdx}`);
        expect(balSlotIdx).toBeGreaterThanOrEqual(0);
        expect(alwSlotIdx).toBeGreaterThanOrEqual(0);
        buyOv[li.quote] = { stateDiff: {
          [ethers.keccak256(coder.encode(["address", "uint256"], [WHO, balSlotIdx]))]: ethers.toBeHex(10_000_000n, 32),
          [ethers.keccak256(coder.encode(["address", "bytes32"], [P2, ethers.keccak256(coder.encode(["address", "uint256"], [WHO, alwSlotIdx]))]))]: ethers.toBeHex(ethers.MaxUint256, 32),
        } };
        buyOv[P2] = { stateDiff: { [p2Slot(li.quote, cfg.universalRouter)]: ethers.toBeHex(((2n ** 47n) << 160n) | 10_000_000n, 32) } };
      }
      const buyRes = await simulateSwap(t.chain, WHO, buy, buyOv);
      console.log(`  BUY simulate OK, to=${buy.to} commands=${buy.commands} value=${buy.value} ret=${buyRes}`);
      const badBuy = buildSwap({ chain: t.chain, side: "buy", quote: li.quote, token: li.token, lpFee: li.lpFee, amountIn: amtIn, minOut: bq.amountOut * 2n, recipient: WHO, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) });
      await expect(simulateSwap(t.chain, WHO, badBuy, buyOv)).rejects.toThrow();
      console.log("  buy negative control (minOut = 2x quote) reverted as expected");

      // ── SELL (token in, Permit2 route) ──
      const sellIn = 1_000n * 10n ** BigInt(li.tokenDecimals);
      const sq = await quoteSwap(t.chain, li, "sell", sellIn);
      const smin = minOutFromQuote(sq.amountOut, 100);
      console.log(`  SELL quote: in=${sellIn} out=${sq.amountOut} impactBps=${sq.impactBps} minOut=${smin}`);
      const sell = buildSwap({ chain: t.chain, side: "sell", quote: li.quote, token: li.token, lpFee: li.lpFee, amountIn: sellIn, minOut: smin, recipient: WHO, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) });
      const packed = (2n ** 47n << 160n) | sellIn * 10n; // expiration far future, amount
      const sellOv: any = {
        [WHO]: { balance: "0x" + ethers.parseEther("1").toString(16) },
        [li.token]: { stateDiff: { [slotBal]: ethers.toBeHex(sellIn * 10n, 32), [slotAllow(li.token)]: ethers.toBeHex(ethers.MaxUint256, 32) } },
        [P2]: { stateDiff: { [p2Slot(li.token, cfg.universalRouter)]: ethers.toBeHex((((2n ** 47n) << 160n) | (sellIn * 10n)), 32) } },
      };
      void packed;
      try {
        const r = await simulateSwap(t.chain, WHO, sell, sellOv);
        console.log(`  SELL simulate OK, to=${sell.to} commands=${sell.commands} value=${sell.value} ret=${r}`);
      } catch (e) { console.log("  SELL simulate FAILED:", String((e as any).message).slice(0, 300)); throw e; }

      // ── negative control: minOut absurdly above quote must revert (proves the sim really executes the swap) ──
      const bad = buildSwap({ chain: t.chain, side: "sell", quote: li.quote, token: li.token, lpFee: li.lpFee, amountIn: sellIn, minOut: sq.amountOut * 2n, recipient: WHO, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) });
      await expect(simulateSwap(t.chain, WHO, bad, sellOv)).rejects.toThrow();
      console.log("  negative control (minOut = 2x quote) reverted as expected");
    }, 120_000);
  }

  it("factory rejects a non-Finch token", async () => {
    await expect(resolveLaunch("base", "0x4200000000000000000000000000000000000006")).rejects.toThrow(/not launched by the Finch/);
    void FINCH_FACTORY; void encodeExactInputSingleParams; void finchPoolKey;
  }, 30_000);
});
