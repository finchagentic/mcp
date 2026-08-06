import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
import { getOrCreateWallet, signAndBroadcast, waitForReceipt } from "../wallet.js";
import { ToolResult } from "../types.js";
import { decimalsFor } from "../token-decimals.js";

export const DEFI_TOOLS: Tool[] = [
  {
    name: "get_defi_yields",
    description:
      "Fetch top DeFi yield opportunities on Base - Morpho, Moonwell, Aerodrome, Uniswap, and more. " +
      "Returns APY, TVL, and pool info aggregated from DeFiLlama (no API key required) - broadest " +
      "protocol coverage, but DeFiLlama's numbers can lag the protocol's own API by hours. Good first " +
      "stop for comparing across protocols. For the freshest Morpho-vault-specific numbers use " +
      "base_mcp_yield_vaults instead; for the freshest Moonwell supply/borrow rates use " +
      "base_mcp_lending_rates instead - both query the protocol directly. " +
      "Filter by token or minimum APY. Use before depositing to find the best rates.",
    inputSchema: {
      type: "object",
      properties: {
        token:  { type: "string", description: "Optional: filter by token symbol, e.g. 'USDC', 'ETH', 'WETH'" },
        minApy: { type: "number", description: "Optional: minimum APY % to show (default 1)" },
        limit:  { type: "number", description: "Max results to return (default 20)" },
      },
      required: [],
    },
  },
];

const SwapSchema = z.object({
  fromToken: z.string().min(1),
  toToken: z.string().min(1),
  amount: z.string().min(1),
  maxSlippagePct: z.number().positive().max(50).optional(),
  maxPriceImpactPct: z.number().positive().max(50).optional(),
});

const DEFAULT_MAX_SLIPPAGE_PCT = 1.0;
const DEFAULT_MAX_PRICE_IMPACT_PCT = 3.0;
const SendSchema = z.object({ token: z.string().min(1), toAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a valid 0x address"), amount: z.string().min(1) });
const DefiYieldsSchema = z.object({
  token:  z.string().optional(),
  minApy: z.number().optional(),
  limit:  z.number().int().min(1).max(100).optional(),
}).default({});

function formatTokenAmount(raw: string, token: string): string {
  const dec = decimalsFor(token);
  // Unknown decimals: show raw units rather than a confidently wrong number.
  if (dec === undefined) return `${raw} (raw units — decimals unknown)`;
  // BigInt math: parseInt on an 18-digit wei string loses precision past
  // MAX_SAFE_INTEGER.
  try {
    const places = dec === 6 ? 2 : 6;
    const scale = 10n ** BigInt(dec);
    const value = BigInt(raw);
    const whole = value / scale;
    const frac = (value % scale).toString().padStart(dec, "0").slice(0, places);
    return places > 0 ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return raw;
  }
}

// Structured output builder for get_defi_yields (schema in output-schemas.ts).
export function buildDefiYields(token: string | undefined, minApy: number, pools: any[]): Record<string, unknown> {
  return {
    token: token ? token.toUpperCase() : null,
    minApy,
    count: pools.length,
    pools: pools.map((p) => ({
      symbol: p.symbol ?? p.pool ?? null,
      project: p.project ?? null,
      apyPct: p.apy ?? null,
      tvlUsd: p.tvlUsd ?? null,
      chain: p.chain ?? null,
    })),
  };
}

export async function handleDefiTool(name: string, args: unknown): Promise<ToolResult | null> {
  switch (name) {
    case "get_portfolio": {
      const result = await callConvex("/mcp/defi/portfolio", "GET", undefined, "get_portfolio");
      if (result.error) return { content: [{ type: "text", text: `Portfolio fetch failed: ${result.error}` }], isError: true };

      const balances: any[] = result.balances ?? [];
      const totalUsd: number = result.totalUsd ?? result.totalValueUsd ?? balances.reduce((s: number, b: any) => s + (b.valueUsd ?? 0), 0);

      if (!balances.length) {
        return { content: [{ type: "text", text: "Your wallet has no tokens yet. Send ETH or USDC on Base to get started." }] };
      }

      const lines = [`**Portfolio** - Total: $${totalUsd.toFixed(2)}`, ""];
      for (const b of balances) {
        const value = b.valueUsd != null ? ` ($${Number(b.valueUsd).toFixed(2)})` : "";
        lines.push(`• **${b.token ?? b.symbol}**: ${Number(b.balance ?? b.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })}${value}`);
      }
      lines.push("", `Wallet: \`${result.address ?? "unknown"}\``);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "estimate_swap": {
      const parsed = SwapSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${String(parsed.error.issues[0].path[0])}: ${parsed.error.issues[0].message}` }], isError: true };
      const { fromToken, toToken, amount, maxSlippagePct, maxPriceImpactPct } = parsed.data;
      const slippageLimit = maxSlippagePct ?? DEFAULT_MAX_SLIPPAGE_PCT;
      const impactLimit = maxPriceImpactPct ?? DEFAULT_MAX_PRICE_IMPACT_PCT;
      // Pass the MCP local wallet as the swap taker so 0x routes output back
      // to the wallet that's signing - not the backend's custodial wallet.
      const localWallet = await getOrCreateWallet();
      const result = await callConvex("/mcp/defi/swap", "POST", { fromToken, toToken, amount, taker: localWallet.address, slippagePercentage: slippageLimit / 100 }, "swap_tokens");
      if (!result.success) return { content: [{ type: "text", text: `Estimate failed: ${result.error}` }], isError: true };

      const q = result.quote;
      const buyHuman = formatTokenAmount(q.buyAmount, q.buyToken ?? toToken);
      const sellHuman = formatTokenAmount(q.sellAmount ?? "0", q.sellToken ?? fromToken);
      const impactPct = q.estimatedPriceImpact != null ? Number(q.estimatedPriceImpact) : 0;
      const priceImpact = q.estimatedPriceImpact != null ? `${impactPct.toFixed(3)}%` : "< 0.01%";
      const impactWarning = impactPct > impactLimit
        ? `\n⚠️ **Price impact ${impactPct.toFixed(2)}% exceeds limit ${impactLimit}%** - \`swap_tokens\` will refuse execution. Increase \`maxPriceImpactPct\` to override.`
        : "";

      return {
        content: [{
          type: "text",
          text: [
            `**Swap Estimate** (not executed)`,
            ``,
            `You sell: **${sellHuman} ${(q.sellToken ?? fromToken).toUpperCase()}**`,
            `You get:  **~${buyHuman} ${(q.buyToken ?? toToken).toUpperCase()}**`,
            `Price impact: ${priceImpact}`,
            `Slippage cap: ${slippageLimit}% · Price-impact cap: ${impactLimit}%`,
            impactWarning,
            ``,
            `Run \`swap_tokens\` with the same params to execute.`,
          ].join("\n"),
        }],
      };
    }

    case "swap_tokens": {
      const parsed = SwapSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${String(parsed.error.issues[0].path[0])}: ${parsed.error.issues[0].message}` }], isError: true };
      const { fromToken, toToken, amount, maxSlippagePct, maxPriceImpactPct } = parsed.data;
      const slippageLimit = maxSlippagePct ?? DEFAULT_MAX_SLIPPAGE_PCT;
      const impactLimit = maxPriceImpactPct ?? DEFAULT_MAX_PRICE_IMPACT_PCT;
      const wallet = await getOrCreateWallet();
      const result = await callConvex("/mcp/defi/swap", "POST", { fromToken, toToken, amount, taker: wallet.address, slippagePercentage: slippageLimit / 100 }, "swap_tokens");
      if (!result.success) return { content: [{ type: "text", text: `Swap failed: ${result.error}` }], isError: true };

      const q = result.quote;
      const impactPct = q.estimatedPriceImpact != null ? Number(q.estimatedPriceImpact) : 0;
      if (impactPct > impactLimit) {
        return {
          content: [{
            type: "text",
            text: [
              `🛑 **Swap refused - price impact too high.**`,
              ``,
              `Quoted price impact: **${impactPct.toFixed(3)}%**`,
              `Configured cap:      **${impactLimit}%**`,
              ``,
              `Override by passing \`maxPriceImpactPct: ${Math.ceil(impactPct) + 1}\` if you understand the risk,`,
              `or reduce \`amount\` to lower the impact.`,
            ].join("\n"),
          }],
          isError: true,
        };
      }

      const txHash = await signAndBroadcast(wallet, q);
      const buyAmountHuman = formatTokenAmount(q.buyAmount, q.buyToken ?? toToken);
      const receipt = await waitForReceipt(txHash);
      const header = !receipt.mined
        ? `⏳ Broadcast, not yet confirmed within the wait window.`
        : receipt.ok
          ? `✅ Swap confirmed on-chain (block ${receipt.blockNumber}).`
          : `❌ Transaction REVERTED - no swap occurred (gas was still spent).`;
      return {
        content: [{
          type: "text",
          text: [
            header,
            `${amount} ${fromToken.toUpperCase()} → ${receipt.mined && receipt.ok ? buyAmountHuman : "(quoted, not received)"} ${q.buyToken}`,
            `Slippage cap: ${slippageLimit}% · Price impact: ${impactPct.toFixed(3)}%`,
            `Tx Hash: \`${txHash}\``,
            `https://basescan.org/tx/${txHash}`,
            !receipt.mined ? `Check the link above before telling the user this succeeded or failed.` : "",
          ].filter(Boolean).join("\n"),
        }],
        isError: receipt.mined && !receipt.ok,
      };
    }

    case "send_token": {
      const parsed = SendSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${String(parsed.error.issues[0].path[0])}: ${parsed.error.issues[0].message}` }], isError: true };
      const { token, toAddress, amount } = parsed.data;
      const wallet = await getOrCreateWallet();
      const result = await callConvex("/mcp/defi/send", "POST", parsed.data, "send_token");
      if (!result.success) return { content: [{ type: "text", text: `Send failed: ${result.error}` }], isError: true };
      const txHash = await signAndBroadcast(wallet, result.txData);
      const receipt = await waitForReceipt(txHash);
      const header = !receipt.mined
        ? `⏳ Broadcast, not yet confirmed within the wait window.`
        : receipt.ok
          ? `✅ Sent - confirmed on-chain (block ${receipt.blockNumber}).`
          : `❌ Transaction REVERTED - funds were NOT sent (gas was still spent).`;
      return {
        content: [{
          type: "text",
          text: [
            header,
            `${amount} ${token.toUpperCase()} → \`${toAddress}\``,
            `Tx Hash: \`${txHash}\``,
            `https://basescan.org/tx/${txHash}`,
            !receipt.mined ? `Check the link above before telling the user this succeeded or failed.` : "",
          ].filter(Boolean).join("\n"),
        }],
        isError: receipt.mined && !receipt.ok,
      };
    }

    // analyze_wallet was removed - it called POST /wallet/analyze, which was
    // never registered in app/convex/http.ts (only a dangling section-header
    // comment exists there). The tool was never in the exported DEFI_TOOLS
    // list either, so this case was already unreachable dead code - no Tool
    // registers the name "analyze_wallet" for the MCP dispatcher to route to.

    case "get_defi_yields": {
      const parsed = DefiYieldsSchema.safeParse(args ?? {});
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };

      const { token, minApy = 1, limit = 20 } = parsed.data;

      let pools: any[];
      try {
        const res = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as any;
        pools = data.data ?? [];
      } catch (e: any) {
        return { content: [{ type: "text", text: `DeFiLlama fetch failed: ${e.message}` }], isError: true };
      }

      // Filter to Base chain
      let filtered = pools.filter((p: any) => p.chain === "Base");

      // Filter by token if specified
      if (token) {
        const upper = token.toUpperCase();
        filtered = filtered.filter((p: any) =>
          (p.symbol ?? "").toUpperCase().includes(upper) ||
          (p.underlyingTokens ?? []).some((t: string) => t.toUpperCase().includes(upper))
        );
      }

      // Filter by minimum APY and remove outliers (>10000% are usually broken)
      filtered = filtered
        .filter((p: any) => (p.apy ?? 0) >= minApy && (p.apy ?? 0) <= 10_000)
        .sort((a: any, b: any) => (b.apy ?? 0) - (a.apy ?? 0))
        .slice(0, limit);

      if (!filtered.length) {
        return {
          content: [{
            type: "text",
            text: [
              `## DeFi Yields on Base`,
              `No pools found${token ? ` for ${token.toUpperCase()}` : ""} with APY ≥ ${minApy}%.`,
              ``,
              `Try lowering \`minApy\` or removing the token filter.`,
            ].join("\n"),
          }],
          structuredContent: buildDefiYields(token, minApy, []),
        };
      }

      const fmt = (n: number) => n >= 1_000_000_000 ? `$${(n / 1_000_000_000).toFixed(1)}B`
        : n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K`
        : `$${n.toFixed(0)}`;

      const lines = [
        `## DeFi Yields on Base${token ? ` - ${token.toUpperCase()}` : ""}`,
        `Top ${filtered.length} pools · APY ≥ ${minApy}% · Source: DeFiLlama`,
        ``,
        `| # | Pool | Protocol | APY | TVL |`,
        `|---|------|----------|-----|-----|`,
      ];

      filtered.forEach((p: any, i: number) => {
        const apy  = (p.apy ?? 0).toFixed(1);
        const tvl  = fmt(p.tvlUsd ?? 0);
        const name = (p.symbol ?? p.pool ?? "-").replace(/-/g, " ");
        const proj = p.project ?? "-";
        lines.push(`| ${i + 1} | ${name} | ${proj} | **${apy}%** | ${tvl} |`);
      });

      lines.push(``, `Use \`swap_tokens\` to position, then deposit via the protocol's UI. Always check smart contract risk before depositing.`);

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: buildDefiYields(token, minApy, filtered) };
    }

    default:
      return null;
  }
}
