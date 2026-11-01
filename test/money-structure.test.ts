import { describe, it, expect } from "vitest";
import { normalizeMoneyResult, MONEY_TOOLS } from "../src/money-structure.js";
import { ALL_TOOLS } from "../src/server.js";
import { annotationsFor } from "../src/annotations.js";

const r = (text: string, sc?: any, isError = false): any => ({ content: [{ type: "text", text }], structuredContent: sc, isError });
const H = "0x" + "ab".repeat(32);

describe("money result normalisation", () => {
  it("adds txHash/status/chainId to a solana swap result that only had signature", () => {
    const sig = "5".repeat(88);
    const o: any = normalizeMoneyResult("sol_swap", r("ok", { executed: true, signature: sig, extra: 1 }));
    expect(o.structuredContent).toMatchObject({ txHash: sig, status: "confirmed", chainId: "solana:mainnet", extra: 1, signature: sig });
  });
  it("launchpad_buy pending vs confirmed, chain from result", () => {
    expect((normalizeMoneyResult("launchpad_buy", r("x", { executed: true, confirmed: false, txHash: H, chain: "robinhood" })) as any).structuredContent)
      .toMatchObject({ status: "pending", chainId: 4663, txHash: H });
    expect((normalizeMoneyResult("launchpad_sell", r("x", { executed: true, confirmed: true, txHash: H, chain: "base" })) as any).structuredContent)
      .toMatchObject({ status: "confirmed", chainId: 8453 });
  });
  it("text-only stake result gets hash parsed from the text", () => {
    const o: any = normalizeMoneyResult("stake_finch", r(`Staked.\nTx: \`${H}\``));
    expect(o.structuredContent).toMatchObject({ txHash: H, status: "confirmed", chainId: 4663 });
  });
  it("errors: failed with no hash; refused when the gate says so; preview when not executed", () => {
    expect((normalizeMoneyResult("unstake_finch", r("boom", undefined, true)) as any).structuredContent).toMatchObject({ txHash: null, status: "failed", chainId: 4663 });
    expect((normalizeMoneyResult("base_mcp_send", r("no", { executed: false, status: "refused", txHash: null }, true)) as any).structuredContent.status).toBe("refused");
    expect((normalizeMoneyResult("sol_send", r("preview", { executed: false })) as any).structuredContent.status).toBe("preview");
  });
  it("leaves non-money tools untouched", () => {
    const x = r("hi", { a: 1 });
    expect(normalizeMoneyResult("get_market_data", x)).toBe(x);
  });
  it("MONEY_TOOLS only names real tools and every fund-moving destructive tool is covered", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const k of Object.keys(MONEY_TOOLS)) expect(names.has(k), k).toBe(true);
    for (const must of ["base_mcp_send", "base_mcp_swap", "rh_mcp_swap", "sol_swap", "sol_send", "sol_launch_token", "launchpad_buy", "launchpad_sell", "launchpad_launch_token", "stake_finch", "unstake_finch", "claim_vested_rewards"]) {
      expect(MONEY_TOOLS).toHaveProperty(must);
      expect(annotationsFor(must).destructiveHint).toBe(true);
    }
  });
});
