/**
 * Pick the DexScreener pair whose numbers actually describe the token asked for.
 *
 * `priceUsd`, `marketCap`, `fdv`, `priceChange` and `txns` on a pair all describe
 * the BASE token. Taking the deepest pair regardless of side therefore reports a
 * different token entirely, and does it convincingly — the caller's own contract
 * address is still printed alongside. Two real cases:
 *
 *   - Canonical USDC on Base. Its deepest pair is `AERO/USDC`, so asking for
 *     USDC returned Aerodrome at $0.4332 with an $840M FDV.
 *   - NVDA on Robinhood Chain. Its deepest pair is `AI/NVDA`, so it reported AI
 *     at $0.0063 as though that were NVDA at $205 — and that price fed the
 *     take-profit and stop-loss triggers.
 *
 * Base-side pairs are preferred by depth. When a token only ever appears as the
 * quote, its price is still derivable as `basePriceUsd / basePriceInOurToken`,
 * so the pair is rebuilt with the sides swapped and the fields that describe the
 * other token's flow dropped rather than passed off as ours.
 */

/**
 * The subset of a DexScreener pair this needs. Deliberately free of an index
 * signature so callers can pass their own stricter pair types and get the same
 * type back, rather than losing the fields they rely on downstream.
 */
export type DexPairLike = {
  baseToken?: { address?: string; symbol?: string; name?: string } | undefined;
  quoteToken?: { address?: string; symbol?: string; name?: string } | undefined;
  priceUsd?: string | undefined;
  priceNative?: string | undefined;
  liquidity?: { usd?: number } | undefined;
};

const depth = (p: DexPairLike) => p.liquidity?.usd ?? 0;

export function pickTokenPair<T extends DexPairLike>(pairs: T[] | undefined, tokenAddress: string): T | null {
  const want = tokenAddress.toLowerCase();
  const all = pairs ?? [];

  const baseSide = all
    .filter((p) => p.baseToken?.address?.toLowerCase() === want)
    .sort((a, b) => depth(b) - depth(a));
  if (baseSide.length) return baseSide[0];

  const q = all
    .filter((p) => p.quoteToken?.address?.toLowerCase() === want)
    .sort((a, b) => depth(b) - depth(a))[0];
  if (!q) return null;

  const baseUsd = Number(q.priceUsd);
  const baseInOurs = Number(q.priceNative);
  if (!isFinite(baseUsd) || !isFinite(baseInOurs) || baseInOurs <= 0) return null;

  return {
    ...q,
    baseToken: q.quoteToken,
    quoteToken: q.baseToken,
    priceUsd: String(baseUsd / baseInOurs),
    priceNative: undefined,
    // Supply-based and direction-based figures belong to the other token.
    marketCap: undefined,
    fdv: undefined,
    txns: undefined,
    priceChange: undefined,
    derivedFromQuoteSide: true,
  } as unknown as T;
}
