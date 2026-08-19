import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { cachedFetch } from "../_http-cache.js";
import { pickTokenPair } from "../dex-pair.js";
import { parseOrError } from "../_zod-helpers.js";

const COINGECKO = "https://api.coingecko.com/api/v3";

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
  USDT: "tether", USDC: "usd-coin", XRP: "ripple", DOGE: "dogecoin",
  ADA: "cardano", AVAX: "avalanche-2", DOT: "polkadot", LINK: "chainlink",
  UNI: "uniswap", OP: "optimism", ARB: "arbitrum", PEPE: "pepe",
  SUI: "sui", APT: "aptos", NEAR: "near", INJ: "injective-protocol",
  TIA: "celestia", MATIC: "matic-network", TON: "the-open-network",
  SHIB: "shiba-inu", WIF: "dogwifcoin", BONK: "bonk", HYPE: "hyperliquid",
};

async function cgFetch(path: string): Promise<any> {
  // CoinGecko free tier: 30 req/min. Cache + 429-backoff lives in cachedFetch.
  const res = await cachedFetch(`${COINGECKO}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return JSON.parse(res.text);
}

async function resolveTokenId(query: string): Promise<{ id: string; symbol: string } | null> {
  const upper = query.trim().toUpperCase();
  if (SYMBOL_TO_ID[upper]) return { id: SYMBOL_TO_ID[upper], symbol: upper };
  // Fallback: search CoinGecko - handles any token not in the static map
  try {
    const res = await cgFetch(`/search?query=${encodeURIComponent(query)}`);
    const coin = res.coins?.[0];
    if (coin?.id) return { id: coin.id, symbol: coin.symbol?.toUpperCase() ?? upper };
  } catch { /* search failed - fall through to null */ }
  return null;
}

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n == null) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(4)}`;
}

function fmtB(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${fmt(n)}`;
}

const BASE_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

async function fetchDexscreenerBaseToken(tokenAddress: string): Promise<any | null> {
  const res = await cachedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = JSON.parse(res.text);
  const pairs: any[] = (data?.pairs ?? []).filter((p: any) => p.chainId === "base");
  if (!pairs.length) return null;
  // Deepest pair that our token is actually the BASE of — the deepest pair
  // overall is often one where it is the quote, and every figure on such a pair
  // belongs to the other token.
  return pickTokenPair(pairs, tokenAddress);
}

async function resolveCoingeckoIdByContract(tokenAddress: string): Promise<string | null> {
  try {
    const res = await cgFetch(`/coins/base/contract/${tokenAddress}`);
    return res?.id ?? null;
  } catch {
    return null;
  }
}

export const MARKET_TOOLS: Tool[] = [
  {
    name: "get_market_data",
    description: "Get live crypto market data: top 20 coins by market cap, trending coins, and key prices for BTC/ETH/SOL.",
    inputSchema: {
      type: "object",
      properties: { token: { type: "string", description: "Optional: focus on a specific token, e.g. 'BTC', 'ETH'" } },
      required: [],
    },
  },
  {
    name: "get_token_data",
    description: "Get live market data for a specific token. Returns price, 24h change, market cap, and volume.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "Token to look up, e.g. 'ETH', 'show me SOL', 'PEPE price'" } },
      required: ["question"],
    },
  },
  {
    name: "compare_tokens",
    description:
      "Compare 2–5 tokens side by side - price, 24h/7d change, market cap, volume, and ATH drawdown. " +
      "Ideal for deciding between assets or tracking a portfolio watchlist.",
    inputSchema: {
      type: "object",
      properties: {
        tokens: {
          type: "array",
          items: { type: "string" },
          description: "2–5 token symbols to compare, e.g. ['BTC', 'ETH', 'SOL']",
          minItems: 2,
          maxItems: 5,
        },
      },
      required: ["tokens"],
    },
  },
  {
    name: "market_overview",
    description:
      "Global crypto market snapshot: Fear & Greed Index, BTC dominance, total market cap, DeFi TVL, " +
      "ETH gas, trending tokens, and top sector leaders. Use for a full market briefing.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "token_history",
    description:
      "Get historical price data for a token. Returns OHLC candles for the requested timeframe. " +
      "Use to understand price trends, identify support/resistance levels, or calculate % changes over time.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token symbol, e.g. 'BTC', 'ETH', 'SOL'" },
        days: {
          type: "number",
          description: "Number of days of history (1=24h, 7=7d, 30=30d, 90=90d, 365=1y). Default: 7",
        },
      },
      required: ["token"],
    },
  },
  {
    name: "get_base_token_data",
    description:
      "Get live market data for any Base-chain token by contract address, sourced from DexScreener: " +
      "price, 1h/6h/24h change, volume, liquidity, market cap, FDV, pair age, and website/social links. " +
      "Also checks whether the token is listed on CoinGecko (needed for historical chart data via token_history). " +
      "Works for any Base token including small/new ones that aren't in CoinGecko's listings - use this " +
      "instead of get_token_data when you have a contract address rather than a well-known symbol.",
    inputSchema: {
      type: "object",
      properties: {
        tokenAddress: {
          type: "string",
          description: "Base-chain ERC-20 contract address, e.g. '0x4b524015d54a27d4472f5c59c570730d69499ba3'",
        },
      },
      required: ["tokenAddress"],
    },
  },
];

const GetMarketDataSchema = z.object({ token: z.string().optional() });
const GetTokenDataSchema = z.object({ question: z.string().min(1) });
const CompareTokensSchema = z.object({ tokens: z.array(z.string()).min(2).max(5) });
const TokenHistorySchema = z.object({ token: z.string().min(1), days: z.number().positive().optional() });
const GetBaseTokenDataSchema = z.object({
  tokenAddress: z.string().regex(BASE_ADDRESS_RE, "Must be a valid 0x-prefixed 40-hex-char Base contract address"),
});

// Pure map from a CoinGecko /coins/markets row to the get_token_data
// structuredContent payload. Kept pure so text + structured output share one
// source and it's unit-testable without a network call.
export function buildTokenSnapshot(c: any): Record<string, unknown> {
  return {
    symbol:        c.symbol?.toUpperCase() ?? null,
    name:          c.name ?? null,
    priceUsd:      c.current_price ?? null,
    change24hPct:  c.price_change_percentage_24h ?? null,
    marketCapUsd:  c.market_cap ?? null,
    marketCapRank: c.market_cap_rank ?? null,
    volume24hUsd:  c.total_volume ?? null,
    high24hUsd:    c.high_24h ?? null,
    low24hUsd:     c.low_24h ?? null,
    athUsd:        c.ath ?? null,
    athChangePct:  c.ath_change_percentage ?? null,
    source:        "coingecko",
  };
}

// Pure map from a DexScreener pair (+ optional CoinGecko id) to the
// get_base_token_data structuredContent payload.
export function buildBaseTokenSnapshot(address: string, pair: any, coingeckoId: string | null): Record<string, unknown> {
  const ch = pair.priceChange ?? {};
  const pairAgeDays = pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86_400_000) : null;
  return {
    address,
    symbol:            pair.baseToken?.symbol ?? null,
    name:              pair.baseToken?.name ?? null,
    priceUsd:          pair.priceUsd ? parseFloat(pair.priceUsd) : null,
    change1hPct:       ch.h1 ?? null,
    change6hPct:       ch.h6 ?? null,
    change24hPct:      ch.h24 ?? null,
    volume24hUsd:      pair.volume?.h24 ?? null,
    liquidityUsd:      pair.liquidity?.usd ?? null,
    marketCapUsd:      pair.marketCap ?? null,
    fdvUsd:            pair.fdv ?? null,
    pairAgeDays,
    listedOnCoingecko: !!coingeckoId,
    coingeckoId:       coingeckoId ?? null,
    source:            "dexscreener",
  };
}

// Pure map for compare_tokens: CoinGecko rows (+ unresolved symbols) → the
// structuredContent payload. Includes 7d change, which the single-token
// snapshot doesn't carry.
export function buildTokenComparison(data: any[], unknown: string[]): Record<string, unknown> {
  return {
    count: data.length,
    unknown,
    tokens: data.map((c) => ({
      symbol:        c.symbol?.toUpperCase() ?? null,
      name:          c.name ?? null,
      priceUsd:      c.current_price ?? null,
      change24hPct:  c.price_change_percentage_24h ?? null,
      change7dPct:   c.price_change_percentage_7d_in_currency ?? null,
      marketCapUsd:  c.market_cap ?? null,
      marketCapRank: c.market_cap_rank ?? null,
      volume24hUsd:  c.total_volume ?? null,
      athChangePct:  c.ath_change_percentage ?? null,
    })),
  };
}

export function buildMarketOverview(global: any, fg: any, trendCoins: any[]): Record<string, unknown> {
  return {
    fearGreedValue: fg ? Number(fg.value) : null,
    fearGreedClass: fg?.value_classification ?? null,
    totalMarketCapUsd: global?.total_market_cap?.usd ?? null,
    marketCap24hChangePct: global?.market_cap_change_percentage_24h_usd ?? null,
    btcDominancePct: global?.market_cap_percentage?.btc ?? null,
    ethDominancePct: global?.market_cap_percentage?.eth ?? null,
    defiTvlUsd: global?.total_value_locked?.usd ?? null,
    activeCoins: global?.active_cryptocurrencies ?? null,
    trending: (trendCoins ?? []).slice(0, 7).map((t) => ({
      symbol: t.item?.symbol ?? null,
      name: t.item?.name ?? null,
      rank: t.item?.market_cap_rank ?? null,
    })),
  };
}

export function buildTokenHistory(
  symbol: string, days: number, current: any,
  openPrice: number, closePrice: number, periodHigh: number, periodLow: number,
  candles: [number, number, number, number, number][],
): Record<string, unknown> {
  return {
    symbol, days,
    currentPriceUsd: current?.current_price ?? null,
    openPrice, closePrice,
    periodChangePct: openPrice ? ((closePrice - openPrice) / openPrice) * 100 : null,
    periodHighUsd: periodHigh,
    periodLowUsd: periodLow,
    candles: candles.slice(-30).map(([ts, o, h, l, cl]) => ({
      date: new Date(ts).toISOString().slice(0, 10), open: o, high: h, low: l, close: cl,
    })),
  };
}

export interface MarketSnapshot {
  btc: number; eth: number; sol: number;
  btcChange: number; ethChange: number; solChange: number;
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot | null> {
  try {
    const data = await cgFetch("/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&sparkline=false&price_change_percentage=24h");
    const find = (id: string, field: string) => data.find((c: any) => c.id === id)?.[field] ?? 0;
    return {
      btc: find("bitcoin", "current_price"),
      eth: find("ethereum", "current_price"),
      sol: find("solana", "current_price"),
      btcChange: find("bitcoin", "price_change_percentage_24h"),
      ethChange: find("ethereum", "price_change_percentage_24h"),
      solChange: find("solana", "price_change_percentage_24h"),
    };
  } catch {
    return null;
  }
}

export async function handleMarketTool(name: string, args: unknown): Promise<ToolResult | null> {
  switch (name) {
    case "get_market_data": {
      const parsed = parseOrError(GetMarketDataSchema, args ?? {});
      if (!parsed.ok) return parsed.error;

      const { token } = parsed.data;

      if (token) {
        const resolved = await resolveTokenId(token);
        if (!resolved) return { content: [{ type: "text", text: `Token not found: "${token}". Try a full name like "pepe" or a known symbol.` }], isError: true };
        const { id, symbol: sym } = resolved;
        const data = await cgFetch(`/coins/markets?vs_currency=usd&ids=${id}&sparkline=false&price_change_percentage=24h`);
        const c = data[0];
        if (!c) return { content: [{ type: "text", text: `No data for ${sym}` }], isError: true };
        const sign = (c.price_change_percentage_24h ?? 0) >= 0 ? "+" : "";
        const lines = [
          `**${c.symbol?.toUpperCase()} - ${c.name}**`,
          `Price: ${fmtPrice(c.current_price)} (${sign}${fmt(c.price_change_percentage_24h)}% 24h)`,
          `Market Cap: ${fmtB(c.market_cap)} (rank #${c.market_cap_rank ?? "-"})`,
          `Volume 24h: ${fmtB(c.total_volume)}`,
          `High/Low 24h: ${fmtPrice(c.high_24h)} / ${fmtPrice(c.low_24h)}`,
          "",
          `_Source: CoinGecko · ${new Date().toUTCString()}_`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const [top20, trending] = await Promise.all([
        cgFetch("/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h"),
        cgFetch("/search/trending"),
      ]);

      const lines: string[] = [`**Crypto Market Overview** - ${new Date().toUTCString()}`, ""];

      lines.push("**Key Prices**");
      for (const sym of ["BTC", "ETH", "SOL"]) {
        const c = top20.find((x: any) => x.symbol?.toUpperCase() === sym);
        if (!c) continue;
        const sign = (c.price_change_percentage_24h ?? 0) >= 0 ? "+" : "";
        lines.push(`• **${sym}**: ${fmtPrice(c.current_price)} (${sign}${fmt(c.price_change_percentage_24h)}% 24h) - mcap ${fmtB(c.market_cap)}`);
      }

      lines.push("", "**Top 20 by Market Cap**");
      for (const c of top20) {
        const sym = c.symbol?.toUpperCase();
        const sign = (c.price_change_percentage_24h ?? 0) >= 0 ? "+" : "";
        lines.push(`${c.market_cap_rank}. **${sym}** ${fmtPrice(c.current_price)} (${sign}${fmt(c.price_change_percentage_24h)}%) - ${fmtB(c.market_cap)}`);
      }

      const trendingCoins: any[] = trending?.coins?.slice(0, 7) ?? [];
      if (trendingCoins.length > 0) {
        lines.push("", "**Trending**");
        for (const t of trendingCoins) {
          const item = t.item;
          lines.push(`• **${item.symbol}** (#${item.market_cap_rank ?? "-"}) - ${item.name}`);
        }
      }

      lines.push("", `_Source: CoinGecko_`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "get_token_data": {
      const parsed = parseOrError(GetTokenDataSchema, args);
      if (!parsed.ok) return parsed.error;

      const q = parsed.data.question;
      // Try to extract a known symbol first, then fall back to search
      const upperQ = q.toUpperCase();
      const knownSym = Object.keys(SYMBOL_TO_ID).find((s) => new RegExp(`\\b${s}\\b`).test(upperQ));
      const resolved = await resolveTokenId(knownSym ?? q);
      if (!resolved) return { content: [{ type: "text", text: `Token not found: "${q}". Try a symbol like "ETH" or a full name.` }], isError: true };
      const { id, symbol: sym } = resolved;

      const data = await cgFetch(`/coins/markets?vs_currency=usd&ids=${id}&sparkline=false&price_change_percentage=24h`);
      const c = data[0];
      if (!c) return { content: [{ type: "text", text: `No data found for ${sym}` }], isError: true };

      const sign = (c.price_change_percentage_24h ?? 0) >= 0 ? "+" : "";
      const lines = [
        `**${c.symbol?.toUpperCase()} - ${c.name}**`,
        `Price: ${fmtPrice(c.current_price)} (${sign}${fmt(c.price_change_percentage_24h)}% 24h)`,
        `Market Cap: ${fmtB(c.market_cap)} (rank #${c.market_cap_rank ?? "-"})`,
        `Volume 24h: ${fmtB(c.total_volume)}`,
        `High/Low 24h: ${fmtPrice(c.high_24h)} / ${fmtPrice(c.low_24h)}`,
        `All-Time High: ${fmtPrice(c.ath)} (${c.ath_change_percentage != null ? fmt(c.ath_change_percentage) + "% from ATH" : "-"})`,
        "",
        `_Source: CoinGecko · ${new Date().toUTCString()}_`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: buildTokenSnapshot(c),
      };
    }

    case "compare_tokens": {
      const parsed = parseOrError(CompareTokensSchema, args);
      if (!parsed.ok) return parsed.error;

      const syms = parsed.data.tokens.map(t => t.toUpperCase());
      const ids = syms.map(s => SYMBOL_TO_ID[s]).filter(Boolean);
      const unknown = syms.filter(s => !SYMBOL_TO_ID[s]);
      if (!ids.length) return { content: [{ type: "text", text: `Unknown tokens: ${unknown.join(", ")}` }], isError: true };

      const data = await cgFetch(
        `/coins/markets?vs_currency=usd&ids=${ids.join(",")}&sparkline=false&price_change_percentage=24h,7d`
      );

      const header = [
        `**Token Comparison** - ${new Date().toUTCString()}`,
        unknown.length ? `\n⚠️ Unknown: ${unknown.join(", ")}` : "",
        ``,
        `| Token | Price | 24h | 7d | Mcap | Vol 24h | ATH% |`,
        `|-------|-------|-----|----|------|---------|------|`,
      ].filter(Boolean);

      const rows = data.map((c: any) => {
        const sym = c.symbol?.toUpperCase();
        const ch24 = c.price_change_percentage_24h ?? 0;
        const ch7d = c.price_change_percentage_7d_in_currency ?? 0;
        const athPct = c.ath_change_percentage ?? 0;
        const s = (n: number) => `${n >= 0 ? "+" : ""}${fmt(n)}%`;
        return `| **${sym}** | ${fmtPrice(c.current_price)} | ${s(ch24)} | ${s(ch7d)} | ${fmtB(c.market_cap)} | ${fmtB(c.total_volume)} | ${fmt(athPct)}% |`;
      });

      return {
        content: [{ type: "text", text: [...header, ...rows].join("\n") }],
        structuredContent: buildTokenComparison(data, unknown),
      };
    }

    case "market_overview": {
      const [globalData, fearGreed, trending] = await Promise.allSettled([
        cgFetch("/global"),
        cachedFetch("https://api.alternative.me/fng/", { headers: { Accept: "application/json" } }, { timeoutMs: 8000 })
          .then((r) => { if (!r.ok) throw new Error(`fng ${r.status}`); return JSON.parse(r.text) as any; }),
        cgFetch("/search/trending"),
      ]);

      const global = globalData.status === "fulfilled" ? globalData.value.data : null;
      const fg = fearGreed.status === "fulfilled" ? fearGreed.value?.data?.[0] : null;
      const trendCoins = trending.status === "fulfilled" ? (trending.value?.coins ?? []) : [];

      const totalMcap = global?.total_market_cap?.usd;
      const defiTvl = global?.total_value_locked?.usd;
      const btcDom = global?.market_cap_percentage?.btc;
      const ethDom = global?.market_cap_percentage?.eth;
      const mcap24hChange = global?.market_cap_change_percentage_24h_usd;

      const fgEmoji = fg ? (Number(fg.value) >= 75 ? "🟢 Extreme Greed" : Number(fg.value) >= 55 ? "🟢 Greed" : Number(fg.value) >= 45 ? "🟡 Neutral" : Number(fg.value) >= 25 ? "🔴 Fear" : "🔴 Extreme Fear") : "";

      const lines = [
        `## 🌍 Global Crypto Market`,
        `_${new Date().toUTCString()}_`,
        ``,
        `**Fear & Greed:** ${fgEmoji} ${fg?.value ?? "-"}/100 (${fg?.value_classification ?? "-"})`,
        totalMcap ? `**Total Market Cap:** ${fmtB(totalMcap)} (${mcap24hChange != null ? `${mcap24hChange >= 0 ? "+" : ""}${fmt(mcap24hChange)}% 24h` : ""})` : "",
        btcDom != null ? `**BTC Dominance:** ${fmt(btcDom)}%  |  **ETH:** ${fmt(ethDom ?? 0)}%` : "",
        defiTvl ? `**DeFi TVL:** ${fmtB(defiTvl)}` : "",
        global?.active_cryptocurrencies ? `**Active Coins:** ${global.active_cryptocurrencies.toLocaleString()}` : "",
        ``,
      ].filter(l => l !== "");

      if (trendCoins.length > 0) {
        lines.push(`**🔥 Trending Now**`);
        for (const t of trendCoins.slice(0, 7)) {
          const item = t.item;
          const rank = item.market_cap_rank ? `#${item.market_cap_rank}` : "unranked";
          lines.push(`• **${item.symbol}** (${rank}) - ${item.name}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: buildMarketOverview(global, fg, trendCoins) };
    }

    case "token_history": {
      const parsed = parseOrError(TokenHistorySchema, args);
      if (!parsed.ok) return parsed.error;

      const days = parsed.data.days ?? 7;
      const resolved = await resolveTokenId(parsed.data.token);
      if (!resolved) return { content: [{ type: "text", text: `Token not found: "${parsed.data.token}". Try a symbol like "ETH" or a full name.` }], isError: true };
      const { id, symbol: sym } = resolved;

      const [ohlc, current] = await Promise.all([
        cgFetch(`/coins/${id}/ohlc?vs_currency=usd&days=${days}`),
        cgFetch(`/coins/markets?vs_currency=usd&ids=${id}&sparkline=false&price_change_percentage=24h`),
      ]);

      const c = current[0];
      const candles: [number, number, number, number, number][] = ohlc ?? [];

      if (!candles.length) return { content: [{ type: "text", text: `No history data for ${sym}` }], isError: true };

      const first = candles[0];
      const last = candles[candles.length - 1];
      const openPrice = first[1];
      const closePrice = last[4];
      const periodChange = ((closePrice - openPrice) / openPrice) * 100;
      const highs = candles.map(c => c[2]);
      const lows = candles.map(c => c[3]);
      const periodHigh = Math.max(...highs);
      const periodLow = Math.min(...lows);

      const lines = [
        `## ${sym} - ${days}d History`,
        ``,
        `**Current:** ${fmtPrice(c?.current_price)} (${(c?.price_change_percentage_24h ?? 0) >= 0 ? "+" : ""}${fmt(c?.price_change_percentage_24h)}% 24h)`,
        `**Period open:** ${fmtPrice(openPrice)}`,
        `**Period close:** ${fmtPrice(closePrice)} (${periodChange >= 0 ? "+" : ""}${fmt(periodChange)}% over ${days}d)`,
        `**${days}d High:** ${fmtPrice(periodHigh)}`,
        `**${days}d Low:** ${fmtPrice(periodLow)}`,
        `**Range:** ${fmt((periodHigh - periodLow) / periodLow * 100)}% spread`,
        ``,
        `**Last 10 candles (OHLC):**`,
        `| Date | Open | High | Low | Close |`,
        `|------|------|------|-----|-------|`,
        ...candles.slice(-10).map(([ts, o, h, l, cl]) => {
          const d = new Date(ts).toISOString().slice(0, 10);
          return `| ${d} | ${fmtPrice(o)} | ${fmtPrice(h)} | ${fmtPrice(l)} | ${fmtPrice(cl)} |`;
        }),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: buildTokenHistory(sym, days, c, openPrice, closePrice, periodHigh, periodLow, candles),
      };
    }

    case "get_base_token_data": {
      const parsed = parseOrError(GetBaseTokenDataSchema, args);
      if (!parsed.ok) return parsed.error;

      const address = parsed.data.tokenAddress.toLowerCase();
      const [pair, coingeckoId] = await Promise.all([
        fetchDexscreenerBaseToken(address),
        resolveCoingeckoIdByContract(address),
      ]);

      if (!pair) {
        return {
          content: [{ type: "text", text: `No Base-chain liquidity pair found for ${address}. It may not be a Base token, may have no active DEX pair, or the address may be wrong.` }],
          isError: true,
        };
      }

      const priceUsd = pair.priceUsd ? parseFloat(pair.priceUsd) : null;
      const ch = pair.priceChange ?? {};
      const sign = (n: number | null | undefined) => (typeof n === "number" && n >= 0 ? "+" : "");
      const pairAgeDays = pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000) : null;

      const lines = [
        `**${pair.baseToken?.symbol ?? "?"} - ${pair.baseToken?.name ?? "Unknown token"}** (Base)`,
        `Contract: \`${address}\``,
        `Price: ${fmtPrice(priceUsd)}`,
        `Change: 1h ${sign(ch.h1)}${fmt(ch.h1)}%  ·  6h ${sign(ch.h6)}${fmt(ch.h6)}%  ·  24h ${sign(ch.h24)}${fmt(ch.h24)}%`,
        `Volume 24h: ${fmtB(pair.volume?.h24)}`,
        `Liquidity: ${fmtB(pair.liquidity?.usd)}`,
        `Market Cap: ${fmtB(pair.marketCap)}`,
        `FDV: ${fmtB(pair.fdv)}`,
      ];
      if (pairAgeDays != null) lines.push(`Pair age: ${pairAgeDays}d`);
      if (pair.derivedFromQuoteSide) {
        lines.push(
          "",
          `_This token only appears as the quote side of its pools, so the price above is derived ` +
            `from the pair ratio rather than quoted directly. Market cap, FDV, 24h change and trade ` +
            `counts are omitted because on such a pair they describe the other token._`
        );
      }

      lines.push(
        "",
        coingeckoId
          ? `📈 Listed on CoinGecko as \`${coingeckoId}\` - historical chart data is available (use token_history).`
          : `⚠️ Not listed on CoinGecko - no historical chart available, live DexScreener data only.`
      );

      const websites: any[] = pair.info?.websites ?? [];
      const socials: any[] = pair.info?.socials ?? [];
      if (websites.length || socials.length) {
        lines.push("", "**Links**");
        for (const w of websites) lines.push(`• ${w.label || "Website"}: ${w.url}`);
        for (const s of socials) lines.push(`• ${s.type}: ${s.url}`);
      }

      lines.push("", `_Source: DexScreener${coingeckoId ? " + CoinGecko" : ""} · ${new Date().toUTCString()}_`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: buildBaseTokenSnapshot(address, pair, coingeckoId),
      };
    }

    default:
      return null;
  }
}
