// Pure helpers for trading Finch-launched tokens on Uniswap v4 (Base + Robinhood Chain):
// chain constants, pool key / id, slippage + min-out math, price impact, quoteId and the
// Universal Router calldata encoders. No network, no wallet, no env reads except where noted.
//
// Encoding is ported from the production backend (finchagentic convex/walletActions.ts for the
// Base Universal Router, convex/_walletRhDex.ts for Robinhood):
//   V4 actions   = SWAP_EXACT_IN(0x07) | SWAP_EXACT_IN_SINGLE(0x06), SETTLE_ALL(0x0c), TAKE_ALL(0x0f)
//   UR commands  = V4_SWAP(0x10) [+ SWEEP(0x04) on Base when native ETH is the input]
//   SETTLE_ALL   = abi.encode(address currencyIn,  uint256 amountIn)
//   TAKE_ALL     = abi.encode(address currencyOut, uint256 minAmountOut)
//   V4_SWAP in   = abi.encode(bytes actions, bytes[] params)
//   SWEEP        = abi.encode(address ETH, address recipient, uint160 0)

import { ethers } from "ethers";

export type LaunchChain = "base" | "robinhood";

export const FINCH_FACTORY = "0x815542E8b392389A1389E22E588E4B62A67Ade72";
export const FINCH_LOCKER = "0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a";
export const TICK_SPACING = 200;
export const ETH_ADDR = ethers.ZeroAddress;
export const USDG_ROBINHOOD = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT160_MAX = (1n << 160n) - 1n;

export const DEFAULT_SLIPPAGE_BPS = 100;     // 1%
export const MAX_SLIPPAGE_BPS = 500;         // 5% hard ceiling
export const MAX_PRICE_IMPACT_BPS = 500;     // refuse > 5% price impact
export const MAX_QUOTE_DRIFT_BPS = 50;       // 0.5% worse min-out between preview and execution

export interface ChainCfg {
  key: LaunchChain;
  chainId: number;
  rpc: string;
  explorer: string;
  universalRouter: string;
  permit2: string;
  /** Uniswap v4 Quoter (eth_getCode verified, see report). */
  quoter: string;
  stateView: string;
  /** "path": SWAP_EXACT_IN (0x07) with a 1-hop path. "single": SWAP_EXACT_IN_SINGLE (0x06). */
  swapLayout: "path" | "single";
  /** SWEEP(ETH) after V4_SWAP when native ETH is the input (matches the backend per chain). */
  sweepOnEthIn: boolean;
  quotes: { key: "eth" | "usdg"; address: string; decimals: number; symbol: string }[];
}

export const CHAINS: Record<LaunchChain, ChainCfg> = {
  base: {
    key: "base", chainId: 8453,
    rpc: process.env.FINCH_RPC_URL || "https://mainnet.base.org",
    explorer: "https://basescan.org",
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    permit2: PERMIT2,
    quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    stateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
    swapLayout: "path", sweepOnEthIn: true,
    quotes: [{ key: "eth", address: ETH_ADDR, decimals: 18, symbol: "ETH" }],
  },
  robinhood: {
    key: "robinhood", chainId: 4663,
    rpc: process.env.FINCH_RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    permit2: PERMIT2,
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    swapLayout: "single", sweepOnEthIn: false,
    quotes: [
      { key: "eth", address: ETH_ADDR, decimals: 18, symbol: "ETH" },
      { key: "usdg", address: USDG_ROBINHOOD, decimals: 6, symbol: "USDG" },
    ],
  },
};

export function parseChain(v: unknown): LaunchChain {
  if (v === "base" || v === "robinhood") return v;
  throw new Error('chain must be "base" or "robinhood".');
}

export function quoteMeta(chain: LaunchChain, quoteAddr: string): ChainCfg["quotes"][number] | null {
  const q = quoteAddr.toLowerCase();
  return CHAINS[chain].quotes.find((x) => x.address.toLowerCase() === q) ?? null;
}

// ── Slippage / min-out math (bigint only, floor rounding) ────────────────────

/** Slippage percent (e.g. 1 or "0.5") -> integer bps. Default 1%, hard ceiling 5%. */
export function slippagePctToBps(v: unknown): number {
  if (v === undefined || v === null || v === "") return DEFAULT_SLIPPAGE_BPS;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error("slippagePct must be a positive number.");
  const bps = Math.round(n * 100);
  if (bps < 1) throw new Error("slippagePct is too small (minimum 0.01).");
  if (bps > MAX_SLIPPAGE_BPS) throw new Error(`slippagePct ${n} exceeds the hard ceiling of ${MAX_SLIPPAGE_BPS / 100}%.`);
  return bps;
}

/** minOut = quote * (10000 - slippageBps) / 10000, rounded DOWN. */
export function minOutFromQuote(quote: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new Error("slippageBps out of range.");
  if (quote < 0n) throw new Error("quote must be non-negative.");
  return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Spot-price (no fee, no impact) output for amountIn from slot0 sqrtPriceX96. zeroForOne = currency0 in. */
export function spotOut(sqrtPriceX96: bigint, zeroForOne: boolean, amountIn: bigint): bigint {
  const q192 = 1n << 192n;
  const p = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amountIn * p) / q192 : (amountIn * q192) / p;
}

/** Price impact in bps vs the pool's current spot price, after removing the LP fee. >= 0, rounded UP. */
export function priceImpactBps(sqrtPriceX96: bigint, zeroForOne: boolean, amountIn: bigint, amountOut: bigint, lpFeePips: number): number {
  if (sqrtPriceX96 <= 0n) throw new Error("Pool has no price (not initialised).");
  const expected = (spotOut(sqrtPriceX96, zeroForOne, amountIn) * BigInt(1_000_000 - lpFeePips)) / 1_000_000n;
  if (expected <= 0n) return 10_000;
  if (amountOut >= expected) return 0;
  const num = (expected - amountOut) * 10_000n;
  return Number((num + expected - 1n) / expected);
}

/** Drift check: new min-out must not be more than MAX_QUOTE_DRIFT_BPS worse than the previewed one. */
export function driftExceeded(previewMinOut: bigint, newMinOut: bigint): boolean {
  const floor = (previewMinOut * BigInt(10_000 - MAX_QUOTE_DRIFT_BPS)) / 10_000n;
  return newMinOut < floor;
}

// ── Pool key / id ────────────────────────────────────────────────────────────

export interface PoolKey { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }

export function finchPoolKey(quote: string, token: string, lpFee: number): PoolKey {
  return { currency0: ethers.getAddress(quote), currency1: ethers.getAddress(token), fee: lpFee, tickSpacing: TICK_SPACING, hooks: ETH_ADDR };
}
export function poolKeyTuple(k: PoolKey): [string, string, number, number, string] {
  return [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
}
export function poolIdOf(k: PoolKey): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], poolKeyTuple(k)));
}

// ── Calldata encoders ────────────────────────────────────────────────────────

const coder = ethers.AbiCoder.defaultAbiCoder();
const PATH_KEY_TYPE = "(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)";
const EXACT_IN_TYPE = `(address currencyIn, ${PATH_KEY_TYPE}[] path, uint128 amountIn, uint128 amountOutMinimum)`;
// Robinhood SWAP_EXACT_IN_SINGLE. The backend (buildRhV4SwapCalldata) encodes it FLAT (poolKey tuple, zeroForOne, amountIn,
// amountOutMin, minHopPriceX36=0, hookData) with NO struct offset word. The router reads word 0 as the struct offset, so the flat
// form only decodes because currency0 == native ETH == 0x0 == offset 0. We therefore emit the byte-identical flat form when
// currency0 is native ETH (production-proven) and the canonical struct-wrapped form otherwise (USDG-quoted pools, where flat
// would mis-decode). Both forms are proven by live eth_call simulation; see test/launchpad-swap-live.test.ts.
const POOL_KEY_TYPE = "(address,address,uint24,int24,address)";
const EXACT_IN_SINGLE_TYPE =
  "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)";

export interface PathHop { intermediateCurrency: string; fee: number; tickSpacing: number; hooks: string; hookData: string }

/** SWAP_EXACT_IN params (verbatim port of backend buildV4ExactInputParams' tail: uint128-capped, struct-wrapped). */
export function encodeExactInputParams(currencyIn: string, path: PathHop[], amountIn: bigint, amountOutMin: bigint): string {
  const safeIn = amountIn > UINT128_MAX ? UINT128_MAX : amountIn;
  const safeOut = amountOutMin > UINT128_MAX ? UINT128_MAX : amountOutMin;
  return coder.encode([EXACT_IN_TYPE], [{ currencyIn, path, amountIn: safeIn, amountOutMinimum: safeOut }]);
}

export function encodeExactInputSingleParams(key: PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMin: bigint): string {
  if (key.currency0 === ETH_ADDR) {
    return coder.encode([POOL_KEY_TYPE, "bool", "uint128", "uint128", "uint256", "bytes"], [poolKeyTuple(key), zeroForOne, amountIn, amountOutMin, 0, "0x"]);
  }
  return coder.encode([EXACT_IN_SINGLE_TYPE], [{ poolKey: poolKeyTuple(key), zeroForOne, amountIn, amountOutMinimum: amountOutMin, minHopPriceX36: 0n, hookData: "0x" }]);
}

export interface SwapBuild {
  to: string;
  data: string;
  /** decimal string of wei to send (ETH in) or "0" */
  value: string;
  commands: string;
  currencyIn: string;
  currencyOut: string;
  /** ERC-20 input requiring Permit2 allowance for the router (null when ETH in). */
  permit2Token: string | null;
}

export interface SwapInput {
  chain: LaunchChain;
  side: "buy" | "sell";
  quote: string;
  token: string;
  lpFee: number;
  amountIn: bigint;
  minOut: bigint;
  /** sweep recipient for ETH-in; the signer. */
  recipient: string;
  deadline: bigint;
}

export function buildSwap(i: SwapInput): SwapBuild {
  const cfg = CHAINS[i.chain];
  const key = finchPoolKey(i.quote, i.token, i.lpFee);
  const zeroForOne = i.side === "buy"; // currency0 = quote, currency1 = token
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  if (i.amountIn <= 0n) throw new Error("amountIn must be positive.");
  if (i.minOut <= 0n) throw new Error("minOut must be positive.");
  if (i.amountIn > UINT128_MAX || i.minOut > UINT128_MAX) throw new Error("amount exceeds uint128.");

  const swapParams = cfg.swapLayout === "path"
    ? encodeExactInputParams(currencyIn, [{ intermediateCurrency: currencyOut, fee: key.fee, tickSpacing: TICK_SPACING, hooks: ETH_ADDR, hookData: "0x" }], i.amountIn, i.minOut)
    : encodeExactInputSingleParams(key, zeroForOne, i.amountIn, i.minOut);
  const actions = cfg.swapLayout === "path" ? "0x070c0f" : "0x060c0f";
  const settle = coder.encode(["address", "uint256"], [currencyIn, i.amountIn]);
  const take = coder.encode(["address", "uint256"], [currencyOut, i.minOut]);
  const v4Input = coder.encode(["bytes", "bytes[]"], [actions, [swapParams, settle, take]]);

  const ethIn = currencyIn === ETH_ADDR;
  const sweep = ethIn && cfg.sweepOnEthIn;
  const commands = sweep ? "0x1004" : "0x10";
  const inputs = sweep
    ? [v4Input, coder.encode(["address", "address", "uint160"], [ETH_ADDR, ethers.getAddress(i.recipient), 0n])]
    : [v4Input];
  const data = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]).encodeFunctionData("execute", [commands, inputs, i.deadline]);
  return { to: cfg.universalRouter, data, value: ethIn ? i.amountIn.toString() : "0", commands, currencyIn, currencyOut, permit2Token: ethIn ? null : currencyIn };
}

/** Deterministic id binding a preview to its execution (sol_swap style). */
export function swapQuoteId(q: { chain: string; token: string; side: string; amountIn: bigint; minOut: bigint; slippageBps: number }): string {
  return ethers.id([q.chain, q.token.toLowerCase(), q.side, q.amountIn.toString(), q.minOut.toString(), String(q.slippageBps)].join("|")).slice(2, 18);
}
