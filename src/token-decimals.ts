// Canonical token decimals for the MCP server — ONE source of truth.
// Mirrors app/convex/tokenDecimals.ts. Keep the two in sync when adding a token;
// they are separate packages so the module itself cannot be shared.
//
// Previously duplicated across tools/defi.ts and tools/base-mcp.ts with a silent
// `?? 18` fallback. Assuming 18 decimals for a 6-decimal token misreports the
// amount by 10^12, so unknown tokens return undefined and callers must say so.

export const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18,
  WETH: 18,
  DAI: 18,
  FINCH: 18,
  USDC: 6,
  USDT: 6,
  CBBTC: 8,
};

/** Decimals for a token symbol, or undefined if unknown. Never guesses. */
export function decimalsFor(symbol: string | undefined | null): number | undefined {
  if (!symbol) return undefined;
  return TOKEN_DECIMALS[symbol.trim().toUpperCase()];
}
