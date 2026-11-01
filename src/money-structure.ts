// Uniform machine-readable result for every money-moving tool: { txHash, status, chainId }.
// Some tools already emit richer structuredContent (executed, signature, mintTx, confirmed, chain …); this
// post-processor, applied at the CallTool choke point, guarantees the three canonical fields on all of them
// without removing anything the tool already returns.

import type { ToolResult } from "./types.js";

export type MoneyStatus = "confirmed" | "pending" | "reverted" | "failed" | "refused" | "preview";
const VALID: ReadonlySet<string> = new Set(["confirmed", "pending", "reverted", "failed", "refused", "preview"]);

export const SOLANA_CHAIN_ID = "solana:mainnet";
const CHAIN_IDS: Record<string, number | string> = { base: 8453, robinhood: 4663, rh: 4663, solana: SOLANA_CHAIN_ID };

/** Tools that move (or arm the movement of) funds, with a default chain when the result does not say. */
export const MONEY_TOOLS: Readonly<Record<string, number | string | null>> = {
  base_mcp_send: 8453, base_mcp_swap: 8453,
  rh_mcp_swap: 4663, rh_stock_bridge: 4663,
  sol_swap: SOLANA_CHAIN_ID, sol_send: SOLANA_CHAIN_ID, sol_launch_token: SOLANA_CHAIN_ID,
  launchpad_launch_token: null, launchpad_buy: null, launchpad_sell: null, // chain comes from the result
  stake_finch: 4663, unstake_finch: 4663, claim_vested_rewards: 4663, stake_auto_restake: 4663,
  run_automation: 8453,
};

const HASH_RE = /(0x[a-fA-F0-9]{64})|\b([1-9A-HJ-NP-Za-km-z]{80,90})\b/;

export function normalizeMoneyResult(tool: string, result: ToolResult): ToolResult {
  if (!(tool in MONEY_TOOLS) || !result) return result;
  const sc: Record<string, any> = { ...((result as any).structuredContent ?? {}) };
  const text = (result.content ?? []).map((c: any) => (c?.type === "text" ? String(c.text) : "")).join("\n");
  const isError = !!(result as any).isError;

  let txHash: string | null =
    sc.txHash ?? sc.signature ?? sc.mintTx ?? sc.poolTx ?? sc.hash ?? null;
  if (!txHash) {
    const m = text.match(/Tx(?: Hash)?:\s*`?(0x[a-fA-F0-9]{64})/i) ?? text.match(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{80,90})/);
    txHash = m ? m[1] : null;
  }

  let status: string | undefined = typeof sc.status === "string" && VALID.has(sc.status) ? sc.status : undefined;
  if (!status) {
    if (sc.executed === false) status = isError && sc.reason ? "refused" : isError ? "failed" : "preview";
    else if (sc.confirmed === false) status = "pending";
    else if (isError) status = txHash ? "reverted" : "failed";
    else if (sc.executed === true || txHash) status = "confirmed";
    else status = "preview";
  }

  let chainId: number | string | null = sc.chainId ?? null;
  if (chainId == null && typeof sc.chain === "string") chainId = CHAIN_IDS[sc.chain.toLowerCase()] ?? null;
  if (chainId == null) chainId = MONEY_TOOLS[tool];

  return {
    ...result,
    structuredContent: { ...sc, txHash, status, chainId },
  } as ToolResult;
}
