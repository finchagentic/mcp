import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleMarketTool } from "../src/tools/market.js";
import { clearHttpCache } from "../src/_http-cache.js";

const VALID_ADDRESS = "0x4b524015d54a27d4472f5c59c570730d69499ba3";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("get_base_token_data", () => {
  beforeEach(() => {
    clearHttpCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a malformed contract address before making any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handleMarketTool("get_base_token_data", { tokenAddress: "not-an-address" });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("valid 0x-prefixed 40-hex-char Base contract address") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports no liquidity pair when DexScreener has no Base pairs for the address", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("dexscreener.com")) return jsonResponse({ pairs: [{ chainId: "ethereum" }] });
      return jsonResponse({}, 404);
    }));

    const result = await handleMarketTool("get_base_token_data", { tokenAddress: VALID_ADDRESS });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("No Base-chain liquidity pair found") });
  });

  it("returns full market data with price/volume/liquidity/mcap/fdv and flags CoinGecko-chart eligibility", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        return jsonResponse({
          pairs: [
            {
              chainId: "base",
              // A real DexScreener pair always carries the token address, and
              // which side it sits on decides whose price `priceUsd` is. The
              // fixture omitted it, which is why these tests passed while
              // `get_base_token_data` was returning another token entirely.
              baseToken: { address: VALID_ADDRESS, symbol: "NOEL", name: "Finch" },
              quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
              priceUsd: "0.01234",
              priceChange: { h1: 1.2, h6: -3.4, h24: 5.6 },
              volume: { h24: 250_000 },
              liquidity: { usd: 500_000 },
              marketCap: 12_000_000,
              fdv: 15_000_000,
              pairCreatedAt: Date.now() - 3 * 86_400_000,
              info: {
                websites: [{ label: "Website", url: "https://finchagentic.com" }],
                socials: [{ type: "twitter", url: "https://x.com/finchagentic" }],
              },
            },
          ],
        });
      }
      if (url.includes("coins/base/contract")) return jsonResponse({ id: "noel-claw" });
      return jsonResponse({}, 404);
    }));

    const result = await handleMarketTool("get_base_token_data", { tokenAddress: VALID_ADDRESS });
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";

    expect(result?.isError).toBeFalsy();
    expect(text).toContain("NOEL");
    expect(text).toContain("Market Cap");
    expect(text).toContain("FDV");
    expect(text).toContain("Listed on CoinGecko as `noel-claw`");
    expect(text).toContain("https://finchagentic.com");
    expect(text).toContain("https://x.com/finchagentic");
  });

  // Canonical USDC on Base sits on the quote side of `AERO/USDC`, its deepest
  // pool. Taking the deepest pair regardless of side answered a question about
  // USDC with Aerodrome's symbol, price and $840M FDV — under USDC's own
  // contract address.
  it("never reports another token's figures when ours is the quote side", async () => {
    const OTHER = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        return jsonResponse({
          pairs: [
            {
              chainId: "base",
              baseToken: { address: OTHER, symbol: "AERO", name: "Aerodrome" },
              quoteToken: { address: VALID_ADDRESS, symbol: "USDC" },
              priceUsd: "0.4332",
              priceNative: "0.4332",
              marketCap: 419_900_000,
              fdv: 840_600_000,
              liquidity: { usd: 25_900_000 },  // deepest
              priceChange: { h24: -3.8 },
              volume: { h24: 1_800_000 },
            },
            {
              chainId: "base",
              baseToken: { address: VALID_ADDRESS, symbol: "USDC", name: "USD Coin" },
              quoteToken: { address: OTHER, symbol: "AERO" },
              priceUsd: "0.9999",
              liquidity: { usd: 120_000 },     // shallower, but ours
              priceChange: {},
              volume: {},
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    }));

    const result = await handleMarketTool("get_base_token_data", { tokenAddress: VALID_ADDRESS });
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("USDC");
    expect(text).toContain("0.9999");
    expect(text).not.toContain("AERO");
    expect(text).not.toContain("Aerodrome");
    expect(text).not.toContain("840.6M");   // the other token's FDV
  });

  it("derives the price when our token is only ever the quote, and says so", async () => {
    const OTHER = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        return jsonResponse({
          pairs: [{
            chainId: "base",
            baseToken: { address: OTHER, symbol: "AERO", name: "Aerodrome" },
            quoteToken: { address: VALID_ADDRESS, symbol: "USDC", name: "USD Coin" },
            priceUsd: "0.4332",
            priceNative: "0.4332",        // AERO priced in USDC
            marketCap: 419_900_000,
            fdv: 840_600_000,
            liquidity: { usd: 25_900_000 },
            priceChange: { h24: -3.8 },
            volume: { h24: 1_800_000 },
          }],
        });
      }
      return jsonResponse({}, 404);
    }));

    const result = await handleMarketTool("get_base_token_data", { tokenAddress: VALID_ADDRESS });
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("USD Coin");            // 0.4332 / 0.4332 = 1.00
    expect(text).toContain("quote side");          // the derivation is disclosed
    expect(text).not.toContain("840.6M");          // supply figures are dropped
    expect(text).not.toContain("Aerodrome");
  });

  it("flags tokens with no CoinGecko listing instead of silently omitting chart info", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        return jsonResponse({
          pairs: [{
            chainId: "base",
            baseToken: { address: VALID_ADDRESS, symbol: "TEST", name: "Test Token" },
            quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
            priceUsd: "1.5",
            priceChange: {},
            volume: {},
            liquidity: { usd: 1000 },
          }],
        });
      }
      return jsonResponse({}, 404);
    }));

    const result = await handleMarketTool("get_base_token_data", { tokenAddress: VALID_ADDRESS });
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("Not listed on CoinGecko");
  });
});
