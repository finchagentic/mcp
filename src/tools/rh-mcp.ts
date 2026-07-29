// Robinhood Chain MCP — `rh_mcp_*` namespace (parity with `base_mcp_*`).
// Tokenized equities on chainId 4663 via Finch Uni V4 (NOT 0x equities,
// NOT Robinhood Agentic brokerage MCP at agent.robinhood.com).
//
// Quote path: Convex `walletActions.zeroXQuote({ chainId: 4663 })` → Uni V4
// (direct ETH↔stock or multi-hop ETH↔USDG↔stock for thin pairs like BE).
//
// Swap execute: local MCP wallet signs on RH RPC. Buys (ETH→stock) work in one
// tx. Sells need 2-step Permit2 (ERC20→Permit2, Permit2→Universal Router).

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";
import { ToolResult } from "../types.js";
import { callConvex, CONVEX_SITE } from "../convex.js";
import { getSavedToken } from "../config.js";
import { getOrCreateWallet } from "../wallet.js";
import { pickTokenPair } from "../dex-pair.js";
import { handleWalletTool } from "./wallet.js";

export const RH_CHAIN_ID = 4663;
export const RH_RPC =
  process.env.ROBINHOOD_RPC_URL ??
  process.env.RH_RPC_URL ??
  process.env.FINCH_RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com";

export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const RH_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const RH_UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";

/**
 * Canonical Global Dollar (USDG) — RH chain's settlement stablecoin (same
 * address as app/convex/_settlement.ts). Hardcoded rather than resolved via
 * DexScreener ticker search: "USDG" is the exact symbol an imposter contract
 * would spoof, and dexSearchByTicker ranks by pool liquidity, not authenticity
 * — a fake pool with inflated liquidity could otherwise outrank the real token.
 */
const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const USDG_DECIMALS = 6;

/** ClawHood / Finch catalog (22 tokenized stocks — official "Robinhood Token" contracts). */
export const RH_STOCKS: Array<{ address: string; symbol: string; name: string }> = [
  { address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", symbol: "AAPL", name: "Apple" },
  { address: "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc", symbol: "AMD", name: "AMD" },
  { address: "0x12f190a9f9d7d37a250758b26824b97ce941bf54", symbol: "AMZN", name: "Amazon" },
  { address: "0x822cc93ffd030293e9842c30bbd678f530701867", symbol: "BE", name: "Bloom Energy" },
  { address: "0x6330d8c3178a418788df01a47479c0ce7ccf450b", symbol: "COIN", name: "Coinbase" },
  { address: "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3", symbol: "CRWV", name: "CoreWeave" },
  { address: "0x1b0e319c6a659f002271b69db8a7df2f911c153e", symbol: "GME", name: "GameStop" },
  { address: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", symbol: "GOOGL", name: "Alphabet" },
  { address: "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681", symbol: "INTC", name: "Intel" },
  { address: "0xc0d6457c16cc70d6790dd43521c899c87ce02f35", symbol: "META", name: "Meta" },
  { address: "0xe93237c50d904957cf27e7b1133b510c669c2e74", symbol: "MSFT", name: "Microsoft" },
  { address: "0xff080c8ce2e5feadaca0da81314ae59d232d4afd", symbol: "MU", name: "Micron" },
  { address: "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8", symbol: "NFLX", name: "Netflix" },
  { address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", symbol: "NVDA", name: "NVIDIA" },
  { address: "0xb0992820e760d836549ba69bc7598b4af75dee03", symbol: "ORCL", name: "Oracle" },
  { address: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a", symbol: "PLTR", name: "Palantir" },
  { address: "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", symbol: "QQQ", name: "Invesco QQQ" },
  { address: "0xb90a19ff0af67f7779aff50a882a9cff42446400", symbol: "SNDK", name: "Sandisk" },
  { address: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", symbol: "SPCX", name: "SPACEX" },
  { address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", symbol: "SPY", name: "SPDR S&P 500" },
  { address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d", symbol: "TSLA", name: "Tesla" },
  { address: "0xd917b029c761d264c6a312bbbcda868658ef86a6", symbol: "USAR", name: "USA Rare Earth" },
];

export const RH_MCP_TOOLS: Tool[] = [
  {
    name: "rh_mcp_status",
    description:
      "Robinhood Chain MCP - status of RH rail (chainId 4663): wallet address, RPC, " +
      "ETH gas balance on RH, explorer. Use at the start of any tokenized-stock session. " +
      "NOT Robinhood Agentic brokerage (agent.robinhood.com).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "rh_mcp_list_stocks",
    description:
      "Robinhood Chain MCP - list the 22 Finch/ClawHood tokenized stock tickers " +
      "(symbol, name, contract address) tradeable via Uniswap V4 on chain 4663.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional filter: symbol or name substring (e.g. 'NVDA', 'Apple')",
        },
      },
      required: [],
    },
  },
  {
    name: "rh_mcp_balance",
    description:
      "Robinhood Chain MCP - ETH + tokenized stock balances on RH (chain 4663) for your " +
      "Finch MCP wallet (same address as Base). Reads RH RPC directly (not Alchemy Base).",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Optional 0x address (default: local Finch MCP wallet)",
        },
      },
      required: [],
    },
  },
  {
    name: "rh_mcp_estimate",
    description:
      "Robinhood Chain MCP - preview ETH↔token swap quote via Uniswap V4 (direct or " +
      "multi-hop via USDG). Does NOT execute. Always call before rh_mcp_swap. " +
      "fromToken/toToken: 'ETH' or ANY RH-chain asset — a catalog stock symbol " +
      "(NVDA, AAPL…), a crypto ticker, or a 0x contract address. Non-catalog tickers/CAs " +
      "resolve via DexScreener. Route is always ETH↔token (buy with ETH or sell for ETH).",
    inputSchema: {
      type: "object",
      properties: {
        fromToken: { type: "string", description: "Sell asset: ETH, ticker, or 0x contract address" },
        toToken: { type: "string", description: "Buy asset: ETH, ticker, or 0x contract address" },
        amount: { type: "string", description: "Human amount, e.g. '0.01' ETH or '1000' TOKEN" },
        maxSlippagePct: {
          type: "number",
          description: "Slippage tolerance % (default 2.0; raise for thin crypto pairs)",
        },
      },
      required: ["fromToken", "toToken", "amount"],
    },
  },
  {
    name: "rh_mcp_swap",
    description:
      "Robinhood Chain MCP - execute ETH↔token swap on chain 4663. Quotes Uniswap V2, V3 and V4 " +
      "and routes through whichever returns the most output. Works for catalog stocks AND " +
      "arbitrary RH-chain crypto (by ticker or 0x address; resolved via DexScreener). Use " +
      "rh_mcp_estimate first — and rh_analyze / rh_safety_check for unknown crypto. " +
      "Buys (ETH→token) are 1 tx. Sells approve automatically, and the approval differs by route: " +
      "V4 uses the 2-step Permit2 flow, V2/V3 use a single ERC-20 approve to SwapRouter02. " +
      "Refuses to broadcast when the quote is far below DexScreener spot (override: acceptBadPrice). " +
      "Reports the mined receipt — status, block, gas and the ACTUAL amount received. " +
      "Gas paid in ETH on RH. NOT brokerage orders — for Robinhood Agentic brokerage use official MCP separately.",
    inputSchema: {
      type: "object",
      properties: {
        fromToken: { type: "string", description: "Sell asset: ETH, ticker, or 0x contract address" },
        toToken: { type: "string", description: "Buy asset: ETH, ticker, or 0x contract address" },
        amount: { type: "string", description: "Human amount" },
        maxSlippagePct: { type: "number", description: "Slippage % (default 2.0)" },
        confirm: {
          type: "boolean",
          description: "Must be true to broadcast. Prevents accidental live swaps.",
        },
        acceptBadPrice: {
          type: "boolean",
          description:
            "Override the spot-price safety stop. Only set if you deliberately accept " +
            "receiving far less than DexScreener spot value (near-empty V4 pool).",
        },
      },
      required: ["fromToken", "toToken", "amount", "confirm"],
    },
  },
  {
    name: "rh_token_resolve",
    description:
      "Robinhood Chain MCP - resolve a crypto ticker OR 0x contract address to a tradeable " +
      "token on chain 4663 via DexScreener. Ticker search returns candidates ranked by " +
      "liquidity (tickers can be spoofed — always trade by the confirmed contract address). " +
      "Use before rh_mcp_estimate/rh_mcp_swap for non-catalog crypto.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Crypto ticker (e.g. 'PEPE') or 0x contract address" },
      },
      required: ["query"],
    },
  },
  {
    name: "rh_analyze",
    description:
      "Robinhood Chain MCP - market + risk pre-screen for any RH-chain token (ticker or 0x " +
      "address). Pulls DexScreener data (price, liquidity, 24h volume, buy/sell txns, pair age, " +
      "FDV/MCap) and returns a 0-100 risk score with reasoning flags. Combine with rh_safety_check " +
      "(onchain) and deep_research (X sentiment) for a full verdict. Not financial advice.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Crypto ticker or 0x contract address on RH chain 4663" },
      },
      required: ["token"],
    },
  },
  {
    name: "rh_safety_check",
    description:
      "Robinhood Chain MCP - free onchain safety scan for a token (ticker or 0x address). Reads " +
      "Blockscout (contract verified?, explorer reputation, holder count, launchpad-style contract " +
      "name) + DexScreener (sellable? honeypot signal from buys-with-0-sells). No LLM, no paid API. " +
      "Returns red/yellow/green safety flags + a risk score. Pair with rh_analyze (market/liquidity).",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Crypto ticker or 0x contract address on RH chain 4663" },
      },
      required: ["token"],
    },
  },
];

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function isAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isEth(sym: string): boolean {
  const s = sym.trim().toUpperCase();
  return s === "ETH" || s === "WETH" || s === "NATIVE" || s === NATIVE_ETH.toUpperCase();
}

function resolveStock(input: string): { address: string; symbol: string; name: string } | null {
  const t = input.trim();
  if (isEth(t)) return null;
  if (isAddress(t)) {
    const hit = RH_STOCKS.find((s) => s.address.toLowerCase() === t.toLowerCase());
    return hit ?? { address: t, symbol: t.slice(0, 8), name: "Unknown token" };
  }
  const up = t.toUpperCase();
  return RH_STOCKS.find((s) => s.symbol === up) ?? null;
}

// ─── DexScreener (Robinhood chain) — arbitrary token resolution + market data ──
const DEXSCREENER = "https://api.dexscreener.com";
const RH_DEX_CHAIN = "robinhood";

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

async function dexFetch(path: string): Promise<any> {
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
async function quoteValueRatio(
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
function badQuoteWarning(
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
async function dexSearchByTicker(ticker: string): Promise<DexPair[]> {
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

/** ERC-20 decimals() via RH RPC; falls back to 18. */
async function erc20Decimals(addr: string): Promise<number> {
  try {
    const hex = await rhRpc("eth_call", [{ to: addr, data: "0x313ce567" }, "latest"]);
    if (hex && hex !== "0x") {
      const d = Number(BigInt(hex));
      if (d > 0 && d <= 36) return d;
    }
  } catch {
    /* default 18 */
  }
  return 18;
}

/**
 * Resolve ETH, a catalog stock, a crypto ticker, or a raw 0x address to a
 * tradeable RH-chain token. Tickers resolve via DexScreener (highest liquidity
 * wins) — callers should confirm the contract address with the user first.
 */
export async function resolveTokenSmart(input: string): Promise<ResolvedToken> {
  if (isEth(input)) return { kind: "eth", address: NATIVE_ETH, symbol: "ETH", decimals: 18 };
  const t = input.trim();
  if (t.toUpperCase() === "USDG") {
    return { kind: "token", address: USDG_ADDRESS, symbol: "USDG", name: "Global Dollar", decimals: USDG_DECIMALS };
  }

  // 1) catalog symbol fast-path (22 tokenized stocks, all 18-decimals)
  const cat = RH_STOCKS.find((s) => s.symbol === t.toUpperCase());
  if (cat) return { kind: "token", address: cat.address, symbol: cat.symbol, name: cat.name, decimals: 18 };

  // 2) raw contract address
  if (isAddress(t)) {
    const dex = await dexTokenBest(t);
    const decimals = await erc20Decimals(t);
    const known = resolveStock(t);
    const symbol =
      dex?.baseToken?.address?.toLowerCase() === t.toLowerCase()
        ? dex.baseToken.symbol
        : known?.symbol ?? dex?.quoteToken?.symbol ?? `${t.slice(0, 6)}…`;
    return { kind: "token", address: t, symbol, name: dex?.baseToken?.name ?? known?.name, decimals, dex };
  }

  // 3) crypto ticker via DexScreener
  const cands = await dexSearchByTicker(t);
  if (cands.length === 0) {
    throw new Error(
      `Unknown RH asset "${input}". Not in the stock catalog and no Robinhood-chain token matched on DexScreener. Paste the 0x contract address instead.`
    );
  }
  const best = cands[0];
  const decimals = await erc20Decimals(best.baseToken.address);
  return {
    kind: "token",
    address: best.baseToken.address,
    symbol: best.baseToken.symbol,
    name: best.baseToken.name,
    decimals,
    dex: best,
  };
}

// ─── Risk pre-screen (heuristic, market data only) ───────────────────────────
function fmtUsd(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  if (!isFinite(v)) return "0";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(2);
}
function fmtPct(n: number | undefined | null): string {
  if (n == null || !isFinite(n)) return "n/a";
  return (n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
}

function assessRisk(dex: DexPair): { score: number; tier: string; flags: string[] } {
  let score = 0;
  const flags: string[] = [];
  const liq = dex.liquidity?.usd ?? 0;

  if (liq < 10_000) { score += 40; flags.push(`🔴 Very low liquidity ($${fmtUsd(liq)}) — high slippage & rug risk`); }
  else if (liq < 25_000) { score += 28; flags.push(`🟠 Low liquidity ($${fmtUsd(liq)})`); }
  else if (liq < 100_000) { score += 15; flags.push(`🟡 Moderate liquidity ($${fmtUsd(liq)})`); }
  else { flags.push(`🟢 Liquidity $${fmtUsd(liq)}`); }

  if (dex.pairCreatedAt) {
    const ageH = (Date.now() - dex.pairCreatedAt) / 3_600_000;
    if (ageH < 24) { score += 25; flags.push(`🔴 Very new pair (${ageH.toFixed(0)}h old)`); }
    else if (ageH < 24 * 7) { score += 12; flags.push(`🟠 New pair (${(ageH / 24).toFixed(1)}d old)`); }
    else { flags.push(`🟢 Pair age ${(ageH / 24).toFixed(0)}d`); }
  } else {
    flags.push("⚪ Pair age unknown");
  }

  const vol = dex.volume?.h24 ?? 0;
  const ratio = liq > 0 ? vol / liq : 0;
  if (ratio > 20) { score += 15; flags.push(`🔴 24h volume ${ratio.toFixed(1)}× liquidity — possible wash/hype spike`); }
  else if (ratio > 5) { score += 6; flags.push(`🟠 High turnover (${ratio.toFixed(1)}× liq)`); }

  const buys = dex.txns?.h24?.buys ?? 0;
  const sells = dex.txns?.h24?.sells ?? 0;
  if (buys + sells < 10) { score += 8; flags.push(`🟠 Thin activity (${buys + sells} txns/24h)`); }
  else if (sells > buys * 2) { score += 10; flags.push(`🟠 Sell-heavy (${sells} sells vs ${buys} buys/24h) — distribution`); }

  const ch = dex.priceChange?.h24;
  if (ch != null && Math.abs(ch) > 50) { score += 8; flags.push(`🟠 Volatile: ${fmtPct(ch)} 24h`); }

  const hasSocials = ((dex.info?.socials?.length ?? 0) + (dex.info?.websites?.length ?? 0)) > 0;
  if (!hasSocials) { score += 6; flags.push("🟡 No website/socials listed on DexScreener"); }

  // ── Implausibility checks ────────────────────────────────────────────────
  // A launchpad whitelist ages badly — new platforms appear constantly. These
  // look instead at whether the numbers are internally coherent, which a
  // bundled or honeypot token cannot fake without giving up the illusion.

  // Exit ratio: notional value vs the pool that would have to absorb a sale.
  // A $35M "market cap" sitting on $17K of liquidity is not a market cap —
  // it is a quote nobody can realise.
  const fdv = dex.fdv ?? dex.marketCap ?? 0;
  if (fdv > 0 && liq > 0) {
    const exitRatio = fdv / liq;
    if (exitRatio > 500) {
      score += 22;
      flags.push(
        `🔴 FDV is ${exitRatio.toFixed(0)}× liquidity ($${fmtUsd(fdv)} vs $${fmtUsd(liq)}) — ` +
          `the quoted valuation cannot be exited; treat the price as notional`
      );
    } else if (exitRatio > 100) {
      score += 12;
      flags.push(`🟠 FDV ${exitRatio.toFixed(0)}× liquidity — thin float behind the headline value`);
    }
  }

  // Wash pattern: heavy volume relative to the pool, with buys and sells almost
  // perfectly matched. Organic trading is lopsided; round-tripping is not.
  if (buys > 40 && sells > 40 && liq > 0) {
    const symmetry = Math.abs(buys - sells) / (buys + sells); // 0 = perfectly matched
    if (symmetry < 0.06 && ratio > 3) {
      score += 15;
      flags.push(
        `🔴 Buy/sell almost perfectly matched (${buys}/${sells}) on ${ratio.toFixed(1)}× turnover — ` +
          `consistent with wash trading or a bundled wallet set`
      );
    }
  }

  // Implausibly uniform trade size: many transactions, negligible average value.
  const txCount = buys + sells;
  if (txCount > 100 && vol > 0) {
    const avgTrade = vol / txCount;
    if (avgTrade < 25) {
      score += 10;
      flags.push(
        `🟠 Average trade only $${avgTrade.toFixed(2)} across ${txCount} txns — ` +
          `bot-like churn rather than real participation`
      );
    }
  }

  // Buys with no exits at all is the clearest honeypot tell available here.
  if (buys > 10 && sells === 0) {
    score += 30;
    flags.push(`🔴 ${buys} buys and ZERO sells in 24h — nobody has exited; possible honeypot`);
  }

  score = Math.min(100, score);
  const tier = score >= 70 ? "🔴 EXTREME" : score >= 45 ? "🟠 HIGH" : score >= 25 ? "🟡 MEDIUM" : "🟢 LOWER";
  return { score, tier, flags };
}

function renderResolveList(query: string, cands: DexPair[]): string {
  const rows = cands.slice(0, 8).map((p, i) =>
    `| ${i === 0 ? "⭐" : " "} | \`${p.baseToken.address}\` | $${fmtUsd(p.liquidity?.usd ?? 0)} | $${fmtUsd(p.volume?.h24 ?? 0)} | ${p.priceUsd ? "$" + p.priceUsd : "?"} |`
  );
  return [
    `## 🔎 RH resolve — "${query}" (${cands.length} match${cands.length === 1 ? "" : "es"})`,
    "",
    "| | Contract | Liquidity | Vol 24h | Price |",
    "|--|----------|-----------|---------|-------|",
    ...rows,
    "",
    `⭐ = highest liquidity. ⚠️ **Tickers can be spoofed** — several tokens may share "${query}". Trade using the exact contract address, never the ticker alone.`,
    "",
    `Next: \`rh_analyze\` the contract, then \`rh_mcp_estimate\` / \`rh_mcp_swap\` with the CA.`,
  ].join("\n");
}

function renderResolveOne(address: string, dex: DexPair): string {
  const isBase = dex.baseToken.address.toLowerCase() === address.toLowerCase();
  const tok = isBase ? dex.baseToken : dex.quoteToken;
  return [
    `## 🔎 RH token — ${tok.symbol}${tok.name ? ` (${tok.name})` : ""}`,
    `\`${tok.address}\` · chain 4663`,
    "",
    `**Price**: ${dex.priceUsd ? "$" + dex.priceUsd : "?"} · **24h**: ${fmtPct(dex.priceChange?.h24)}`,
    `**Liquidity**: $${fmtUsd(dex.liquidity?.usd ?? 0)} · **Vol 24h**: $${fmtUsd(dex.volume?.h24 ?? 0)}`,
    `**Pair**: ${dex.dexId ?? "uniswap"} · ${RH_EXPLORER}/address/${dex.pairAddress}`,
    "",
    `Next: \`rh_analyze\` for a risk read, then \`rh_mcp_estimate\` / \`rh_mcp_swap\`.`,
  ].join("\n");
}

// structuredContent payload for rh_analyze - mirrors buildRhSafetyStructured:
// `tier` is the assessRisk label with its leading emoji stripped
// ("EXTREME"/"HIGH"/"MEDIUM"/"LOWER"), single source, no thresholds duplicated.
export function buildRhAnalysis(
  r: ResolvedToken,
  dex: DexPair,
  assessment: { score: number; tier: string; flags: string[] },
): Record<string, unknown> {
  return {
    address:      r.address,
    symbol:       r.symbol ?? null,
    name:         r.name ?? null,
    priceUsd:     dex.priceUsd ? Number(dex.priceUsd) : null,
    change1hPct:  dex.priceChange?.h1 ?? null,
    change24hPct: dex.priceChange?.h24 ?? null,
    liquidityUsd: dex.liquidity?.usd ?? null,
    volume24hUsd: dex.volume?.h24 ?? null,
    fdvUsd:       dex.fdv ?? null,
    marketCapUsd: dex.marketCap ?? null,
    buys24h:      dex.txns?.h24?.buys ?? null,
    sells24h:     dex.txns?.h24?.sells ?? null,
    pairAgeDays:  dex.pairCreatedAt ? Math.floor((Date.now() - dex.pairCreatedAt) / 86_400_000) : null,
    riskScore:    assessment.score,
    tier:         assessment.tier.replace(/^\S+\s+/, ""),
    flags:        assessment.flags,
  };
}

// structuredContent payload for rh_mcp_list_stocks - a machine-readable
// mirror of the human table (already filtered by the caller's query).
export function buildRhStocksList(
  rows: ReadonlyArray<{ address: string; symbol: string; name: string }>,
): Record<string, unknown> {
  return {
    count: rows.length,
    stocks: rows.map((s) => ({ symbol: s.symbol, name: s.name, address: s.address })),
  };
}

function renderAnalysis(
  r: ResolvedToken,
  dex: DexPair,
  assessment: { score: number; tier: string; flags: string[] },
): string {
  const { score, tier, flags } = assessment;
  const ageLine = dex.pairCreatedAt
    ? `**Age**: ${((Date.now() - dex.pairCreatedAt) / 86_400_000).toFixed(1)}d`
    : "**Age**: unknown";
  return [
    `## 🔬 RH Token Analysis — ${r.symbol}${r.name ? ` (${r.name})` : ""}`,
    `\`${r.address}\` · chain 4663`,
    "",
    `**Price**: ${dex.priceUsd ? "$" + dex.priceUsd : "?"} · **24h**: ${fmtPct(dex.priceChange?.h24)} · **1h**: ${fmtPct(dex.priceChange?.h1)}`,
    `**Liquidity**: $${fmtUsd(dex.liquidity?.usd ?? 0)} · **Vol 24h**: $${fmtUsd(dex.volume?.h24 ?? 0)}`,
    `**FDV**: $${fmtUsd(dex.fdv ?? 0)} · **MCap**: $${fmtUsd(dex.marketCap ?? 0)}`,
    `**Txns 24h**: ${dex.txns?.h24?.buys ?? 0} buys / ${dex.txns?.h24?.sells ?? 0} sells · ${ageLine}`,
    "",
    `### Risk: ${tier} — ${score}/100`,
    ...flags.map((f) => `- ${f}`),
    "",
    `**Market data only (DexScreener).** For a full verdict also run:`,
    `- \`audit_contract\` — honeypot / mint authority / owner privileges`,
    `- \`deep_research\` or \`web_scrape\` — X/Twitter sentiment & narrative`,
    "",
    `**Pair chart**: ${RH_EXPLORER}/address/${dex.pairAddress}`,
    "",
    `_Heuristic pre-screen, not financial advice. Thin RH-chain liquidity = elevated rug risk. Verify the contract address before trading._`,
  ].join("\n");
}

function parseHumanToWei(amount: string, decimals = 18): string {
  const a = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(a)) throw new Error(`Invalid amount: ${amount}`);
  return ethers.parseUnits(a, decimals).toString();
}

function formatWei(raw: string, decimals = 18, maxFrac = 6): string {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  } catch {
    return raw;
  }
}

// Some networks can't reach the RH RPC at all (e.g. ISPs that DNS-block
// robinhood.com), which would break balances, approvals and broadcasting. Probe
// once, then transparently relay through Convex — which can reach it — instead.
const RH_RPC_RELAY = `${CONVEX_SITE}/mcp/rh/rpc`;
let _rhRpcMode: "direct" | "relay" | null = null;

async function rhRpcMode(): Promise<"direct" | "relay"> {
  if (_rhRpcMode) return _rhRpcMode;
  try {
    const res = await fetch(RH_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      _rhRpcMode = "direct";
      return _rhRpcMode;
    }
  } catch {
    /* blocked or unreachable → relay */
  }
  _rhRpcMode = "relay";
  return _rhRpcMode;
}

/** Auth header for the Convex relay (session token or API key). */
function rhRelayHeaders(): Record<string, string> {
  const token = getSavedToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Provider that works on both paths — relays via Convex when RPC is blocked. */
async function rhProviderAsync(): Promise<ethers.JsonRpcProvider> {
  if ((await rhRpcMode()) === "direct") {
    return new ethers.JsonRpcProvider(RH_RPC, RH_CHAIN_ID);
  }
  const req = new ethers.FetchRequest(RH_RPC_RELAY);
  for (const [k, v] of Object.entries(rhRelayHeaders())) req.setHeader(k, v);
  return new ethers.JsonRpcProvider(req, RH_CHAIN_ID);
}

async function rhRpc(method: string, params: unknown[]): Promise<any> {
  const relay = (await rhRpcMode()) === "relay";
  const url = relay ? RH_RPC_RELAY : RH_RPC;
  const res = await fetch(url, {
    method: "POST",
    headers: relay ? rhRelayHeaders() : { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RH RPC HTTP ${res.status}${relay ? " (via relay)" : ""}`);
  const data = (await res.json()) as any;
  if (data.error) throw new Error(data.error.message ?? "RH RPC error");
  return data.result;
}

function encodeBalanceOf(addr: string): string {
  return "0x70a08231" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

/** Raw ERC-20 balanceOf(owner) on RH chain (wei). 0n on any failure. */
export async function rhErc20Balance(token: string, owner: string): Promise<bigint> {
  try {
    const hex = await rhRpc("eth_call", [{ to: token, data: encodeBalanceOf(owner) }, "latest"]);
    if (hex && hex !== "0x") return BigInt(hex);
  } catch {
    /* 0 */
  }
  return 0n;
}

/** Current USD price of a token on RH chain via DexScreener, or null. */
export async function rhPriceUsd(address: string): Promise<number | null> {
  const dex = await dexTokenBest(address);
  const p = dex?.priceUsd != null ? Number(dex.priceUsd) : NaN;
  return isFinite(p) ? p : null;
}

async function fetchRhBalances(address: string): Promise<string> {
  if (!isAddress(address)) return "Invalid address.";
  let ethStr = "?";
  try {
    const hex = await rhRpc("eth_getBalance", [address, "latest"]);
    ethStr = (Number(BigInt(hex)) / 1e18).toFixed(6);
  } catch (e: any) {
    ethStr = `error: ${e?.message ?? "rpc"}`;
  }

  // Blockscout lists EVERY token held, not just the 18-stock catalog — the old
  // per-catalog RPC loop was blind to arbitrary crypto we can now trade. It's
  // also 1 request instead of 18, and stays reachable when the RPC is blocked.
  const holdings: Array<{ symbol: string; bal: string; address: string }> = [];
  try {
    const res = await fetch(`${RH_BLOCKSCOUT_V2}/addresses/${address}/token-balances`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const items: any[] = Array.isArray(data) ? data : (data?.items ?? []);
      for (const it of items) {
        const tk = it?.token ?? {};
        if (tk.type && String(tk.type).toUpperCase() !== "ERC-20") continue;
        const dec = Number(tk.decimals ?? 18);
        const raw = String(it?.value ?? "0");
        let bal = 0;
        try {
          bal = Number(ethers.formatUnits(raw, isFinite(dec) ? dec : 18));
        } catch {
          continue;
        }
        if (bal > 1e-9) {
          holdings.push({
            symbol: tk.symbol ?? "?",
            bal: bal.toLocaleString(undefined, { maximumFractionDigits: 6 }),
            address: tk.address_hash ?? tk.address ?? "",
          });
        }
      }
      holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
  } catch {
    /* fall through — ETH balance still reported */
  }

  const lines = [
    `**Wallet**: \`${address}\``,
    ``,
    `**Balances on Robinhood Chain (${RH_CHAIN_ID}):**`,
    `- ETH (gas): ${ethStr}`,
  ];
  if (holdings.length === 0) lines.push(`- (no token balances)`);
  else for (const h of holdings) lines.push(`- ${h.symbol}: ${h.bal}  \`${h.address}\``);
  lines.push(``, `_RPC: ${RH_RPC}_`, `_Explorer: ${RH_EXPLORER}/address/${address}_`);
  return lines.join("\n");
}

// ─── Onchain safety scan (Blockscout + DexScreener; free, no LLM) ─────────────
const RH_BLOCKSCOUT_V2 = "https://robinhoodchain.blockscout.com/api/v2";

interface RhSafety {
  verified: boolean | null;
  contractName: string | null;
  reputation: string | null;
  holdersCount: number | null;
  creator: string | null;
  launchpad: RhLaunchpad | null;
}

// Factory address → launchpad. Keyed lowercase. Only put an entry here once the
// factory has been read off-chain on 4663 — a wrong mapping silently mislabels
// every token a factory ever deployed.
// Observed empirically by sampling recent deployments, not taken from docs.
// Add an entry only after seeing the factory actually deploy a live token.
const LAUNCHPAD_FACTORIES: Record<string, { label: string; note?: string }> = {
  "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": {
    label: "Pons",
    note: "PonsLaunchFactory — the dominant launchpad on this chain",
  },
  "0x1b37d3a72082029c44b35b604ea473617580b69a": {
    label: "Doppler (Whetstone)",
    note: "Bankr routes launches through Doppler — a Doppler factory alone does not prove a Bankr launch",
  },
  "0x120caef934797423479fcd0c5d71d36b0282736e": {
    label: "Unverified factory (MemeSoft tokens)",
    note: "Deploys contracts named MemeSoft; operator not yet identified — treat as unbranded",
  },
};

// Fallback when the factory address is unknown but its contract is verified and named.
const LAUNCHPAD_NAME_HINTS: Array<[RegExp, string]> = [
  [/pons/i, "Pons"],
  [/doppler/i, "Doppler (Whetstone)"],
  [/bankr/i, "Bankr"],
  [/\bnox\b|noxa/i, "Noxa"],
  [/clanker/i, "Clanker"],
  [/virtuals?/i, "Virtuals"],
  [/flap/i, "Flap"],
  [/memesoft/i, "MemeSoft"],
];

export interface RhLaunchpad {
  label: string;
  factory: string | null;
  factoryName: string | null;
  confidence: "confirmed" | "likely" | "unknown" | "self-deployed";
  note?: string;
}

async function detectLaunchpad(creator: string | null): Promise<RhLaunchpad | null> {
  if (!creator) return null;

  const known = LAUNCHPAD_FACTORIES[creator.toLowerCase()];
  if (known) {
    return { label: known.label, factory: creator, factoryName: null, confidence: "confirmed", note: known.note };
  }

  let isContract = false;
  let factoryName: string | null = null;
  try {
    const r = await fetch(`${RH_BLOCKSCOUT_V2}/addresses/${creator}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const c: any = await r.json();
      isContract = c?.is_contract === true;
      factoryName = c?.name ?? null;
    }
  } catch {
    /* fall through to unknown */
  }

  if (!isContract) {
    return { label: "None — self-deployed", factory: creator, factoryName: null, confidence: "self-deployed" };
  }

  const hit = factoryName ? LAUNCHPAD_NAME_HINTS.find(([re]) => re.test(factoryName!)) : undefined;
  if (hit) return { label: hit[1], factory: creator, factoryName, confidence: "likely" };

  return { label: "Unrecognized factory", factory: creator, factoryName, confidence: "unknown" };
}

async function blockscoutSafety(address: string): Promise<RhSafety> {
  const out: RhSafety = {
    verified: null,
    contractName: null,
    reputation: null,
    holdersCount: null,
    creator: null,
    launchpad: null,
  };
  try {
    const r = await fetch(`${RH_BLOCKSCOUT_V2}/tokens/${address}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const t: any = await r.json();
      out.reputation = t?.reputation ?? null;
      out.holdersCount = t?.holders_count != null ? Number(t.holders_count) : null;
    }
  } catch {
    /* ignore */
  }
  // Use /addresses/{ca} (~1KB) NOT /smart-contracts/{ca} — the latter ships the
  // entire Solidity source and intermittently returns a truncated body on HTTP 200,
  // which silently nulled contractName and skipped the launchpad/privilege flags.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${RH_BLOCKSCOUT_V2}/addresses/${address}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (r.ok) {
        const c: any = await r.json();
        out.verified = c?.is_verified ?? null;
        out.contractName = c?.name ?? null;
        out.creator = c?.creator_address_hash ?? null;
        break;
      }
      if (r.status === 404) {
        out.verified = false; // address has no contract record
        break;
      }
    } catch {
      /* retry once */
    }
  }
  out.launchpad = await detectLaunchpad(out.creator);
  return out;
}

function assessSafety(
  safety: RhSafety,
  dex: DexPair | null
): { score: number; tier: string; flags: string[] } {
  let score = 0;
  const flags: string[] = [];

  if (safety.verified === false) { score += 20; flags.push("🔴 Contract NOT verified on explorer"); }
  else if (safety.verified === true) { flags.push("🟢 Contract verified"); }
  else { flags.push("⚪ Verification unknown"); }

  const rep = (safety.reputation ?? "").toLowerCase();
  if (rep && rep !== "ok" && rep !== "neutral") { score += 30; flags.push(`🔴 Explorer reputation: "${safety.reputation}"`); }
  else if (rep) { flags.push(`🟢 Explorer reputation: ${safety.reputation}`); }

  if (safety.holdersCount != null) {
    if (safety.holdersCount < 25) { score += 25; flags.push(`🔴 Very few holders (${safety.holdersCount}) — high concentration / rug risk`); }
    else if (safety.holdersCount < 200) { score += 12; flags.push(`🟠 Few holders (${safety.holdersCount})`); }
    else { flags.push(`🟢 Holders: ${safety.holdersCount.toLocaleString()}`); }
  } else {
    flags.push("⚪ Holder count unavailable");
  }

  const nm = (safety.contractName ?? "").toLowerCase();
  if (/mint|burn|blacklist|pausable|pause|ownable|\btax\b|\bfee\b/.test(nm)) {
    score += 14;
    flags.push(`🟠 Contract name implies owner privileges ("${safety.contractName}") — possible mint/burn/blacklist/tax; verify source before trusting`);
  }

  // On Robinhood Chain essentially every token ships through a launchpad
  // (Pons, Bankr/Doppler, Flap, Virtuals…), so a launchpad deploy is the NORM,
  // not a red flag — scoring it as risk penalised every normal token and made
  // the number stop discriminating. The anomaly here is the opposite: a token
  // deployed straight from an EOA answers to no launchpad rules, and the
  // deployer keeps full control of supply and liquidity.
  const lp = safety.launchpad;
  if (lp?.confidence === "confirmed" || lp?.confidence === "likely") {
    flags.push(
      `🟢 Launched via ${lp.label}${lp.confidence === "likely" ? " (probable)" : ""} — standard for this chain` +
        (lp.note ? ` · ${lp.note}` : "")
    );
  } else if (lp?.confidence === "unknown") {
    score += 10;
    flags.push(
      `🟠 Deployed by an unrecognized factory (\`${lp.factory}\`) — not a known launchpad on this chain; verify who runs it`
    );
  } else if (lp?.confidence === "self-deployed") {
    score += 18;
    flags.push(
      `🔴 Self-deployed from an EOA (\`${lp.factory}\`) — no launchpad rules apply. ` +
        `Unusual on this chain: the deployer retains full control over supply and liquidity`
    );
  }

  if (dex) {
    const buys = dex.txns?.h24?.buys ?? 0;
    const sells = dex.txns?.h24?.sells ?? 0;
    if (buys > 5 && sells === 0) { score += 30; flags.push(`🔴 Honeypot suspicion: ${buys} buys but 0 sells in 24h — may be unsellable`); }
    else if (sells > 0) { flags.push(`🟢 Sellable: ${sells} sell(s) in 24h — holders can exit`); }
  }

  score = Math.min(100, score);
  const tier = score >= 60 ? "🔴 DANGER" : score >= 35 ? "🟠 CAUTION" : score >= 15 ? "🟡 SOME RISK" : "🟢 LOOKS OK";
  return { score, tier, flags };
}

// structuredContent payload for rh_safety_check. `tier` is the assessSafety
// label with its leading emoji stripped so consumers get a clean enum
// ("DANGER"/"CAUTION"/"SOME RISK"/"LOOKS OK") - single source, no threshold
// logic duplicated here.
export function buildRhSafetyStructured(
  r: ResolvedToken,
  safety: RhSafety,
  assessment: { score: number; tier: string; flags: string[] },
): Record<string, unknown> {
  return {
    address:      r.address,
    symbol:       r.symbol ?? null,
    name:         r.name ?? null,
    riskScore:    assessment.score,
    tier:         assessment.tier.replace(/^\S+\s+/, ""),
    verified:     safety.verified,
    contractName: safety.contractName,
    reputation:   safety.reputation,
    holdersCount: safety.holdersCount,
    creator:      safety.creator,
    launchpad:    safety.launchpad,
    flags:        assessment.flags,
  };
}

function renderSafety(
  r: ResolvedToken,
  safety: RhSafety,
  assessment: { score: number; tier: string; flags: string[] },
): string {
  const { score, tier, flags } = assessment;
  return [
    `## 🛡️ RH Safety Check — ${r.symbol}${r.name ? ` (${r.name})` : ""}`,
    `\`${r.address}\` · chain 4663${safety.contractName ? ` · contract \`${safety.contractName}\`` : ""}`,
    "",
    `### Safety: ${tier} — ${score}/100 risk`,
    ...flags.map((f) => `- ${f}`),
    "",
    `**Onchain data only (Blockscout + DexScreener) — no LLM, no paid API.**`,
    `For market/liquidity read run \`rh_analyze\`; for X/narrative add \`web_search\` or \`deep_research\`.`,
    `**Explorer**: ${RH_EXPLORER}/token/${r.address}`,
    "",
    `_Heuristic — not a full audit. A verified, high-holder, sellable token can still dump. Verify the CA._`,
  ].join("\n");
}


async function quoteRh(args: {
  fromToken: string;
  toToken: string;
  amount: string;
  maxSlippagePct?: number;
  taker: string;
}): Promise<any> {
  const from = await resolveTokenSmart(args.fromToken);
  const to = await resolveTokenSmart(args.toToken);
  if (from.kind === to.kind) {
    throw new Error("RH swaps route ETH ↔ token. Buy a token with ETH, or sell a token for ETH.");
  }
  const sellAmount = parseHumanToWei(args.amount, from.decimals);
  const slippageBps = Math.round((args.maxSlippagePct ?? 2.0) * 100);
  const result = await callConvex(
    "/mcp/rh/quote",
    "POST",
    {
      sellToken: from.address,
      buyToken: to.address,
      sellAmount,
      taker: args.taker,
      slippageBps,
      fromSymbol: from.symbol,
      toSymbol: to.symbol,
    },
    "rh_mcp_estimate"
  );
  if (result.error) throw new Error(result.error);
  return { ...result, from, to, sellAmount, slippageBps };
}

/** Plain ERC-20 approval for routers that pull via transferFrom (SwapRouter02). */
async function ensureDirectApproval(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  token: string,
  spender: string,
  amountWei: bigint
): Promise<string[]> {
  const provider = await rhProviderAsync();
  const signer = wallet.connect(provider);
  const erc20 = new ethers.Contract(
    token,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    signer
  );
  const allowance: bigint = await erc20.allowance(wallet.address, spender);
  if (allowance >= amountWei) return [];
  const tx = await erc20.approve(spender, ethers.MaxUint256);
  await tx.wait();
  return [tx.hash];
}

async function ensureSellApprovals(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  token: string,
  amountWei: bigint
): Promise<string[]> {
  const provider = await rhProviderAsync();
  const signer = wallet.connect(provider);
  const hashes: string[] = [];

  const erc20 = new ethers.Contract(
    token,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    signer
  );
  const allowance: bigint = await erc20.allowance(wallet.address, RH_PERMIT2);
  if (allowance < amountWei) {
    const tx = await erc20.approve(RH_PERMIT2, ethers.MaxUint256);
    await tx.wait();
    hashes.push(tx.hash);
  }

  // Permit2.approve(token, spender, amount, expiration) selector 0x87517c45
  const permit2 = new ethers.Contract(
    RH_PERMIT2,
    [
      "function approve(address token, address spender, uint160 amount, uint48 expiration)",
      "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
    ],
    signer
  );
  try {
    const al = await permit2.allowance(wallet.address, token, RH_UNIVERSAL_ROUTER);
    const amt = BigInt(al.amount ?? al[0] ?? 0);
    const exp = Number(al.expiration ?? al[1] ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (amt >= amountWei && exp > now + 60) return hashes;
  } catch {
    /* re-approve */
  }
  const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30d
  // uint160 max for amount
  const max160 = (1n << 160n) - 1n;
  const tx2 = await permit2.approve(token, RH_UNIVERSAL_ROUTER, max160, expiration);
  await tx2.wait();
  hashes.push(tx2.hash);
  return hashes;
}

/**
 * Wait for the swap receipt and read back what actually happened on-chain.
 *
 * A quote is a prediction; a receipt is proof. Reporting only the quoted amount
 * leaves the user unable to tell a real fill from a fabricated one, so we
 * surface the mined status, block, gas, and the ACTUAL amount credited —
 * parsed from the token's Transfer logs (buys) or the ETH balance delta (sells).
 */
async function confirmRhSwap(
  txHash: string,
  walletAddress: string,
  to: ResolvedToken,
  ethBefore: bigint | null
): Promise<{
  mined: boolean;
  ok?: boolean;
  block?: number;
  gasUsed?: string;
  received?: string;
}> {
  try {
    const provider = await rhProviderAsync();
    const receipt = await provider.waitForTransaction(txHash, 1, 90_000);
    if (!receipt) return { mined: false };

    let received: string | undefined;
    if (to.kind === "token") {
      // Sum Transfer(_, me, value) emitted by the bought token.
      const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
      const me = walletAddress.toLowerCase();
      let total = 0n;
      for (const log of receipt.logs ?? []) {
        if (log.address?.toLowerCase() !== to.address.toLowerCase()) continue;
        if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
        const dest = "0x" + log.topics[2].slice(-40);
        if (dest.toLowerCase() !== me) continue;
        try {
          total += BigInt(log.data);
        } catch {
          /* skip malformed */
        }
      }
      if (total > 0n) received = ethers.formatUnits(total, to.decimals);
    } else if (ethBefore != null) {
      // Selling for native ETH: credited amount = delta + gas actually burned.
      try {
        const after = BigInt(await rhRpc("eth_getBalance", [walletAddress, "latest"]));
        const fee = BigInt(receipt.gasUsed ?? 0n) * BigInt(receipt.gasPrice ?? 0n);
        const delta = after - ethBefore + fee;
        if (delta > 0n) received = ethers.formatEther(delta);
      } catch {
        /* balance read optional */
      }
    }

    return {
      mined: true,
      ok: receipt.status === 1,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
      received,
    };
  } catch {
    return { mined: false };
  }
}

async function broadcastRhSwap(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  tx: { to: string; data: string; value: string; gas?: string }
): Promise<string> {
  const provider = await rhProviderAsync();
  const signer = wallet.connect(provider);
  // "pending" (not "latest") so sequential swaps in one orders-tick get
  // incrementing nonces instead of colliding on the same unmined nonce.
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const fee = await provider.getFeeData();
  const signed = await signer.signTransaction({
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value || "0"),
    gasLimit: BigInt(tx.gas || "650000"),
    maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 100_000_000n,
    nonce,
    chainId: RH_CHAIN_ID,
    type: 2,
  });
  const resp = await rhRpc("eth_sendRawTransaction", [signed]);
  return resp as string;
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
          `**RPC**: ${RH_RPC}`,
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
