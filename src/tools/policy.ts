// Model-callable safety tools: wallet_policy (inspect / TIGHTEN the spend policy, engage the kill-switch)
// and approvals_list / approvals_revoke (find and remove token allowances).
//
// wallet_policy can only make things stricter than what is in force right now. Loosening a cap, widening the
// allowlist, or releasing the kill-switch requires the human operator (env vars / editing ~/.finch files) —
// otherwise a prompt-injected page could simply ask the model to lift the limits.

import { ethers } from "ethers";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "../types.js";
import { getOrCreateWallet, BASE_RPC, BASE_CHAIN_ID } from "../wallet.js";
import { allowedContracts, PERMIT2 } from "../evm-guard.js";
import {
  effectivePolicy, loadPolicy, savePolicy, setKillSwitch, isKilled, killSwitchFile, parseUsdMicros, formatUsdMicros,
  spentLast24h, envCeilings, issueQuoteId, consumeQuote, type Policy,
} from "../spend-gate.js";
import { RH_CHAIN_ID, RH_STOCKS, USDG_ADDRESS } from "./rh-mcp-constants.js";
import { rhProviderAsync } from "./rh-mcp-provider.js";
import { FINCH_RH_ADDRESS } from "../constants.js";

const text = (t: string, isError = false, sc?: Record<string, unknown>): ToolResult =>
  ({ content: [{ type: "text", text: t }], isError, ...(sc ? { structuredContent: sc } : {}) }) as ToolResult;

export const POLICY_TOOLS: Tool[] = [
  {
    name: "wallet_policy",
    description:
      "Show or TIGHTEN the local wallet's spend policy (per-call USD cap, 24h USD cap, recipient allowlist, kill-switch). " +
      "action=show (default) prints the effective policy and 24h usage. action=set can only LOWER caps, NARROW the allowlist, " +
      "never raise/widen them; action=kill engages the kill-switch (stops every spend immediately). Raising limits or releasing " +
      "the kill-switch must be done by the human operator (FINCH_* env vars / deleting " + "~/.finch/spend.OFF); this tool cannot.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "set", "kill"], description: "show (default) | set | kill" },
        maxPerCallUsd: { type: "string", description: "New per-call cap in USD (must be <= current)" },
        maxPerDayUsd: { type: "string", description: "New rolling-24h cap in USD (must be <= current)" },
        allowlist: { type: "array", items: { type: "string" }, description: "Recipient allowlist (0x…). Must be a subset of the current allowlist if one exists." },
      },
      required: [],
    },
  },
  {
    name: "approvals_list",
    description:
      "List active ERC-20 allowances this wallet has granted on Base or Robinhood Chain to known routers/Permit2 (and Permit2 sub-allowances to routers). " +
      "Read-only. Pass `token` to also check a specific token. Use approvals_revoke to remove one.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["base", "robinhood"], description: "default base" },
        token: { type: "string", description: "Optional extra token address to check" },
      },
      required: [],
    },
  },
  {
    name: "approvals_revoke",
    description:
      "Revoke an ERC-20 allowance (sets it to 0) granted by this wallet. Costs gas, moves no tokens. Two-step: the first call " +
      "returns a preview and a quoteId; re-run the SAME call with confirm:true and that quoteId. Set via=permit2 to revoke a Permit2 sub-allowance instead.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["base", "robinhood"] },
        token: { type: "string", description: "Token contract address" },
        spender: { type: "string", description: "Spender to revoke (router, Permit2, …)" },
        via: { type: "string", enum: ["erc20", "permit2"], description: "default erc20" },
        confirm: { type: "boolean" },
        quoteId: { type: "string" },
      },
      required: ["chain", "token", "spender"],
    },
  },
];

// ── wallet_policy ───────────────────────────────────────────────────────────
function showPolicy(): ToolResult {
  const p = effectivePolicy();
  const c = envCeilings();
  const used = spentLast24h();
  const lines = [
    "## Wallet spend policy",
    `Spending enabled by operator (FINCH_ALLOW_SPEND=1): **${p.spendEnabled ? "yes" : "NO (default-deny)"}**`,
    `Kill-switch: **${p.killed ? "ENGAGED" : "off"}**${p.killed ? ` (remove ${killSwitchFile()} and unset FINCH_SPEND_DISABLED to release — operator only)` : ""}`,
    `Per-call cap: $${formatUsdMicros(p.perCall)} (operator ceiling $${formatUsdMicros(c.perCall)})`,
    `24h cap: $${formatUsdMicros(p.perDay)} (operator ceiling $${formatUsdMicros(c.perDay)}) · used $${formatUsdMicros(used)}`,
    `Recipient allowlist: ${p.allowlist.length ? p.allowlist.join(", ") : "none (any recipient, subject to caps)"}`,
  ];
  return text(lines.join("\n"), false, {
    spendEnabled: p.spendEnabled, killed: p.killed, maxPerCallUsd: formatUsdMicros(p.perCall), maxPerDayUsd: formatUsdMicros(p.perDay),
    usedLast24hUsd: formatUsdMicros(used), allowlist: p.allowlist,
  });
}

export function applyPolicyChange(a: { maxPerCallUsd?: unknown; maxPerDayUsd?: unknown; allowlist?: unknown }): ToolResult {
  const cur = effectivePolicy();
  const next: Policy = { ...loadPolicy(), version: 1 };
  const changes: string[] = [];
  const reject = (m: string) => text(`⛔ Not changed — ${m} Only the operator can loosen the policy.`, true);

  if (a.maxPerCallUsd != null) {
    let v: bigint; try { v = parseUsdMicros(String(a.maxPerCallUsd)); } catch (e: any) { return text(e.message, true); }
    if (v > cur.perCall) return reject(`maxPerCallUsd $${formatUsdMicros(v)} is above the current cap $${formatUsdMicros(cur.perCall)}.`);
    next.maxPerCallUsd = (Number(v) / 1e6).toFixed(6);
    changes.push(`per-call cap → $${formatUsdMicros(v)}`);
  }
  if (a.maxPerDayUsd != null) {
    let v: bigint; try { v = parseUsdMicros(String(a.maxPerDayUsd)); } catch (e: any) { return text(e.message, true); }
    if (v > cur.perDay) return reject(`maxPerDayUsd $${formatUsdMicros(v)} is above the current cap $${formatUsdMicros(cur.perDay)}.`);
    next.maxPerDayUsd = (Number(v) / 1e6).toFixed(6);
    changes.push(`24h cap → $${formatUsdMicros(v)}`);
  }
  if (a.allowlist != null) {
    if (!Array.isArray(a.allowlist)) return text("allowlist must be an array of 0x addresses.", true);
    const list = a.allowlist.map((s) => String(s).trim().toLowerCase());
    if (list.some((s) => !/^0x[0-9a-f]{40}$/.test(s))) return text("allowlist contains an invalid address.", true);
    if (cur.allowlist.length && !list.every((s) => cur.allowlist.includes(s))) return reject("allowlist adds addresses that are not already allowed.");
    if (!list.length) return reject("an empty allowlist would remove the restriction; to block everything use action=kill.");
    next.allowlist = list;
    changes.push(`allowlist → ${list.length} address(es)`);
  }
  if (!changes.length) return text("Nothing to change. Provide maxPerCallUsd, maxPerDayUsd and/or allowlist.", true);
  savePolicy(next);
  return text(`✅ Policy tightened: ${changes.join("; ")}.\n\n${(showPolicy().content[0] as any).text}`, false);
}

// ── approvals ───────────────────────────────────────────────────────────────
async function chainCtx(chain: unknown): Promise<{ chainId: number; provider: ethers.JsonRpcProvider; explorer: string; tokens: Array<{ address: string; symbol: string }> }> {
  if (chain === "robinhood") {
    return {
      chainId: RH_CHAIN_ID, provider: await rhProviderAsync(), explorer: "https://robinhoodchain.blockscout.com",
      tokens: [{ address: USDG_ADDRESS, symbol: "USDG" }, { address: FINCH_RH_ADDRESS, symbol: "FINCH" }, ...RH_STOCKS.map((s) => ({ address: s.address, symbol: s.symbol }))],
    };
  }
  return {
    chainId: BASE_CHAIN_ID, provider: new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN_ID, { staticNetwork: true }), explorer: "https://basescan.org",
    tokens: [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" }, { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
      { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI" }, { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT" },
      { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC" },
    ],
  };
}
const ERC20_ALLOW = ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const P2_ABI = [
  "function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
];

async function listApprovals(a: any): Promise<ToolResult> {
  if (a.token != null && !ethers.isAddress(String(a.token))) return text("token must be a 0x address.", true);
  const ctx = await chainCtx(a.chain);
  const wallet = await getOrCreateWallet();
  const spenders = [...allowedContracts(ctx.chainId)];
  const tokens = [...ctx.tokens];
  if (a.token) tokens.push({ address: String(a.token), symbol: "(custom)" });
  const found: Array<Record<string, unknown>> = [];
  const jobs: Promise<void>[] = [];
  for (const t of tokens) {
    const c = new ethers.Contract(t.address, ERC20_ALLOW, ctx.provider);
    for (const sp of spenders) {
      jobs.push((async () => {
        try {
          const amt: bigint = await c.allowance(wallet.address, sp);
          if (amt > 0n) found.push({ kind: "erc20", token: t.address, symbol: t.symbol, spender: sp, amount: amt >= (1n << 255n) ? "unlimited" : amt.toString() });
        } catch { /* token not on this chain / RPC hiccup */ }
        if (sp.toLowerCase() !== PERMIT2.toLowerCase()) {
          try {
            const p2 = new ethers.Contract(PERMIT2, P2_ABI, ctx.provider);
            const r = await p2.allowance(wallet.address, t.address, sp);
            const amt = BigInt(r.amount ?? r[0]); const exp = Number(r.expiration ?? r[1]);
            if (amt > 0n && exp > Math.floor(Date.now() / 1000)) found.push({ kind: "permit2", token: t.address, symbol: t.symbol, spender: sp, amount: amt.toString(), expires: new Date(exp * 1000).toISOString() });
          } catch { /* ignore */ }
        }
      })());
    }
  }
  await Promise.all(jobs);
  const body = found.length
    ? found.map((f) => `- ${f.kind} ${f.symbol} ${f.token} → spender ${f.spender}: ${f.amount}${f.expires ? ` (expires ${f.expires})` : ""}`).join("\n")
    : "No active allowances to known routers/Permit2 found.";
  return text(`## Approvals on ${a.chain === "robinhood" ? "Robinhood Chain" : "Base"} for ${wallet.address}\n${body}`, false, { chainId: ctx.chainId, wallet: wallet.address, approvals: found });
}

async function revokeApproval(a: any): Promise<ToolResult> {
  if (a.chain !== "base" && a.chain !== "robinhood") return text("chain must be base or robinhood.", true);
  if (!ethers.isAddress(String(a.token)) || !ethers.isAddress(String(a.spender))) return text("token and spender must be 0x addresses.", true);
  const via = a.via === "permit2" ? "permit2" : "erc20";
  const ctx = await chainCtx(a.chain);
  const params = { chain: a.chain, token: String(a.token), spender: String(a.spender), via };
  if (a.confirm !== true || !consumeQuote(a.quoteId, "approvals_revoke", ctx.chainId, params)) {
    const quoteId = issueQuoteId("approvals_revoke", ctx.chainId, params);
    return text(
      `⛔ NOT EXECUTED — confirmation required. Revoke ${via} allowance of token ${a.token} for spender ${a.spender} on chain ${ctx.chainId} (gas only, no tokens move).\n` +
      `quoteId: ${quoteId}. Re-run the SAME call with confirm:true and quoteId:"${quoteId}".`,
      true, { executed: false, status: "preview", txHash: null, chainId: ctx.chainId, quoteId });
  }
  const wallet = await getOrCreateWallet();
  const signer = wallet.connect(ctx.provider);
  try {
    const tx = via === "permit2"
      ? await new ethers.Contract(PERMIT2, P2_ABI, signer).approve(a.token, a.spender, 0n, 0)
      : await new ethers.Contract(String(a.token), ERC20_ALLOW, signer).approve(a.spender, 0n);
    const rc = await tx.wait();
    const ok = rc?.status === 1;
    return text(`${ok ? "✅ Revoked" : "❌ Revoke reverted"}. Tx: ${ctx.explorer}/tx/${tx.hash}`, !ok, { executed: true, txHash: tx.hash, status: ok ? "confirmed" : "reverted", chainId: ctx.chainId });
  } catch (e: any) {
    return text(`Revoke failed: ${e?.shortMessage ?? e?.message ?? e}`, true, { executed: false, txHash: null, status: "failed", chainId: ctx.chainId });
  }
}

export async function handlePolicyTool(name: string, args: unknown): Promise<ToolResult | null> {
  const a = (args ?? {}) as any;
  try {
    switch (name) {
      case "wallet_policy": {
        const action = a.action ?? "show";
        if (action === "show") return showPolicy();
        if (action === "kill") { setKillSwitch(true); return text(`🛑 Kill-switch engaged. All spending is stopped. Only the operator can release it (delete ${killSwitchFile()} and unset FINCH_SPEND_DISABLED).`); }
        if (action === "set") return applyPolicyChange(a);
        return text("action must be show, set or kill.", true);
      }
      case "approvals_list": return await listApprovals(a);
      case "approvals_revoke": return await revokeApproval(a);
      default: return null;
    }
  } catch (e: any) {
    return text(`${name} failed: ${e?.message ?? e}`, true);
  }
}
export { isKilled };
