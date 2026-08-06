// Regression: `priceUsd` on a DexScreener pair is always the BASE token's price.
//
// Accepting the deepest pair regardless of side reports a different token's
// price entirely. NVDA's deepest Robinhood-chain pair is `AI/NVDA`, which
// reported AI at $0.0063 as if it were NVDA at $205. That number feeds the
// take-profit and stop-loss triggers, so a wrong side here fires real orders at
// a price that never existed.

import { describe, it, expect, afterEach, vi } from "vitest";
import { dexTokenBest } from "../src/tools/rh-mcp.js";

const OURS = "0x1111111111111111111111111111111111111111"; // stands in for NVDA
const OTHER = "0x2222222222222222222222222222222222222222"; // stands in for AI
const WETH = "0x3333333333333333333333333333333333333333";

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** Deepest pool, but our token sits on the QUOTE side — priceUsd is AI's. */
const QUOTE_SIDE_DEEP = {
  chainId: "robinhood",
  baseToken: { address: OTHER, symbol: "AI" },
  quoteToken: { address: OURS, symbol: "NVDA" },
  priceUsd: "0.0063",
  priceNative: "0.00003065693", // AI priced in NVDA
  liquidity: { usd: 900_000 },
  txns: { h24: { buys: 500, sells: 480 } },
};

/** Shallower, but our token is the BASE — this price is the trustworthy one. */
const BASE_SIDE_SHALLOW = {
  chainId: "robinhood",
  baseToken: { address: OURS, symbol: "NVDA" },
  quoteToken: { address: WETH, symbol: "WETH" },
  priceUsd: "205.50",
  priceNative: "0.05",
  liquidity: { usd: 100_000 },
};

function stubPairs(pairs: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => okJson({ pairs })));
}

describe("dexTokenBest — which side of the pair the price belongs to", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers a shallower base-side pool over a deeper quote-side one", async () => {
    stubPairs([QUOTE_SIDE_DEEP, BASE_SIDE_SHALLOW]);
    const pair = await dexTokenBest(OURS);

    expect(pair?.baseToken?.address?.toLowerCase()).toBe(OURS);
    expect(Number(pair?.priceUsd)).toBeCloseTo(205.5, 2);
    // The other token's price must never be reported as ours.
    expect(Number(pair?.priceUsd)).not.toBeCloseTo(0.0063, 4);
  });

  it("ranks by liquidity among base-side pools", async () => {
    const deeperBase = { ...BASE_SIDE_SHALLOW, priceUsd: "205.60", liquidity: { usd: 400_000 } };
    stubPairs([BASE_SIDE_SHALLOW, deeperBase, QUOTE_SIDE_DEEP]);
    const pair = await dexTokenBest(OURS);

    expect(Number(pair?.priceUsd)).toBeCloseTo(205.6, 2);
  });

  it("derives our price from a quote-side pool rather than reporting the base token's", async () => {
    stubPairs([QUOTE_SIDE_DEEP]);
    const pair = await dexTokenBest(OURS);

    // basePriceUsd / basePriceInOurToken = 0.0063 / 0.00003065693 ≈ 205.5
    expect(pair?.baseToken?.address?.toLowerCase()).toBe(OURS);
    expect(Number(pair?.priceUsd)).toBeCloseTo(205.5, 0);
  });

  it("returns nothing when a quote-side pool lacks the ratio needed to derive a price", async () => {
    stubPairs([{ ...QUOTE_SIDE_DEEP, priceNative: "0" }]);
    expect(await dexTokenBest(OURS)).toBeNull();
  });

  it("ignores pairs from other chains", async () => {
    stubPairs([{ ...BASE_SIDE_SHALLOW, chainId: "base", priceUsd: "999" }]);
    expect(await dexTokenBest(OURS)).toBeNull();
  });
});
