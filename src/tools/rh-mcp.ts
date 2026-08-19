// Robinhood Chain MCP — `rh_mcp_*` namespace (parity with `base_mcp_*`).
// Tokenized equities on chainId 4663 via Finch Uni V4 (NOT 0x equities,
// NOT Robinhood Agentic brokerage MCP at agent.robinhood.com).
//
// Quote path: Convex `walletActions.zeroXQuote({ chainId: 4663 })` → Uni V4
// (direct ETH↔stock or multi-hop ETH↔USDG↔stock for thin pairs like BE).
//
// Swap execute: local MCP wallet signs on RH RPC. Buys (ETH→stock) work in one
// tx. Sells need 2-step Permit2 (ERC20→Permit2, Permit2→Universal Router).
//
// This file is the entry point only: tool definitions, low-level RPC/DEX,
// resolution, risk/safety scoring and swap execution each live in their own
// rh-mcp-*.ts sibling module. Kept at this exact path/name so server.ts and
// every other caller's `./rh-mcp.js` import needs no change.

import { ethers } from "ethers";
import { ToolResult } from "../types.js";
import { getOrCreateWallet } from "../wallet.js";
import { handleWalletTool } from "./wallet.js";

import { RH_CHAIN_ID, RH_EXPLORER, RH_STOCKS, RH_PERMIT2, rhRpcDisplay } from "./rh-mcp-constants.js";
import { dexTokenBest, dexSearchByTicker, badQuoteWarning, quoteValueRatio } from "./rh-mcp-dex.js";
import { rhRpc, rhErc20Balance, rhPriceUsd, rhProviderAsync, formatWei } from "./rh-mcp-provider.js";
import { isAddress, resolveTokenSmart, fetchRhBalances } from "./rh-mcp-resolve.js";
import {
  assessRisk,
  renderResolveList,
  renderResolveOne,
  buildRhAnalysis,
  buildRhStocksList,
  renderAnalysis,
} from "./rh-mcp-risk.js";
import { blockscoutSafety, assessSafety, buildRhSafetyStructured, renderSafety } from "./rh-mcp-safety.js";
import { quoteRh, ensureDirectApproval, ensureSellApprovals, confirmRhSwap, broadcastRhSwap } from "./rh-mcp-swap.js";

export { RH_MCP_TOOLS } from "./rh-mcp-tools.js";
export { RH_CHAIN_ID, RH_RPC, RH_EXPLORER, RH_STOCKS } from "./rh-mcp-constants.js";
export { dexTokenBest } from "./rh-mcp-dex.js";
export type { DexPair, ResolvedToken } from "./rh-mcp-dex.js";
export { resolveTokenSmart } from "./rh-mcp-resolve.js";
export { rhProviderAsync, rhErc20Balance, rhPriceUsd } from "./rh-mcp-provider.js";
export { buildRhAnalysis, buildRhStocksList } from "./rh-mcp-risk.js";
export { buildRhSafetyStructured } from "./rh-mcp-safety.js";
export type { RhLaunchpad } from "./rh-mcp-safety.js";

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export async function handleRhMcpTool(name: string, args: unknown): Promise<ToolResult | null> {
  const a = (args ?? {}) as any;

  switch (name) {
    case "rh_mcp_status": {
      const walletRes = await handleWalletTool("get_wallet_address", {}).catch(() => null);
      const text = walletRes?.content?.[0]?.text ?? "";
      const addr = text.match(/0x[a-fA-F0-9]{40}/)?.[0];
      let eth = "?";
      if (addr) {
        try {
          const hex = await rhRpc("eth_getBalance", [addr, "latest"]);
          eth = (Number(BigInt(hex)) / 1e18).toFixed(6);
        } catch (e: any) {
          eth = `error: ${e?.message ?? "rpc"}`;
        }
      }
      return textResult(
        [
          "## 🟢 Robinhood Chain MCP - Status",
          "",
          "**Rail**: Robinhood Chain · chainId **4663** · Uniswap V4 tokenized stocks",
          "**Not**: Robinhood Agentic brokerage (`agent.robinhood.com/mcp/trading`)",
          "**Not**: Base `base_mcp_*` (chain 8453)",
          "",
          `**Wallet**: \`${addr ?? "(not configured — run finch login / first tool)"}\``,
          `**ETH on RH (gas)**: ${eth}`,
          `**RPC**: ${rhRpcDisplay()}`,
          `**Explorer**: ${RH_EXPLORER}`,
          `**Catalog**: ${RH_STOCKS.length} stocks (AAPL…USAR) + any RH-chain crypto via DexScreener`,
          "",
          "Tools: `rh_token_resolve` · `rh_analyze` · `rh_safety_check` · `rh_mcp_estimate` · `rh_mcp_swap` · `rh_dca_create` · `rh_bracket_create` · `rh_orders_tick`",
        ].join("\n")
      );
    }

    case "rh_mcp_list_stocks": {
      const q = (a.query ?? "").toString().trim().toLowerCase();
      const rows = RH_STOCKS.filter(
        (s) =>
          !q ||
          s.symbol.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.address.toLowerCase().includes(q)
      );
      const lines = [
        `## 🟢 RH stocks (${rows.length}/${RH_STOCKS.length})`,
        "",
        "| Symbol | Name | Address |",
        "|--------|------|---------|",
        ...rows.map((s) => `| **${s.symbol}** | ${s.name} | \`${s.address}\` |`),
        "",
        "Quote/swap: `rh_mcp_estimate` / `rh_mcp_swap` with fromToken=ETH toToken=NVDA (etc).",
        "Thin pairs (e.g. BE) auto multi-hop via USDG.",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: buildRhStocksList(rows),
      };
    }

    case "rh_mcp_balance": {
      let address = (a.address ?? "").toString();
      if (!address || !isAddress(address)) {
        const walletRes = await handleWalletTool("get_wallet_address", {}).catch(() => null);
        const text = walletRes?.content?.[0]?.text ?? "";
        const m = text.match(/0x[a-fA-F0-9]{40}/);
        if (!m) return textResult("Wallet not configured. Run finch login first.", true);
        address = m[0];
      }
      const body = await fetchRhBalances(address);
      return textResult(`## 🟢 Robinhood Chain MCP - Balance\n\n${body}`);
    }

    case "rh_mcp_estimate": {
      if (!a.fromToken || !a.toToken || !a.amount) {
        return textResult("Required: fromToken, toToken, amount", true);
      }
      try {
        const wallet = await getOrCreateWallet();
        const q = await quoteRh({
          fromToken: a.fromToken,
          toToken: a.toToken,
          amount: String(a.amount),
          maxSlippagePct: a.maxSlippagePct,
          taker: wallet.address,
        });
        const buyHuman = formatWei(q.quote?.buyAmount ?? q.buyAmount ?? "0", q.to.decimals);
        const route = q.quote?.route ?? q.route ?? "uniswap-v4";
        const pool = q.quote?.pool ?? q.pool;
        const buyNum = Number(
          ethers.formatUnits(q.quote?.buyAmount ?? q.buyAmount ?? "0", q.to.decimals)
        );
        const warn = badQuoteWarning(
          await quoteValueRatio(q.from, q.to, String(a.amount), buyNum),
          q.to.symbol
        );
        return textResult(
          [
            `**RH Swap Estimate** (not executed) · chainId ${RH_CHAIN_ID}`,
            ``,
            warn ? warn + "\n" : "",
            `You sell: **${a.amount} ${q.from.symbol}**`,
            `You get:  **~${buyHuman} ${q.to.symbol}**`,
            `Token: \`${q.from.kind === "token" ? q.from.address : q.to.address}\` ⚠️ verify this is the intended contract`,
            `Route: \`${route}\`${pool?.via ? ` via ${pool.via}` : ""}${pool?.quote ? ` · pair quote ${pool.quote}` : ""}`,
            (() => {
              const rc = q.quote?.routesConsidered ?? q.routesConsidered;
              if (!rc) return "";
              const fmt = (v: string | null) =>
                v ? formatWei(v, q.to.decimals) : "no pool";
              return `Compared: V2 ${fmt(rc.v2)} · V3 ${fmt(rc.v3)} · V4 ${fmt(rc.v4)} → best wins`;
            })(),
            `Slippage: ${a.maxSlippagePct ?? 2.0}%`,
            pool?.liquidityUsd != null ? `Pool liq (approx): $${Number(pool.liquidityUsd).toLocaleString()}` : "",
            ``,
            `Run \`rh_mcp_swap\` with same params + \`confirm: true\` to execute.`,
            `Explorer quote context: ${RH_EXPLORER}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (e: any) {
        return textResult(`Estimate failed: ${e?.message ?? e}`, true);
      }
    }

    case "rh_mcp_swap": {
      if (!a.fromToken || !a.toToken || !a.amount) {
        return textResult("Required: fromToken, toToken, amount, confirm", true);
      }
      if (a.confirm !== true) {
        return textResult(
          "Refusing to broadcast: pass `confirm: true` after reviewing `rh_mcp_estimate`.",
          true
        );
      }
      try {
        const wallet = await getOrCreateWallet();
        const q = await quoteRh({
          fromToken: a.fromToken,
          toToken: a.toToken,
          amount: String(a.amount),
          maxSlippagePct: a.maxSlippagePct,
          taker: wallet.address,
          toolName: "rh_mcp_swap",
        });
        const quote = q.quote ?? q;
        const tx = quote.transaction ?? {
          to: quote.to,
          data: quote.data,
          value: quote.value,
          gas: quote.gas,
        };
        if (!tx?.to || !tx?.data) {
          return textResult("Quote missing transaction calldata.", true);
        }

        // Hard stop on catastrophic pricing (empty V4 path). Requires an explicit
        // acceptBadPrice override so a value-destroying swap can never be a default.
        const buyNum = Number(ethers.formatUnits(quote.buyAmount ?? "0", q.to.decimals));
        const priceWarn = badQuoteWarning(
          await quoteValueRatio(q.from, q.to, String(a.amount), buyNum),
          q.to.symbol
        );
        if (priceWarn && a.acceptBadPrice !== true) {
          return textResult(
            `${priceWarn}\n\n**Refusing to broadcast.** If you truly intend to accept this ` +
              `rate, re-run with \`acceptBadPrice: true\`.`,
            true
          );
        }

        const approveHashes: string[] = [];
        if (q.from.kind === "token") {
          // Approval target depends on the route the quoter picked:
          //   V4  → Permit2 two-step (ERC20→Permit2, Permit2→UniversalRouter)
          //   V2/V3 → plain ERC-20 approve to SwapRouter02 (it uses transferFrom)
          // Hardcoding the V4 path here silently broke every V2/V3 sell.
          const spender: string =
            quote.allowanceTarget ?? quote.issues?.allowance?.spender ?? RH_PERMIT2;
          const hashes =
            spender.toLowerCase() === RH_PERMIT2.toLowerCase()
              ? await ensureSellApprovals(wallet, q.from.address, BigInt(q.sellAmount))
              : await ensureDirectApproval(
                  wallet,
                  q.from.address,
                  spender,
                  BigInt(q.sellAmount)
                );
          approveHashes.push(...hashes);
        }

        // Snapshot ETH before broadcasting so a sell can report what actually landed.
        let ethBefore: bigint | null = null;
        if (q.to.kind === "eth") {
          try {
            ethBefore = BigInt(await rhRpc("eth_getBalance", [wallet.address, "latest"]));
          } catch {
            /* optional */
          }
        }

        const txHash = await broadcastRhSwap(wallet, tx);
        const buyHuman = formatWei(quote.buyAmount ?? "0", q.to.decimals);
        const route = quote.route ?? "uniswap-v4";
        const rc = await confirmRhSwap(txHash, wallet.address, q.to, ethBefore);

        const header = !rc.mined
          ? `⏳ RH swap broadcast — not yet confirmed`
          : rc.ok
          ? `✅ RH swap CONFIRMED on-chain`
          : `❌ RH swap REVERTED on-chain`;

        const actual =
          rc.received != null
            ? `**Actually received: ${Number(rc.received).toLocaleString(undefined, {
                maximumFractionDigits: 6,
              })} ${q.to.symbol}** (quoted ~${buyHuman})`
            : `Quoted: ~${buyHuman} ${q.to.symbol}`;

        return textResult(
          [
            header,
            ``,
            `**Sent:** ${a.amount} ${q.from.symbol}`,
            actual,
            `**Token:** \`${q.from.kind === "token" ? q.from.address : q.to.address}\``,
            `**Route:** \`${route}\``,
            approveHashes.length
              ? `**Approval tx:** ${approveHashes.map((h) => `\`${h}\``).join(", ")}`
              : "",
            ``,
            `### Proof`,
            `**Tx hash:** \`${txHash}\``,
            rc.mined ? `**Status:** ${rc.ok ? "success (status 1)" : "reverted (status 0)"}` : "",
            rc.block != null ? `**Block:** ${rc.block}` : "",
            rc.gasUsed ? `**Gas used:** ${Number(rc.gasUsed).toLocaleString()}` : "",
            `**Verify:** ${RH_EXPLORER}/tx/${txHash}`,
            ``,
            !rc.mined
              ? `_Receipt not seen within 90s — the tx may still be pending. Check the explorer link; do not re-send._`
              : rc.ok
              ? `_Figures above are read from the mined receipt, not the quote._`
              : `_The transaction reverted. Funds stay in your wallet minus gas._`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (e: any) {
        return textResult(`Swap failed: ${e?.message ?? e}`, true);
      }
    }

    case "rh_token_resolve": {
      const input = (a.query ?? a.token ?? a.ticker ?? "").toString().trim();
      if (!input) return textResult("Required: query (crypto ticker or 0x contract address)", true);
      try {
        if (isAddress(input)) {
          const dex = await dexTokenBest(input);
          if (!dex) {
            return textResult(
              `No Robinhood-chain pair found for \`${input}\` — it may not be tradeable on chain 4663.`,
              true
            );
          }
          return textResult(renderResolveOne(input, dex));
        }
        const cands = await dexSearchByTicker(input);
        if (!cands.length) {
          return textResult(
            `No Robinhood-chain token matched ticker "${input}". Paste the 0x contract address instead.`,
            true
          );
        }
        return textResult(renderResolveList(input, cands));
      } catch (e: any) {
        return textResult(`Resolve failed: ${e?.message ?? e}`, true);
      }
    }

    case "rh_analyze": {
      const input = (a.token ?? a.query ?? a.ticker ?? "").toString().trim();
      if (!input) return textResult("Required: token (crypto ticker or 0x contract address)", true);
      try {
        const resolved = await resolveTokenSmart(input);
        const dex = resolved.dex ?? (await dexTokenBest(resolved.address));
        if (!dex) {
          return textResult(
            `No DexScreener market data on Robinhood chain for \`${resolved.address}\`.`,
            true
          );
        }
        const assessment = assessRisk(dex);
        return {
          content: [{ type: "text", text: renderAnalysis(resolved, dex, assessment) }],
          structuredContent: buildRhAnalysis(resolved, dex, assessment),
        };
      } catch (e: any) {
        return textResult(`Analyze failed: ${e?.message ?? e}`, true);
      }
    }

    case "rh_safety_check": {
      const input = (a.token ?? a.query ?? a.ticker ?? "").toString().trim();
      if (!input) return textResult("Required: token (crypto ticker or 0x contract address)", true);
      try {
        const resolved = await resolveTokenSmart(input);
        const [safety, dex] = await Promise.all([
          blockscoutSafety(resolved.address),
          resolved.dex ? Promise.resolve(resolved.dex) : dexTokenBest(resolved.address),
        ]);
        const assessment = assessSafety(safety, dex);
        return {
          content: [{ type: "text", text: renderSafety(resolved, safety, assessment) }],
          structuredContent: buildRhSafetyStructured(resolved, safety, assessment),
        };
      } catch (e: any) {
        return textResult(`Safety check failed: ${e?.message ?? e}`, true);
      }
    }

    default:
      return null;
  }
}
