// DexScreener (Robinhood chain) — arbitrary token resolution + market data.

import { pickTokenPair } from "../dex-pair.js";
import { DEXSCREENER, RH_DEX_CHAIN } from "./rh-mcp-constants.js";

export interface DexPair {
  chainId: string;
  dexId?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys: number; sells: number } };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  info?: { websites?: unknown[]; socials?: unknown[] };
}

export interface ResolvedToken {
  kind: "eth" | "token";
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  dex?: DexPair | null;
}

export async function dexFetch(path: string): Promise<any> {
  const res = await fetch(`${DEXSCREENER}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  return res.json();
}

function rhOnly(pairs: DexPair[] | undefined): DexPair[] {
  return (pairs ?? []).filter((p) => p.chainId === RH_DEX_CHAIN);
}

/** Highest-liquidity RH pair that contains `address`. */
export async function dexTokenBest(address: string): Promise<DexPair | null> {
  try {
    const data = await dexFetch(`/latest/dex/tokens/${address}`);
    // Only base-side pairs price our token; see pickTokenPair for why the
    // deepest pair overall is the wrong answer. That price feeds TP/SL triggers.
    return pickTokenPair(rhOnly(data?.pairs), address);
  } catch {
    return null;
  }
}

/**
 * Sanity-check an on-chain quote against DexScreener spot value.
 *
 * The RH engine routes Uniswap V4 pools only. When a token's real depth lives
 * elsewhere (e.g. a V2/V3 WETH pair) the V4 path can be empty and still return a
 * quote — at a catastrophic rate. Returns the fraction of spot value received,
 * or null when it can't be determined (no ETH-quoted pair → no false alarms).
 */
export async function quoteValueRatio(
  from: ResolvedToken,
  to: ResolvedToken,
  amountInHuman: string,
  amountOutHuman: number
): Promise<{ ratio: number; expectedOut: number } | null> {
  const tokenSide = from.kind === "token" ? from : to;
  const amtIn = Number(amountInHuman);
  if (!isFinite(amtIn) || amtIn <= 0 || !isFinite(amountOutHuman) || amountOutHuman <= 0) {
    return null;
  }
  try {
    const data = await dexFetch(`/latest/dex/tokens/${tokenSide.address}`);
    const pairs = rhOnly(data?.pairs);
    if (!pairs.length) return null;

    // Derive ETH/USD from any ETH/WETH-quoted pair: priceUsd / priceNative.
    const ethPair = pairs.find((p) => {
      const q = p.quoteToken?.symbol?.toUpperCase();
      return (q === "WETH" || q === "ETH") && Number(p.priceNative) > 0 && Number(p.priceUsd) > 0;
    });
    if (!ethPair) return null;
    const ethUsd = Number(ethPair.priceUsd) / Number(ethPair.priceNative);

    // Only base-side pairs price OUR token — `priceUsd` always belongs to the
    // base. Sorting across every pair could hand back a completely different
    // token's price, and this value decides whether a swap is blocked.
    const want = tokenSide.address.toLowerCase();
    const ourPairs = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === want);
    const deepest = [...ourPairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const tokenUsd = Number(deepest?.priceUsd);
    if (!isFinite(ethUsd) || ethUsd <= 0 || !isFinite(tokenUsd) || tokenUsd <= 0) return null;

    const inUsd = from.kind === "eth" ? amtIn * ethUsd : amtIn * tokenUsd;
    const outUsd = to.kind === "eth" ? amountOutHuman * ethUsd : amountOutHuman * tokenUsd;
    if (!isFinite(inUsd) || inUsd <= 0 || !isFinite(outUsd)) return null;

    const expectedOut = to.kind === "eth" ? inUsd / ethUsd : inUsd / tokenUsd;
    return { ratio: outUsd / inUsd, expectedOut };
  } catch {
    return null;
  }
}

/** Human-readable warning when a quote is far below spot value, else null. */
export function badQuoteWarning(
  check: { ratio: number; expectedOut: number } | null,
  toSymbol: string
): string | null {
  if (!check || check.ratio >= 0.75) return null;
  const pct = (check.ratio * 100).toFixed(1);
  const lost = ((1 - check.ratio) * 100).toFixed(1);
  return (
    `🔴 **BAD PRICE — you would receive only ${pct}% of spot value (~${lost}% instant loss).**\n` +
    `Expected ≈ **${check.expectedOut.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toSymbol}** at DexScreener spot.\n` +
    `Cause: this engine routes **Uniswap V4 pools only**. This token's real depth is likely in a ` +
    `V2/V3 pair the router cannot reach, so it is quoting a near-empty V4 path. **Do not swap.**`
  );
}

/** RH tokens whose base symbol matches `ticker`, deduped by address, ranked by liquidity. */
export async function dexSearchByTicker(ticker: string): Promise<DexPair[]> {
  const data = await dexFetch(`/latest/dex/search/?q=${encodeURIComponent(ticker)}`);
  const up = ticker.trim().toUpperCase();
  const byToken = new Map<string, DexPair>();
  for (const p of rhOnly(data?.pairs)) {
    if (p.baseToken?.symbol?.toUpperCase() !== up) continue;
    const key = p.baseToken.address.toLowerCase();
    const prev = byToken.get(key);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) byToken.set(key, p);
  }
  return [...byToken.values()].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  );
}
