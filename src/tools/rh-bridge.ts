// Tokenized stock ↔ real equity comparison on Robinhood Chain.
//
// Robinhood Chain exists to trade equities 24/7 on-chain, but the two prices
// drift: the token trades continuously against a shallow pool while the real
// share only prices during market hours. That gap is the whole point of the
// bridge — and it matters to both sides. An equity trader wants to know whether
// after-hours exposure is fairly priced; an on-chain trader wants to know when
// the token has detached from the asset it represents.
//
// The gap alone is not an opportunity: a 20% premium on a $100k pool you cannot
// exit is a trap, so pool depth is reported next to every quote.

import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { RH_STOCKS, dexTokenBest, RH_EXPLORER } from "./rh-mcp.js";

export const BRIDGE_TOOLS: Tool[] = [
  {
    name: "rh_stock_bridge",
    description:
      "Compare a tokenized stock on Robinhood Chain (4663) against the real US equity: " +
      "on-chain price vs live share price, the premium/discount between them, pool depth, " +
      "and whether the US market is currently open. Covers the 22 tokenized tickers " +
      "(NVDA, TSLA, AAPL, COIN…). Omit `ticker` to scan all of them at once. " +
      "No API key needed. Reports the gap and the depth — it does not tell you to trade it.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: {
          type: "string",
          description: "Tokenized stock symbol, e.g. 'NVDA'. Omit to scan every tokenized stock.",
        },
        minGapPct: {
          type: "number",
          description: "When scanning, only show names whose gap exceeds this (default 0 = show all)",
        },
      },
      required: [],
    },
  },
];

const Schema = z.object({
  ticker: z.string().min(1).max(10).optional(),
  minGapPct: z.number().min(0).max(100).optional(),
});

type Row = {
  symbol: string;
  name: string;
  address: string;
  onchain: number | null;
  real: number | null;
  gapPct: number | null;
  liquidityUsd: number;
  marketState?: string;
};

async function realQuote(symbol: string): Promise<{ price: number; state: string } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) }
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    const m = j?.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return null;
    // The chart endpoint carries no `marketState`, so derive it: during the
    // regular session `regularMarketTime` keeps advancing, and once the bell
    // rings it freezes at the close. A recent timestamp means live pricing.
    const ts = Number(m.regularMarketTime) * 1000;
    const ageMin = isFinite(ts) ? (Date.now() - ts) / 60_000 : Infinity;
    return { price: m.regularMarketPrice, state: ageMin <= 20 ? "REGULAR" : "CLOSED" };
  } catch {
    return null;
  }
}

async function buildRow(s: { symbol: string; name: string; address: string }): Promise<Row> {
  const [dex, rq] = await Promise.all([dexTokenBest(s.address), realQuote(s.symbol)]);
  const onchain = dex?.priceUsd != null ? Number(dex.priceUsd) : null;
  const real = rq?.price ?? null;
  const gapPct =
    onchain != null && real != null && real > 0 ? ((onchain - real) / real) * 100 : null;
  return {
    symbol: s.symbol,
    name: s.name,
    address: s.address,
    onchain: onchain != null && isFinite(onchain) ? onchain : null,
    real,
    gapPct,
    liquidityUsd: dex?.liquidity?.usd ?? 0,
    marketState: rq?.state,
  };
}

function gapTag(gap: number, liq: number): string {
  const a = Math.abs(gap);
  if (a < 1) return "🟢 tracking";
  if (a < 3) return "🟡 minor drift";
  if (liq < 50_000) return "🟠 wide — but the pool is thin";
  return "🔴 wide";
}

export async function handleBridgeTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "rh_stock_bridge") return null;

  const parsed = Schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
  }
  const wanted = parsed.data.ticker?.trim().toUpperCase();
  const minGap = parsed.data.minGapPct ?? 0;

  const targets = wanted ? RH_STOCKS.filter((s) => s.symbol === wanted) : RH_STOCKS;
  if (wanted && targets.length === 0) {
    return {
      content: [{
        type: "text",
        text:
          `**${wanted}** is not a tokenized stock on Robinhood Chain.\n\n` +
          `Available: ${RH_STOCKS.map((s) => s.symbol).join(", ")}`,
      }],
      isError: true,
    };
  }

  const rows = await Promise.all(targets.map(buildRow));
  const usable = rows.filter((r) => r.gapPct != null);
  const marketState = usable.find((r) => r.marketState)?.marketState ?? "UNKNOWN";
  const marketOpen = marketState === "REGULAR";

  const lines: string[] = [
    `# Tokenized stock ↔ real equity — Robinhood Chain (4663)`,
    ``,
    `**US market: ${marketOpen ? "🟢 OPEN" : "🔴 CLOSED"}**` +
      (marketOpen
        ? ` — both sides are pricing live, so a gap is a genuine dislocation.`
        : ` — the share price is frozen at the last close while the token keeps trading. ` +
          `A gap here is largely expected and is NOT by itself a mispricing.`),
    ``,
  ];

  // Single-ticker detail view.
  if (wanted && usable.length === 1) {
    const r = usable[0];
    lines.push(
      `## ${r.symbol} — ${r.name}`,
      ``,
      `| | |`,
      `|---|---|`,
      `| On-chain (token) | **$${r.onchain!.toFixed(4)}** |`,
      `| Real share | **$${r.real!.toFixed(2)}** |`,
      `| Gap | **${r.gapPct! >= 0 ? "+" : ""}${r.gapPct!.toFixed(2)}%** ${gapTag(r.gapPct!, r.liquidityUsd)} |`,
      `| Pool depth | $${Math.round(r.liquidityUsd).toLocaleString()} |`,
      `| Token | \`${r.address}\` |`,
      ``,
      `${RH_EXPLORER}/token/${r.address}`,
      ``
    );
  } else {
    const shown = usable
      .filter((r) => Math.abs(r.gapPct!) >= minGap)
      .sort((a, b) => Math.abs(b.gapPct!) - Math.abs(a.gapPct!));
    lines.push(
      `| Ticker | On-chain | Real | Gap | Pool depth |`,
      `|---|---|---|---|---|`,
      ...shown.map(
        (r) =>
          `| **${r.symbol}** | $${r.onchain!.toFixed(2)} | $${r.real!.toFixed(2)} | ` +
          `${r.gapPct! >= 0 ? "+" : ""}${r.gapPct!.toFixed(2)}% ${gapTag(r.gapPct!, r.liquidityUsd)} | ` +
          `$${Math.round(r.liquidityUsd).toLocaleString()} |`
      ),
      ``
    );
    const missing = rows.filter((r) => r.gapPct == null);
    if (missing.length) {
      lines.push(`_No usable quote for: ${missing.map((m) => m.symbol).join(", ")}._`, ``);
    }
  }

  lines.push(
    `---`,
    ``,
    `**Reading this**`,
    ``,
    `- A gap is only tradeable to the depth of the pool. A 20% premium on a $100k pool is not ` +
      `a 20% opportunity — size it against the depth column, then check the real fill with \`rh_mcp_estimate\`.`,
    `- While the US market is closed the token is the only live price. Drift is expected, and it ` +
      `often reflects overnight news the share price has not opened to yet.`,
    `- Buying the token is exposure to the token, not ownership of the share. Redemption terms, ` +
      `custody and counterparty are Robinhood's, not this tool's — and are not verified here.`,
    ``,
    `_Prices: on-chain via DexScreener, share via Yahoo Finance. Not investment advice._`
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
