// launchpad_buy / launchpad_sell: preview, spend gate, caps, drift, factory-launched check, price impact.
// All network is mocked (fetch). No transaction is ever sent here.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ethers } from "ethers";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "finch-lp-test-"));
process.env.HOME = TMP_HOME;
process.env.FINCH_WALLET_PASSPHRASE = "test-passphrase";

vi.mock("../src/wallet.js", async () => {
  const { ethers: e } = await import("ethers");
  const w = new e.Wallet("0x" + "11".repeat(32)); // throwaway test key, never funded
  return { getOrCreateWallet: async () => w };
});

import { handleLaunchpadSwapTool, LAUNCHPAD_SWAP_TOOLS, capFromEnv, _resetPreviews } from "../src/tools/launchpad-swap.js";
import { CHAINS, FINCH_FACTORY, USDG_ROBINHOOD } from "../src/launchpad-v4.js";

const TOKEN = ethers.getAddress("0x1688E6cE60FE0C7743ff07ce0b578942Dd4F1723");
const FOREIGN = ethers.getAddress("0x4200000000000000000000000000000000000006");
const coder = ethers.AbiCoder.defaultAbiCoder();
const Q = ethers.Interface.from(["function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)", "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)", "function infoOf(address) view returns (uint256,address,address,int24,uint24)", "function balanceOf(address) view returns (uint256)"]);

interface World { quoteOut: bigint; quoteAddr: string; lpFee: number; launched: Set<string>; calls: { method: string; to?: string; value?: string }[]; sent: number; sqrt: bigint; balance: bigint }
let W: World;

function install() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const { method, params, id } = JSON.parse(init.body);
    const p0 = params?.[0] ?? {};
    W.calls.push({ method, to: p0.to, value: p0.value });
    const res = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) });
    const err = (m: string) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, error: { message: m } }) });
    if (method === "eth_sendRawTransaction") { W.sent++; return res("0x" + "ab".repeat(32)); }
    if (method === "eth_getCode") return res("0x6001");
    if (method === "eth_getBalance") return res("0x0");
    if (method === "eth_gasPrice") return res("0x1");
    if (method === "eth_call") {
      const to = String(p0.to).toLowerCase(); const sel = String(p0.data).slice(0, 10);
      if (to === FINCH_FACTORY.toLowerCase()) {
        const t = ethers.getAddress("0x" + String(p0.data).slice(34));
        return res(coder.encode(["uint256", "address", "address", "int24", "uint24"], [W.launched.has(t) ? 7n : 0n, ethers.ZeroAddress, W.quoteAddr, 184200, W.lpFee]));
      }
      if (to === CHAINS.base.quoter.toLowerCase() || to === CHAINS.robinhood.quoter.toLowerCase()) return res(coder.encode(["uint256", "uint256"], [W.quoteOut, 50000n]));
      if (to === CHAINS.base.stateView.toLowerCase() || to === CHAINS.robinhood.stateView.toLowerCase()) return res(coder.encode(["uint160", "int24", "uint24", "uint24"], [W.sqrt, 0, 0, W.lpFee]));
      if (sel === Q.getFunction("balanceOf")!.selector) return res(coder.encode(["uint256"], [W.balance]));
      return err("execution reverted");
    }
    return err("unmocked " + method);
  }));
}

beforeEach(() => {
  _resetPreviews();
  for (const k of ["FINCH_LAUNCHPAD_ALLOW_SPEND", "FINCH_LAUNCHPAD_MAX_BUY_ETH", "FINCH_LAUNCHPAD_MAX_BUY_USDG"]) delete process.env[k];
  // price 1.0 (sqrt = 2^96); 0.001 ETH in -> 0.001*(1-1%) expected at zero impact
  W = { quoteOut: 990_000_000_000_000n, quoteAddr: ethers.ZeroAddress, lpFee: 10000, launched: new Set([TOKEN]), calls: [], sent: 0, sqrt: 1n << 96n, balance: 10n ** 21n };
  install();
});
afterEach(() => { vi.unstubAllGlobals(); });

const buy = (extra: Record<string, any> = {}) => handleLaunchpadSwapTool("launchpad_buy", { chain: "base", token: TOKEN, amount: "0.001", ...extra });
async function previewThenConfirm(extra: Record<string, any> = {}, confirmExtra: Record<string, any> = {}) {
  const prev: any = await buy(extra);
  return buy({ ...extra, confirmed: true, quoteId: prev.structuredContent.quoteId, ...confirmExtra });
}

describe("tool schemas", () => {
  it("exports exactly launchpad_buy and launchpad_sell with required fields", () => {
    expect(LAUNCHPAD_SWAP_TOOLS.map((t) => t.name)).toEqual(["launchpad_buy", "launchpad_sell"]);
    expect((LAUNCHPAD_SWAP_TOOLS[0].inputSchema as any).required).toEqual(["chain", "token", "amount"]);
    expect((LAUNCHPAD_SWAP_TOOLS[1].inputSchema as any).required).toEqual(["chain", "token"]);
  });
});

describe("preview", () => {
  it("returns a preview with quoteId + minOut = quote*(1-1%) and sends nothing", async () => {
    const r: any = await buy();
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.executed).toBe(false);
    expect(r.structuredContent.slippageBps).toBe(100);
    expect(r.structuredContent.expectedOut).toBe(ethers.formatUnits(990_000_000_000_000n, 18));
    expect(r.structuredContent.minOut).toBe(ethers.formatUnits(980_100_000_000_000n, 18));
    expect(r.structuredContent.quoteId).toMatch(/^[0-9a-f]{16}$/);
    expect(r.content[0].text).toContain("NOT EXECUTED");
    expect(W.sent).toBe(0);
    expect(W.calls.every((c) => c.method !== "eth_sendRawTransaction")).toBe(true);
  });
  it("prints the token symbol JSON-quoted (data, not instructions)", async () => {
    const r: any = await buy();
    expect(r.content[0].text).toContain(JSON.stringify(TOKEN));
  });
  it("custom slippage changes minOut; >5% is refused", async () => {
    const r: any = await buy({ slippagePct: 5 });
    expect(r.structuredContent.minOut).toBe(ethers.formatUnits((990_000_000_000_000n * 9500n) / 10000n, 18));
    const bad: any = await buy({ slippagePct: 5.5 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/ceiling/);
  });
  it("confirmed=true without a matching quoteId is ignored (still a preview)", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const r: any = await buy({ confirmed: true, quoteId: "deadbeefdeadbeef" });
    expect(r.structuredContent.executed).toBe(false);
    expect(r.content[0].text).toContain("confirmed=true was ignored");
    expect(W.sent).toBe(0);
  });
  it("quoteId from a different amount does not match", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const prev: any = await buy({ amount: "0.001" });
    const r: any = await buy({ amount: "0.002", confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.structuredContent.executed).toBe(false);
  });
});

describe("factory-launched check", () => {
  it("refuses a token the Finch factory never launched (preview and confirmed)", async () => {
    const r: any = await buy({ token: FOREIGN });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not launched by the Finch/);
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const r2: any = await buy({ token: FOREIGN, confirmed: true, quoteId: "x" });
    expect(r2.isError).toBe(true);
    expect(W.sent).toBe(0);
  });
  it("refuses a launch whose quote asset is unsupported on the chain (USDG on base)", async () => {
    W.quoteAddr = USDG_ROBINHOOD;
    const r: any = await buy();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/does not support/);
  });
  it("rejects bad chain / bad address / bad amount", async () => {
    expect(((await buy({ chain: "solana" })) as any).isError).toBe(true);
    expect(((await buy({ token: "nope" })) as any).isError).toBe(true);
    for (const amount of ["0", "-1", "abc", "1e3", "0.0000000000000000001"]) expect(((await buy({ amount })) as any).isError).toBe(true);
  });
});

describe("spend gate (default-deny)", () => {
  it("confirmed + valid quoteId is refused unless FINCH_LAUNCHPAD_ALLOW_SPEND=1", async () => {
    const r: any = await previewThenConfirm();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/default-deny/);
    expect(W.sent).toBe(0);
  });
  it("any value other than '1' keeps it closed", async () => {
    for (const v of ["true", "0", "yes", ""]) {
      process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = v;
      expect(((await previewThenConfirm()) as any).content[0].text).toMatch(/default-deny/);
    }
  });
  it("with the gate open the flow proceeds past the gate (stops at the balance check: wallet has 0 ETH)", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const r: any = await previewThenConfirm();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Insufficient ETH/);
    expect(W.sent).toBe(0);
  });
  it("sell is gated too", async () => {
    W.quoteOut = (W.balance / 2n) * 99n / 100n; // fair quote at price 1.0 minus the 1% pool fee
    const prev: any = await handleLaunchpadSwapTool("launchpad_sell", { chain: "base", token: TOKEN, percent: 50 });
    expect(prev.structuredContent.executed).toBe(false);
    const r: any = await handleLaunchpadSwapTool("launchpad_sell", { chain: "base", token: TOKEN, percent: 50, confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.content[0].text).toMatch(/default-deny/);
  });
});

describe("buy caps", () => {
  beforeEach(() => { process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1"; });
  it("default ETH cap 0.05: 0.06 refused, 0.05 passes the cap", async () => {
    W.quoteOut = 59_400_000_000_000_000n;
    const over: any = await previewThenConfirm({ amount: "0.06" });
    expect(over.content[0].text).toMatch(/exceeds the per-call cap 0\.05/);
    W.quoteOut = 49_500_000_000_000_000n;
    const at: any = await previewThenConfirm({ amount: "0.05" });
    expect(at.content[0].text).toMatch(/Insufficient ETH/); // got past the cap
  });
  it("FINCH_LAUNCHPAD_MAX_BUY_ETH overrides the cap", async () => {
    process.env.FINCH_LAUNCHPAD_MAX_BUY_ETH = "0.0005";
    const r: any = await previewThenConfirm({ amount: "0.001" });
    expect(r.content[0].text).toMatch(/exceeds the per-call cap 0\.0005/);
  });
  it("junk cap values fail closed", async () => {
    for (const v of ["abc", "-1", "1e3", "0x10", "1,5", " . "]) {
      process.env.FINCH_LAUNCHPAD_MAX_BUY_ETH = v;
      const r: any = await previewThenConfirm();
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/fail closed/);
    }
    expect(() => capFromEnv("X_UNSET_CAP", "0.05", 18)).not.toThrow();
  });
  it("cap of 0 blocks all buys", async () => {
    process.env.FINCH_LAUNCHPAD_MAX_BUY_ETH = "0";
    expect(((await previewThenConfirm()) as any).content[0].text).toMatch(/exceeds the per-call cap/);
  });
  it("USDG cap enforced when the quote is fair", async () => {
    W.quoteAddr = USDG_ROBINHOOD; W.lpFee = 30000; W.sqrt = 1n << 96n; // price 1 raw token per raw usdg
    W.quoteOut = 101_000_000n * 97n / 100n; // 3% fee removed, zero impact
    const a = { chain: "robinhood", token: TOKEN, amount: "101" };
    const prev: any = await handleLaunchpadSwapTool("launchpad_buy", a);
    expect(prev.structuredContent.quoteId).toBeTruthy();
    const r: any = await handleLaunchpadSwapTool("launchpad_buy", { ...a, confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.content[0].text).toMatch(/exceeds the per-call cap 100\.0 USDG|exceeds the per-call cap 100/);
  });
});

describe("quote drift (>0.5% worse min-out between preview and execution)", () => {
  beforeEach(() => { process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1"; });
  it("refuses when min-out dropped 1% and sends nothing", async () => {
    const prev: any = await buy();
    W.quoteOut = (W.quoteOut * 99n) / 100n;
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Quote moved/);
    expect(W.sent).toBe(0);
  });
  it("tolerates a 0.3% drop (passes drift, stops later at balance)", async () => {
    const prev: any = await buy();
    W.quoteOut = (W.quoteOut * 997n) / 1000n;
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.content[0].text).toMatch(/Insufficient ETH/);
  });
  it("a BETTER price never trips drift", async () => {
    const prev: any = await buy();
    W.quoteOut = (W.quoteOut * 11n) / 10n;
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.content[0].text).toMatch(/Insufficient ETH|exceeds/);
  });
});

describe("price impact", () => {
  it("refuses > 5% impact even as a preview", async () => {
    W.quoteOut = 900_000_000_000_000n; // expected 990e12 -> ~9.1% below
    const r: any = await buy();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/price impact/);
    expect(r.structuredContent.rejected).toBe("price_impact");
  });
  it("accepts ~3% impact", async () => {
    W.quoteOut = 960_000_000_000_000n;
    expect(((await buy()) as any).isError).toBeUndefined();
  });
});

describe("sell input handling", () => {
  it("percent maps to a floor of the balance; both percent and amount is an error", async () => {
    W.balance = 1000n * 10n ** 18n;
    W.quoteOut = 1n * 10n ** 18n * 99n / 100n; W.sqrt = 1n << 96n; // sell zeroForOne=false: expected = in/p *0.99
    const r: any = await handleLaunchpadSwapTool("launchpad_sell", { chain: "base", token: TOKEN, percent: 100 });
    expect(r.structuredContent.amountIn).toBe("1000.0");
    const both: any = await handleLaunchpadSwapTool("launchpad_sell", { chain: "base", token: TOKEN, percent: 10, amount: "1" });
    expect(both.isError).toBe(true);
    const none: any = await handleLaunchpadSwapTool("launchpad_sell", { chain: "base", token: TOKEN });
    expect(none.isError).toBe(true);
    const over: any = await handleLaunchpadSwapTool("launchpad_sell", { chain: "base", token: TOKEN, amount: "1001" });
    expect(over.content[0].text).toMatch(/exceeds your balance/);
  });
});
