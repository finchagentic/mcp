// Tool definitions for the rh_mcp_* / rh_* namespace. Pure data — no logic.

import { Tool } from "@modelcontextprotocol/sdk/types.js";

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
