// launchpad_buy / launchpad_sell: trade tokens launched by the Finch factory (Uniswap v4, Base + Robinhood
// Chain) from the LOCAL wallet. Default-deny spend gate, preview-vs-confirmed, quoteId binding, price-impact and
// drift refusal, eth_call simulation before sending. The private key never leaves wallet.ts.

import { ethers } from "ethers";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { getOrCreateWallet } from "../wallet.js";
import {
  CHAINS, FINCH_FACTORY, ETH_ADDR, PERMIT2, UINT160_MAX, MAX_PRICE_IMPACT_BPS, MAX_QUOTE_DRIFT_BPS,
  LaunchChain, ChainCfg, parseChain, quoteMeta, slippagePctToBps, minOutFromQuote, priceImpactBps, driftExceeded,
  finchPoolKey, poolIdOf, poolKeyTuple, buildSwap, swapQuoteId, SwapBuild,
} from "../launchpad-v4.js";
import { handleSolanaBuy, handleSolanaSell } from "./launchpad-solana.js";

// ── Output helpers (same shape as solana.ts) ─────────────────────────────────
function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}
function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${String((e as any)?.message ?? e)}` }], isError: true };
}
function blocked(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: `⛔ NOT EXECUTED — confirmation required.\n\n${text}\n\nRe-run with confirmed=true and the quoteId after the user has approved these exact details.` }], ...(structured ? { structuredContent: { executed: false, ...structured } } : {}) };
}
const q = (s: unknown) => JSON.stringify(String(s)); // user/chain-supplied strings are DATA: always JSON-quoted

// ── Spend gate & caps (default-deny) ─────────────────────────────────────────
export function assertSpendAllowed(tool: string): void {
  if (process.env.FINCH_LAUNCHPAD_ALLOW_SPEND !== "1") {
    throw new Error(
      `${tool} is disabled: spending from the local EVM wallet is default-deny. ` +
      "To enable it, the human operator must set FINCH_LAUNCHPAD_ALLOW_SPEND=1 in the MCP server config and restart. " +
      "Per-buy caps: FINCH_LAUNCHPAD_MAX_BUY_ETH (default 0.05) and FINCH_LAUNCHPAD_MAX_BUY_USDG (default 100).",
    );
  }
}
const spendEnabled = () => process.env.FINCH_LAUNCHPAD_ALLOW_SPEND === "1";
/** Cap in raw units. Unset/empty -> default; junk/negative -> throws (fail closed). */
export function capFromEnv(name: string, dflt: string, decimals: number): bigint {
  const raw = process.env[name];
  const s = raw === undefined || raw.trim() === "" ? dflt : raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${name}=${q(s)} is not a valid non-negative decimal number; refusing to proceed (fail closed).`);
  return ethers.parseUnits(s, decimals); // throws if more fractional digits than the asset has
}
export const maxBuyRaw = (quoteKey: "eth" | "usdg"): bigint =>
  quoteKey === "eth" ? capFromEnv("FINCH_LAUNCHPAD_MAX_BUY_ETH", "0.05", 18) : capFromEnv("FINCH_LAUNCHPAD_MAX_BUY_USDG", "100", 6);

// ── JSON-RPC over fetch (mockable) ───────────────────────────────────────────
let rpcId = 1;
export async function rpc(chain: LaunchChain, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(CHAINS[chain].rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (!res.ok) throw new Error(`${chain} RPC HTTP ${res.status}`);
  const j: any = await res.json();
  if (j.error) throw new Error(`${chain} RPC ${method} failed: ${String(j.error.message ?? "error").slice(0, 200)}`);
  return j.result;
}
const ethCall = (chain: LaunchChain, to: string, data: string, from?: string, value?: string, overrides?: unknown) =>
  rpc(chain, "eth_call", [{ to, data, ...(from ? { from } : {}), ...(value && value !== "0" ? { value: "0x" + BigInt(value).toString(16) } : {}) }, "latest", ...(overrides ? [overrides] : [])]) as Promise<string>;

const FACTORY_IFACE = new ethers.Interface(["function infoOf(address) view returns (uint256 tokenId,address launcher,address quote,int24 startTick,uint24 lpFee)"]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
]);
const P2_IFACE = new ethers.Interface([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
const QUOTER_IFACE = new ethers.Interface(["function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)"]);
const STATEVIEW_IFACE = new ethers.Interface(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"]);

// ── Token resolution: ONLY tokens launched by the Finch factory ──────────────
export interface LaunchInfo { token: string; quote: string; quoteKey: "eth" | "usdg"; quoteDecimals: number; quoteSymbol: string; lpFee: number; launcher: string; tokenDecimals: number; symbol: string }

export async function resolveLaunch(chain: LaunchChain, tokenIn: unknown): Promise<LaunchInfo> {
  if (typeof tokenIn !== "string" || !ethers.isAddress(tokenIn)) throw new Error("token must be a 0x EVM address.");
  const token = ethers.getAddress(tokenIn);
  const raw = await ethCall(chain, FINCH_FACTORY, FACTORY_IFACE.encodeFunctionData("infoOf", [token]));
  const info = FACTORY_IFACE.decodeFunctionResult("infoOf", raw);
  if (BigInt(info.tokenId) === 0n) throw new Error(`Refused: ${q(token)} was not launched by the Finch launch factory on ${chain}. Only Finch-launched tokens can be traded with this tool.`);
  const quoteAddr = ethers.getAddress(info.quote);
  const qm = quoteMeta(chain, quoteAddr);
  if (!qm) throw new Error(`Refused: the launch uses quote asset ${quoteAddr}, which this tool does not support on ${chain}.`);
  const code = await rpc(chain, "eth_getCode", [token, "latest"]);
  if (!code || code === "0x") throw new Error("Refused: token has no contract code.");
  let tokenDecimals = 18;
  try { tokenDecimals = Number(ERC20.decodeFunctionResult("decimals", await ethCall(chain, token, ERC20.encodeFunctionData("decimals")))[0]); } catch { /* default 18 */ }
  let symbol = "?";
  try { symbol = String(ERC20.decodeFunctionResult("symbol", await ethCall(chain, token, ERC20.encodeFunctionData("symbol")))[0]).slice(0, 32); } catch { /* optional */ }
  return { token, quote: quoteAddr, quoteKey: qm.key, quoteDecimals: qm.decimals, quoteSymbol: qm.symbol, lpFee: Number(info.lpFee), launcher: info.launcher, tokenDecimals, symbol };
}

// ── Quote (Uniswap v4 Quoter) + price impact (StateView slot0) ───────────────
export interface PoolQuote { amountOut: bigint; gasEstimate: bigint; impactBps: number }
export async function quoteSwap(chain: LaunchChain, li: LaunchInfo, side: "buy" | "sell", amountIn: bigint): Promise<PoolQuote> {
  const cfg = CHAINS[chain];
  const key = finchPoolKey(li.quote, li.token, li.lpFee);
  const zeroForOne = side === "buy";
  let amountOut: bigint, gasEstimate: bigint;
  try {
    const out = await ethCall(chain, cfg.quoter, QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{ poolKey: poolKeyTuple(key), zeroForOne, exactAmount: amountIn, hookData: "0x" }]));
    const r = QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", out);
    amountOut = BigInt(r[0]); gasEstimate = BigInt(r[1]);
  } catch (e) {
    throw new Error(`Could not get an on-chain quote (${String((e as any)?.message ?? e).slice(0, 160)}). The pool may have no liquidity for this size; nothing was sent.`);
  }
  if (amountOut <= 0n) throw new Error("The pool returned a zero quote for this size; nothing was sent.");
  const s0 = STATEVIEW_IFACE.decodeFunctionResult("getSlot0", await ethCall(chain, cfg.stateView, STATEVIEW_IFACE.encodeFunctionData("getSlot0", [poolIdOf(key)])));
  const impactBps = priceImpactBps(BigInt(s0[0]), zeroForOne, amountIn, amountOut, li.lpFee);
  return { amountOut, gasEstimate, impactBps };
}

// ── Preview bookkeeping (quoteId -> params) ──────────────────────────────────
interface Prev { chain: LaunchChain; token: string; side: "buy" | "sell"; amountIn: bigint; minOut: bigint; slippageBps: number; at: number }
const previews = new Map<string, Prev>();
const TTL_MS = 10 * 60_000;
function remember(p: Omit<Prev, "at">): string {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.at > TTL_MS) previews.delete(k);
  if (previews.size > 200) previews.delete(previews.keys().next().value as string);
  const id = swapQuoteId(p);
  previews.set(id, { ...p, at: now });
  return id;
}
export function _resetPreviews(): void { previews.clear(); }

const fmt = (v: bigint, d: number) => ethers.formatUnits(v, d);

// ── Shared flow ──────────────────────────────────────────────────────────────
async function waitReceipt(chain: LaunchChain, hash: string, timeoutMs = 90_000): Promise<{ ok: boolean; mined: boolean }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await rpc(chain, "eth_getTransactionReceipt", [hash]);
      if (r) return { mined: true, ok: parseInt(r.status, 16) === 1 };
    } catch { /* keep polling */ }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { mined: false, ok: false };
}

async function sendTx(chain: LaunchChain, wallet: ethers.Wallet | ethers.HDNodeWallet, to: string, data: string, value: bigint, gasLimit: bigint, gasPrice: bigint): Promise<string> {
  const nonce = parseInt(await rpc(chain, "eth_getTransactionCount", [wallet.address, "pending"]), 16);
  const signed = await wallet.signTransaction({ to, data, value, gasLimit, gasPrice, nonce, chainId: CHAINS[chain].chainId, type: 0 });
  return (await rpc(chain, "eth_sendRawTransaction", [signed])) as string;
}

async function estimateGas(chain: LaunchChain, from: string, to: string, data: string, value: bigint): Promise<bigint> {
  const g = await rpc(chain, "eth_estimateGas", [{ from, to, data, ...(value > 0n ? { value: "0x" + value.toString(16) } : {}) }]);
  return (BigInt(g) * 130n) / 100n;
}

const GAS_RESERVE_UNITS = 1_500_000n; // generous bound for approvals + swap

/** eth_call simulation of the exact UR execute() calldata. Exported for the mainnet proof script. */
export async function simulateSwap(chain: LaunchChain, from: string, b: SwapBuild, overrides?: unknown): Promise<string> {
  return ethCall(chain, b.to, b.data, from, b.value, overrides);
}

interface TradeArgs { chain: LaunchChain; side: "buy" | "sell"; li: LaunchInfo; amountIn: bigint; slippageBps: number; wallet: string; confirmed: boolean; quoteId?: string; sellPercent?: number }

function describe(a: TradeArgs, pq: PoolQuote, minOut: bigint, id: string): { text: string; structured: Record<string, unknown> } {
  const li = a.li;
  const inD = a.side === "buy" ? li.quoteDecimals : li.tokenDecimals;
  const outD = a.side === "buy" ? li.tokenDecimals : li.quoteDecimals;
  const inSym = a.side === "buy" ? li.quoteSymbol : li.symbol;
  const outSym = a.side === "buy" ? li.symbol : li.quoteSymbol;
  const text = [
    `${a.side === "buy" ? "BUY" : "SELL"} on ${a.chain} (Uniswap v4 via Universal Router ${CHAINS[a.chain].universalRouter})`,
    `Token: ${q(li.token)} symbol ${q(li.symbol)} · pool fee ${li.lpFee / 10_000}% · quote asset ${li.quoteSymbol}`,
    `Wallet: ${a.wallet}`,
    `In:  ${fmt(a.amountIn, inD)} ${inSym}`,
    `Expected out: ${fmt(pq.amountOut, outD)} ${outSym}`,
    `Min received (slippage ${a.slippageBps / 100}%): ${fmt(minOut, outD)} ${outSym}`,
    `Price impact: ${(pq.impactBps / 100).toFixed(2)}% (limit ${MAX_PRICE_IMPACT_BPS / 100}%)`,
    ...(a.side === "sell" ? ["Selling needs ERC-20 approval to Permit2 and a Permit2 allowance for the router (exact amount, 1h expiry); these are sent as separate transactions if missing."] : []),
    `quoteId: ${id}`,
  ].join("\n");
  const structured = {
    chain: a.chain, side: a.side, token: li.token, symbol: li.symbol, quote: li.quoteSymbol, wallet: a.wallet,
    amountIn: fmt(a.amountIn, inD), expectedOut: fmt(pq.amountOut, outD), minOut: fmt(minOut, outD),
    slippageBps: a.slippageBps, priceImpactBps: pq.impactBps, quoteId: id,
  };
  return { text, structured };
}

export async function runTrade(a: TradeArgs): Promise<ToolResult> {
  const tool = a.side === "buy" ? "launchpad_buy" : "launchpad_sell";
  const cfg = CHAINS[a.chain];
  const pq = await quoteSwap(a.chain, a.li, a.side, a.amountIn);
  const minOut = minOutFromQuote(pq.amountOut, a.slippageBps);
  if (minOut <= 0n) throw new Error("Computed minimum received is zero; amount too small. Nothing was sent.");
  if (pq.impactBps > MAX_PRICE_IMPACT_BPS) {
    const d = describe(a, pq, minOut, swapQuoteId({ chain: a.chain, token: a.li.token, side: a.side, amountIn: a.amountIn, minOut, slippageBps: a.slippageBps }));
    return { content: [{ type: "text", text: `⛔ REJECTED: price impact ${(pq.impactBps / 100).toFixed(2)}% exceeds the ${MAX_PRICE_IMPACT_BPS / 100}% limit. Reduce the amount.\n\n${d.text}` }], structuredContent: { executed: false, rejected: "price_impact", ...d.structured }, isError: true };
  }
  const prev = typeof a.quoteId === "string" ? previews.get(a.quoteId) : undefined;
  const matches = !!prev && prev.chain === a.chain && prev.token === a.li.token && prev.side === a.side && prev.amountIn === a.amountIn && prev.slippageBps === a.slippageBps && swapQuoteId(prev) === a.quoteId;
  if (a.confirmed !== true || !matches) {
    const id = remember({ chain: a.chain, token: a.li.token, side: a.side, amountIn: a.amountIn, minOut, slippageBps: a.slippageBps });
    const d = describe(a, pq, minOut, id);
    const why = a.confirmed === true ? `\n\n(confirmed=true was ignored: no matching quoteId from a preview of THESE parameters. Show the user this preview, then call again with confirmed=true and quoteId=${id}.)` : "";
    const note = spendEnabled() ? "" : "\n\nNOTE: spending is disabled (FINCH_LAUNCHPAD_ALLOW_SPEND is not 1); a confirmed call will be refused until the operator enables it.";
    return blocked(d.text + why + note, d.structured);
  }
  // ── confirmed, bound to a previewed quote ──
  assertSpendAllowed(tool);
  if (driftExceeded(prev!.minOut, minOut)) {
    throw new Error(`Quote moved: minimum received is now ${fmt(minOut, a.side === "buy" ? a.li.tokenDecimals : a.li.quoteDecimals)}, more than ${MAX_QUOTE_DRIFT_BPS / 100}% worse than the previewed ${fmt(prev!.minOut, a.side === "buy" ? a.li.tokenDecimals : a.li.quoteDecimals)}. Nothing was sent; request a new preview.`);
  }
  if (a.side === "buy") {
    const cap = maxBuyRaw(a.li.quoteKey);
    if (a.amountIn > cap) throw new Error(`Buy amount ${fmt(a.amountIn, a.li.quoteDecimals)} ${a.li.quoteSymbol} exceeds the per-call cap ${fmt(cap, a.li.quoteDecimals)} (${a.li.quoteKey === "eth" ? "FINCH_LAUNCHPAD_MAX_BUY_ETH" : "FINCH_LAUNCHPAD_MAX_BUY_USDG"}). Nothing was sent.`);
  }
  const wallet = await getOrCreateWallet();
  if (wallet.address.toLowerCase() !== a.wallet.toLowerCase()) throw new Error("Wallet changed between preview and execution; request a new preview.");
  const gasPrice = BigInt(await rpc(a.chain, "eth_gasPrice", []));
  const reserve = gasPrice * GAS_RESERVE_UNITS;
  const ethBal = BigInt(await rpc(a.chain, "eth_getBalance", [wallet.address, "latest"]));
  const needEth = reserve + (a.li.quote === ETH_ADDR && a.side === "buy" ? a.amountIn : 0n);
  if (ethBal < needEth) throw new Error(`Insufficient ETH on ${a.chain}: have ${fmt(ethBal, 18)}, need about ${fmt(needEth, 18)} (amount + gas reserve). Nothing was sent.`);
  if (a.side === "buy" && a.li.quote !== ETH_ADDR) {
    const bal = BigInt(ERC20.decodeFunctionResult("balanceOf", await ethCall(a.chain, a.li.quote, ERC20.encodeFunctionData("balanceOf", [wallet.address])))[0]);
    if (bal < a.amountIn) throw new Error(`Insufficient ${a.li.quoteSymbol}: have ${fmt(bal, a.li.quoteDecimals)}, need ${fmt(a.amountIn, a.li.quoteDecimals)}. Nothing was sent.`);
  }
  if (a.side === "sell") {
    const bal = BigInt(ERC20.decodeFunctionResult("balanceOf", await ethCall(a.chain, a.li.token, ERC20.encodeFunctionData("balanceOf", [wallet.address])))[0]);
    if (bal < a.amountIn) throw new Error(`Insufficient token balance: have ${fmt(bal, a.li.tokenDecimals)}, need ${fmt(a.amountIn, a.li.tokenDecimals)}. Nothing was sent.`);
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const build = buildSwap({ chain: a.chain, side: a.side, quote: a.li.quote, token: a.li.token, lpFee: a.li.lpFee, amountIn: a.amountIn, minOut, recipient: wallet.address, deadline });
  const txs: string[] = [];

  // Approvals for any ERC-20 input (sell, or USDG buy): token -> Permit2, Permit2 -> router (exact amounts).
  if (build.permit2Token) {
    const inTok = build.permit2Token;
    const alw = BigInt(ERC20.decodeFunctionResult("allowance", await ethCall(a.chain, inTok, ERC20.encodeFunctionData("allowance", [wallet.address, PERMIT2])))[0]);
    if (alw < a.amountIn) {
      const data = ERC20.encodeFunctionData("approve", [PERMIT2, a.amountIn]);
      const h = await sendTx(a.chain, wallet, inTok, data, 0n, await estimateGas(a.chain, wallet.address, inTok, data, 0n), gasPrice);
      txs.push(h);
      const r = await waitReceipt(a.chain, h);
      if (!r.ok) throw new Error(`Token approval to Permit2 ${r.mined ? "reverted" : "was not confirmed in time"} (${h}). The swap was not sent.`);
    }
    const [pAmt, pExp] = P2_IFACE.decodeFunctionResult("allowance", await ethCall(a.chain, PERMIT2, P2_IFACE.encodeFunctionData("allowance", [wallet.address, inTok, cfg.universalRouter])));
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(pAmt) < a.amountIn || Number(pExp) < now + 600) {
      const data = P2_IFACE.encodeFunctionData("approve", [inTok, cfg.universalRouter, a.amountIn > UINT160_MAX ? UINT160_MAX : a.amountIn, now + 3600]);
      const h = await sendTx(a.chain, wallet, PERMIT2, data, 0n, await estimateGas(a.chain, wallet.address, PERMIT2, data, 0n), gasPrice);
      txs.push(h);
      const r = await waitReceipt(a.chain, h);
      if (!r.ok) throw new Error(`Permit2 approve for the router ${r.mined ? "reverted" : "was not confirmed in time"} (${h}). The swap was not sent.`);
    }
  }
  // Simulate the exact calldata, then send.
  try { await simulateSwap(a.chain, wallet.address, build); } catch (e) {
    throw new Error(`Simulation of the swap failed, so nothing was sent: ${String((e as any)?.message ?? e).slice(0, 200)}${txs.length ? ` (approval txs already sent: ${txs.join(", ")})` : ""}`);
  }
  const gas = await estimateGas(a.chain, wallet.address, build.to, build.data, BigInt(build.value));
  const hash = await sendTx(a.chain, wallet, build.to, build.data, BigInt(build.value), gas, gasPrice);
  const rc = await waitReceipt(a.chain, hash);
  const link = `${cfg.explorer}/tx/${hash}`;
  const d = describe(a, pq, minOut, a.quoteId!);
  if (rc.mined && !rc.ok) throw new Error(`Swap transaction reverted on-chain: ${link}`);
  if (!rc.mined) return ok(`⏳ Swap broadcast but not yet confirmed (still pending).\n${d.text}\nTx: ${hash}\n${link}`, { ...d.structured, executed: true, confirmed: false, txHash: hash, approvalTxs: txs });
  return ok(`✅ ${a.side === "buy" ? "Buy" : "Sell"} confirmed.\n${d.text}\nTx: ${hash}\n${link}`, { ...d.structured, executed: true, confirmed: true, txHash: hash, explorer: link, approvalTxs: txs });
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const CHAIN_PROP = { type: "string", enum: ["base", "robinhood", "solana"], description: "Chain the token was launched on." };
const TOKEN_PROP = { type: "string", description: "Token contract address (0x…), or the exact base58 mint on Solana. Must have been launched by Finch." };
const SLIP_PROP = { type: "number", description: "Max slippage in percent. Default 1, hard ceiling 5." };

export const LAUNCHPAD_SWAP_TOOLS: Tool[] = [
  {
    name: "launchpad_buy",
    description:
      "Buy a Finch-launched token with ETH (Base, Robinhood), USDG (Robinhood, USDG-quoted launches) or SOL (Solana) from the LOCAL wallet via the Uniswap v4 Universal Router (EVM) or a direct Meteora cp-amm swap (Solana). " +
      "Default-deny: needs FINCH_LAUNCHPAD_ALLOW_SPEND=1 and respects FINCH_LAUNCHPAD_MAX_BUY_ETH (0.05) / FINCH_LAUNCHPAD_MAX_BUY_USDG (100) / FINCH_LAUNCHPAD_MAX_BUY_SOL (0.5). " +
      "Without confirmed=true it only returns a preview with a quoteId (nothing is sent); to execute, call again with confirmed=true and that quoteId. " +
      "Refuses price impact above 5%, quote drift above 0.5% between preview and execution, and any token not launched by the Finch factory. Simulates with eth_call before sending.",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP, token: TOKEN_PROP,
        amount: { type: "string", description: "Amount of the token's quote asset to spend, in whole units (e.g. \"0.01\" ETH, \"25\" USDG)." },
        slippagePct: SLIP_PROP,
        confirmed: { type: "boolean", description: "Set true ONLY after the user approved the preview." },
        quoteId: { type: "string", description: "quoteId from the preview (required with confirmed=true)." },
      },
      required: ["chain", "token", "amount"],
    },
  },
  {
    name: "launchpad_sell",
    description:
      "Sell a Finch-launched token back to its quote asset (ETH/USDG/SOL) from the LOCAL wallet via the Uniswap v4 Universal Router (EVM) or a direct Meteora cp-amm swap (Solana, no approvals needed). Give either percent (1-100 of your balance) or amount (token units). " +
      "Needs FINCH_LAUNCHPAD_ALLOW_SPEND=1. Without confirmed=true it only returns a preview with a quoteId; to execute, repeat with confirmed=true and that quoteId. " +
      "May first send two approval transactions (token→Permit2, Permit2→router; exact amount, 1h expiry). Same safety refusals as launchpad_buy (impact >5%, drift >0.5%, non-Finch token).",
    inputSchema: {
      type: "object",
      properties: {
        chain: CHAIN_PROP, token: TOKEN_PROP,
        percent: { type: "number", description: "Percent of your token balance to sell (1-100). Use this OR amount." },
        amount: { type: "string", description: "Token amount to sell in whole token units. Use this OR percent." },
        slippagePct: SLIP_PROP,
        confirmed: { type: "boolean", description: "Set true ONLY after the user approved the preview." },
        quoteId: { type: "string", description: "quoteId from the preview (required with confirmed=true)." },
      },
      required: ["chain", "token"],
    },
  },
];

function parseAmount(v: unknown, decimals: number, name: string): bigint {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${name} must be a positive decimal number (e.g. "0.01").`);
  let raw: bigint;
  try { raw = ethers.parseUnits(s, decimals); } catch { throw new Error(`${name} has more than ${decimals} decimal places.`); }
  if (raw <= 0n) throw new Error(`${name} must be greater than zero.`);
  return raw;
}

async function handleBuy(a: Record<string, any>): Promise<ToolResult> {
  if (String(a.chain ?? "").toLowerCase() === "solana") return handleSolanaBuy(a);
  const chain = parseChain(a.chain);
  const slippageBps = slippagePctToBps(a.slippagePct);
  const li = await resolveLaunch(chain, a.token);
  const amountIn = parseAmount(a.amount, li.quoteDecimals, "amount");
  const w = await getOrCreateWallet();
  return runTrade({ chain, side: "buy", li, amountIn, slippageBps, wallet: w.address, confirmed: a.confirmed === true, quoteId: typeof a.quoteId === "string" ? a.quoteId : undefined });
}

async function handleSell(a: Record<string, any>): Promise<ToolResult> {
  if (String(a.chain ?? "").toLowerCase() === "solana") return handleSolanaSell(a);
  const chain = parseChain(a.chain);
  const slippageBps = slippagePctToBps(a.slippagePct);
  const li = await resolveLaunch(chain, a.token);
  const w = await getOrCreateWallet();
  const hasPct = a.percent !== undefined && a.percent !== null;
  const hasAmt = a.amount !== undefined && a.amount !== null && a.amount !== "";
  if (hasPct === hasAmt) throw new Error("Provide exactly one of percent or amount.");
  const bal = BigInt(ERC20.decodeFunctionResult("balanceOf", await ethCall(chain, li.token, ERC20.encodeFunctionData("balanceOf", [w.address])))[0]);
  if (bal === 0n) throw new Error(`The local wallet ${w.address} holds none of this token on ${chain}.`);
  let amountIn: bigint;
  if (hasPct) {
    const p = Number(a.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error("percent must be a number in (0, 100].");
    amountIn = p === 100 ? bal : (bal * BigInt(Math.round(p * 100))) / 10_000n;
    if (amountIn <= 0n) throw new Error("percent of balance rounds to zero.");
  } else {
    amountIn = parseAmount(a.amount, li.tokenDecimals, "amount");
    if (amountIn > bal) throw new Error(`amount exceeds your balance of ${fmt(bal, li.tokenDecimals)}.`);
  }
  return runTrade({ chain, side: "sell", li, amountIn, slippageBps, wallet: w.address, confirmed: a.confirmed === true, quoteId: typeof a.quoteId === "string" ? a.quoteId : undefined });
}

export async function handleLaunchpadSwapTool(name: string, args: Record<string, any> | undefined): Promise<ToolResult> {
  const a = args ?? {};
  try {
    switch (name) {
      case "launchpad_buy": return await handleBuy(a);
      case "launchpad_sell": return await handleSell(a);
      default: return fail(`Unknown launchpad swap tool: ${name}`);
    }
  } catch (e) {
    return fail(e);
  }
}

export type { LaunchChain, ChainCfg };
