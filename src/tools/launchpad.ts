// Finch launchpad MCP tools (Base + Robinhood Chain): wallet, pairs, launches, token, launch_token.
// Custody is LOCAL (~/.finch/wallet.json). Spending is DEFAULT-DENY (FINCH_LAUNCHPAD_ALLOW_SPEND=1), exactly like sol_*.
// launchpad_buy / launchpad_sell live in launchpad-swap.ts.

import { ethers } from "ethers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { callConvex, CONVEX_SITE } from "../convex.js";
import { getOrCreateWallet, signRequest } from "../wallet.js";
import {
  FACTORY, LOCKER, CHAIN_ID, QUOTES, MAX_LP_FEE, quoteFor, describeSplit, expectedBudgetRouting,
  verifyPrepareResponse, verifyPredictedToken, LaunchVerificationError,
  type LaunchChain, type LaunchQuote, type VerifiedLaunch, type LaunchRequest,
} from "../launchpad-verify.js";
import { startTickForFdv } from "../launchpad-math.js";

// ── Output helpers (same shape as solana.ts) ─────────────────────────────────
function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}
function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${String((e as any)?.message ?? e)}` }], isError: true };
}
function blocked(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: `⛔ NOT EXECUTED — confirmation required.\n\n${text}\n\nRe-run with confirmed=true after the user has approved these exact details.` }], ...(structured ? { structuredContent: { executed: false, ...structured } } : {}) };
}

// ── Config ───────────────────────────────────────────────────────────────────
export const LAUNCHPAD_CHAINS: LaunchChain[] = ["base", "robinhood"];
export function launchpadRpcUrl(chain: LaunchChain): string {
  return chain === "base"
    ? (process.env.FINCH_LAUNCHPAD_BASE_RPC ?? "https://mainnet.base.org")
    : (process.env.FINCH_LAUNCHPAD_ROBINHOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com");
}
const EXPLORER: Record<LaunchChain, string> = { base: "https://basescan.org", robinhood: "https://robinhoodchain.blockscout.com" };
const CHAIN_LABEL: Record<LaunchChain, string> = { base: "Base", robinhood: "Robinhood Chain" };
const DEFAULT_MCAP: Record<LaunchQuote, number> = { eth: 10, usdg: 10_000 };

// ── Spend gate & caps (default-deny, fail closed on junk) ────────────────────
export function launchpadSpendEnabled(): boolean { return process.env.FINCH_LAUNCHPAD_ALLOW_SPEND === "1"; }
export function assertLaunchpadSpendAllowed(tool: string): void {
  if (!launchpadSpendEnabled()) {
    throw new Error(
      `${tool} is disabled: spending from the local EVM wallet is default-deny. ` +
      "To enable it, the human operator must set the environment variable FINCH_LAUNCHPAD_ALLOW_SPEND=1 in the MCP server config and restart. " +
      "Per-call caps: FINCH_LAUNCHPAD_MAX_BUY_ETH (default 0.05), FINCH_LAUNCHPAD_MAX_BUY_USDG (default 100), FINCH_LAUNCHPAD_MAX_GAS_ETH (default 0.01, launch gas).",
    );
  }
}
/** Positive decimal number from env, as a decimal string -> bigint units. Junk => throws (fail closed). */
export function launchpadCapFromEnv(name: string, dflt: string, decimals: number): bigint {
  const raw = process.env[name];
  const s = raw === undefined || raw === "" ? dflt : raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${name}=${JSON.stringify(raw)} is not a valid positive decimal number; refusing (fail closed).`);
  const [i, f = ""] = s.split(".");
  if (f.length > decimals && /[1-9]/.test(f.slice(decimals))) throw new Error(`${name}=${JSON.stringify(raw)} has more than ${decimals} decimals; refusing.`);
  const v = ethers.parseUnits(`${i}.${f.slice(0, decimals) || "0"}`, decimals);
  if (v <= 0n) throw new Error(`${name} must be greater than zero; refusing.`);
  return v;
}
export const maxBuyEthWei = () => launchpadCapFromEnv("FINCH_LAUNCHPAD_MAX_BUY_ETH", "0.05", 18);
export const maxBuyUsdgUnits = () => launchpadCapFromEnv("FINCH_LAUNCHPAD_MAX_BUY_USDG", "100", 6);
export const maxGasWei = () => launchpadCapFromEnv("FINCH_LAUNCHPAD_MAX_GAS_ETH", "0.01", 18);

function spendDisabledNote(): string {
  return launchpadSpendEnabled() ? "" : "\n\nNOTE: spending is disabled (FINCH_LAUNCHPAD_ALLOW_SPEND is not 1); a confirmed call will be refused until the operator enables it.";
}

// ── Chain operations (replaceable in tests) ──────────────────────────────────
const FACTORY_ABI = [
  "function launch((string name, string symbol, string metadataURI, address quote, uint256 supply, int24 startTick, uint24 lpFee, bytes32 salt, (address payout, uint16 bps)[] recipients) p) returns (address token, uint256 tokenId)",
  "event Launched(address indexed token, uint256 indexed tokenId, address indexed launcher, address quote, bytes32 poolId, int24 startTick, uint24 lpFee, uint256 supply, string metadataURI)",
  "function predictToken(address launcher, bytes32 salt, string name, string symbol, uint256 supply, string metadataURI) view returns (address)",
];
const factoryIface = new ethers.Interface(FACTORY_ABI);

export interface LaunchParams {
  name: string; symbol: string; metadataURI: string; quote: string; supply: bigint;
  startTick: number; lpFee: number; salt: string; recipients: Array<{ payout: string; bps: number }>;
}
export function toLaunchParams(v: VerifiedLaunch): LaunchParams {
  return {
    name: v.name, symbol: v.symbol, metadataURI: v.metadataURI, quote: v.quote.address, supply: 0n,
    startTick: v.startTick, lpFee: v.lpFee, salt: v.salt, recipients: v.recipients,
  };
}

export interface ChainOps {
  getBalance(chain: LaunchChain, address: string): Promise<bigint>;
  predictToken(chain: LaunchChain, launcher: string, p: LaunchParams): Promise<string>;
  /** eth_call simulation of factory.launch from `from`; returns a gas estimate (throws if it would revert). */
  simulateLaunch(chain: LaunchChain, from: string, p: LaunchParams): Promise<bigint>;
  gasPrice(chain: LaunchChain): Promise<bigint>;
  sendLaunch(chain: LaunchChain, wallet: ethers.Wallet | ethers.HDNodeWallet, p: LaunchParams, gasLimit: bigint): Promise<{ hash: string; status: number | null; logs: Array<{ address: string; topics: string[]; data: string }> }>;
}

function provider(chain: LaunchChain): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(launchpadRpcUrl(chain), CHAIN_ID[chain], { staticNetwork: true });
}

export const realChainOps: ChainOps = {
  async getBalance(chain, address) { return provider(chain).getBalance(address); },
  async predictToken(chain, launcher, p) {
    const f = new ethers.Contract(FACTORY, FACTORY_ABI, provider(chain));
    return (await f.predictToken(launcher, p.salt, p.name, p.symbol, p.supply, p.metadataURI)) as string;
  },
  async simulateLaunch(chain, from, p) {
    const f = new ethers.Contract(FACTORY, FACTORY_ABI, provider(chain));
    await f.launch.staticCall(p, { from });
    return (await f.launch.estimateGas(p, { from })) as bigint;
  },
  async gasPrice(chain) {
    const fee = await provider(chain).getFeeData();
    return fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  },
  async sendLaunch(chain, wallet, p, gasLimit) {
    const f = new ethers.Contract(FACTORY, FACTORY_ABI, wallet.connect(provider(chain)));
    const tx = await f.launch(p, { gasLimit });
    const receipt = await tx.wait(1, 120_000);
    return { hash: tx.hash, status: receipt?.status ?? null, logs: (receipt?.logs ?? []).map((l: any) => ({ address: l.address, topics: [...l.topics], data: l.data })) };
  },
};
export const launchpadDeps: { chain: ChainOps } = { chain: realChainOps };

// ── Backend HTTP ─────────────────────────────────────────────────────────────
/**
 * Wallet-signed POST, never retried (a retry could re-reserve a budget wallet / double register).
 * Always uses wallet-signature headers (X-Wallet-*): the backend derives the launcher from the authenticated wallet,
 * so a Bearer API key / session token (which callConvex would prefer) cannot be used for these routes.
 */
export async function walletSignedPost(route: string, body: unknown, toolName: string): Promise<any> {
  const { address, signature, timestamp } = await signRequest(toolName);
  let res: Response;
  try {
    res = await fetch(`${CONVEX_SITE}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Wallet-Address": address, "X-Wallet-Signature": signature, "X-Wallet-Timestamp": timestamp },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e: any) {
    throw new Error(`${e?.message ?? e} - request may or may not have completed (no response received).`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = String(j?.error ?? j?.message ?? msg).slice(0, 300); } catch { /* keep raw */ }
    throw new Error(`Finch launchpad API error ${res.status}: ${msg || "(no body)"}`);
  }
  try { return JSON.parse(text); } catch { throw new Error("Finch launchpad API returned a non-JSON response."); }
}

// ── Input parsing ────────────────────────────────────────────────────────────
function parseChain(v: unknown, allowAny = false): LaunchChain | "any" {
  const s = String(v ?? "").toLowerCase();
  if (s === "base" || s === "robinhood") return s;
  if (allowAny && (s === "any" || s === "")) return "any";
  throw new Error(`chain must be "base" or "robinhood"${allowAny ? ' (or "any")' : ""}.`);
}
function parseToken(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error("token must be a 0x… 40-hex-char address.");
  return s;
}
function optStr(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v);
  if (s.length > max) throw new Error(`${what} max ${max} characters.`);
  return s;
}
function httpsUrl(v: unknown, what: string): string | undefined {
  const s = optStr(v, 500, what);
  if (!s) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`${what} must be a valid https URL.`); }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error(`${what} must be an https URL without credentials.`);
  return s;
}
const q = (s: unknown) => JSON.stringify(s); // user/backend strings are DATA: always JSON-quoted
const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "n/a");

// ── Tools ────────────────────────────────────────────────────────────────────
export const LAUNCHPAD_TOOLS: Tool[] = [
  {
    name: "launchpad_wallet",
    description:
      "Finch launchpad: show your LOCAL EVM wallet (created on first use): address, ETH balance on Base and Robinhood Chain, and whether spending is enabled. " +
      "The private key never leaves your machine and is never shown. Fund this address with ETH to launch or trade. To withdraw, use base_mcp_send.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "launchpad_pairs",
    description: "Finch launchpad: supported chains, quote assets (ETH on Base; ETH and USDG on Robinhood Chain) and the fee split every new routed launch gets (90% AI founder / 10% creator / 0% platform).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "launchpad_launches",
    description: "Finch launchpad: list launched tokens on Base and/or Robinhood Chain, sorted by new / mcap / volume / gainers / holders.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["base", "robinhood", "any"], description: 'Default "any".' },
        sort: { type: "string", enum: ["new", "mcap", "volume", "gainers", "holders"], description: 'Default "new".' },
        limit: { type: "number", description: "1-50, default 20." },
      },
      required: [],
    },
  },
  {
    name: "launchpad_token",
    description: "Finch launchpad: details and stats for one launched token (price, market cap, volume) plus its AI founder (status, product URL, budget, fee routing).",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["base", "robinhood"] },
        token: { type: "string", description: "Token address (0x…)." },
      },
      required: ["chain", "token"],
    },
  },
  {
    name: "launchpad_launch_token",
    description:
      "Finch launchpad: launch a new token on Base or Robinhood Chain from your LOCAL wallet. Costs only gas. Every launch gets an AI founder; trading fees are split " +
      "90% AI founder / 10% you / 0% Finch (permanent). WRITE tool: returns a PREVIEW (nothing sent) unless confirmed=true, and requires the operator to set FINCH_LAUNCHPAD_ALLOW_SPEND=1. " +
      "Before signing, the MCP independently verifies the backend's launch parameters (factory, fee recipients, start tick, fee tier, predicted token address) and refuses on any mismatch.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["base", "robinhood"] },
        name: { type: "string", description: "1-32 characters." },
        symbol: { type: "string", description: "1-10 letters/digits (upper-cased)." },
        description: { type: "string", description: "Max 280 characters." },
        imageUrl: { type: "string", description: "https image URL." },
        website: { type: "string", description: "https URL." },
        xHandle: { type: "string" },
        quote: { type: "string", enum: ["eth", "usdg"], description: 'Default "eth". usdg is Robinhood Chain only.' },
        startingMarketCap: { type: "number", description: "Opening market cap in whole QUOTE units (default 10 for eth, 10000 for usdg)." },
        feePercent: { type: "number", enum: [0, 1, 3], description: "Trading fee percent, default 1." },
        feeTo: { type: "string", enum: ["creator", "burn"], description: 'Default "creator" (90% AI founder / 10% you). "burn" burns all fees.' },
        agentBrief: { type: "string", description: "What the AI founder should build (max 500 chars)." },
        confirmed: { type: "boolean", description: "Must be true to actually launch (preview otherwise)." },
        retryRegisterTxHash: { type: "string", description: "If a previous launch succeeded on-chain but registration failed, pass its tx hash (with confirmed=true) to retry registration only. Idempotent; sends no transaction." },
      },
      required: ["chain", "name", "symbol"],
    },
  },
];

// ── launchpad_wallet ─────────────────────────────────────────────────────────
async function handleWallet(): Promise<ToolResult> {
  const walletFile = path.join(os.homedir(), ".finch", "wallet.json");
  const existed = fs.existsSync(walletFile);
  const w = await getOrCreateWallet();
  const balances: Record<string, string | null> = {};
  const lines: string[] = [];
  for (const c of LAUNCHPAD_CHAINS) {
    try {
      const b = await launchpadDeps.chain.getBalance(c, w.address);
      balances[c] = ethers.formatEther(b);
      lines.push(`${CHAIN_LABEL[c]}: ${balances[c]} ETH`);
    } catch (e: any) {
      balances[c] = null; // never report an RPC failure as zero
      lines.push(`${CHAIN_LABEL[c]}: balance unavailable (${String(e?.message ?? e).slice(0, 120)})`);
    }
  }
  const spend = launchpadSpendEnabled();
  let caps: Record<string, string> = {};
  let capsErr: string | null = null;
  try {
    caps = {
      maxBuyEth: ethers.formatEther(maxBuyEthWei()),
      maxBuyUsdg: ethers.formatUnits(maxBuyUsdgUnits(), 6),
      maxGasEth: ethers.formatEther(maxGasWei()),
    };
  } catch (e: any) { capsErr = String(e?.message ?? e); }
  const text =
    `${existed ? "Local EVM wallet" : "Created a new local EVM wallet (key stored encrypted in ~/.finch/wallet.json, never shown)"}\n` +
    `Address: ${w.address}\n${lines.join("\n")}\n` +
    `Spending: ${spend ? "ENABLED (FINCH_LAUNCHPAD_ALLOW_SPEND=1)" : "DISABLED (default-deny; operator must set FINCH_LAUNCHPAD_ALLOW_SPEND=1)"}\n` +
    (capsErr ? `Caps: INVALID CONFIG - ${capsErr}\n` : `Caps per call: ${caps.maxBuyEth} ETH buy, ${caps.maxBuyUsdg} USDG buy, ${caps.maxGasEth} ETH launch gas\n`) +
    `Fund this address with ETH to launch/trade. To withdraw use base_mcp_send.`;
  return ok(text, { address: w.address, created: !existed, balances, spendEnabled: spend, caps: capsErr ? null : caps, capsError: capsErr });
}

// ── read routes ──────────────────────────────────────────────────────────────
async function handlePairs(): Promise<ToolResult> {
  const r = await callConvex("/launchpad/pairs", "GET", undefined, "launchpad_pairs");
  const lines: string[] = [];
  for (const [chain, v] of Object.entries<any>(r?.chains ?? {})) {
    lines.push(`${q(chain)}: ` + (v?.quotes ?? []).map((x: any) => `${x.symbol} (${x.key}, ${x.decimals} dec, ${x.address})`).join(", "));
  }
  const s = r?.split ?? {};
  lines.push(`Fee split of every new routed launch: ${(s.agentBps ?? 0) / 100}% AI founder / ${(s.creatorBps ?? 0) / 100}% creator / ${(s.platformBps ?? 0) / 100}% platform.`);
  return ok(lines.join("\n"), r);
}

async function handleLaunches(a: Record<string, any>): Promise<ToolResult> {
  const chain = parseChain(a.chain ?? "any", true);
  const sort = String(a.sort ?? "new");
  if (!["new", "mcap", "volume", "gainers", "holders"].includes(sort)) throw new Error("sort must be new, mcap, volume, gainers or holders.");
  const limit = a.limit === undefined ? 20 : Number(a.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer between 1 and 50.");
  const r = await callConvex(`/launchpad/list?chain=${chain}&sort=${sort}&limit=${limit}`, "GET", undefined, "launchpad_launches");
  const list: any[] = Array.isArray(r?.launches) ? r.launches : [];
  if (list.length === 0) return ok("No launches found.", { launches: [] });
  const lines = list.map((l, i) =>
    `${i + 1}. ${q(l.name)} (${q(l.symbol)}) on ${l.chain} · ${l.token} · mcap $${fmt(l.marketCapUsd)} · 24h vol $${fmt(l.volume24hUsd)}${l.hasAgent ? ` · AI founder${l.agentSlug ? " " + q(l.agentSlug) : ""}` : ""}`);
  return ok(`Launches (${chain}, sort=${sort}):\n${lines.join("\n")}`, { launches: list });
}

async function handleToken(a: Record<string, any>): Promise<ToolResult> {
  const chain = parseChain(a.chain) as LaunchChain;
  const token = parseToken(a.token);
  const r = await callConvex(`/launchpad/token?chain=${chain}&token=${token}`, "GET", undefined, "launchpad_token");
  const ag = r?.agent ?? r?.agentDetail ?? null;
  const t = r?.token && typeof r.token === "object" ? r.token : r;
  const lines = [
    `${q(t?.name ?? "?")} (${q(t?.symbol ?? "?")}) on ${chain} · ${token}`,
    `Price $${fmt(r?.stats?.priceUsd ?? t?.priceUsd)} · mcap $${fmt(r?.stats?.marketCapUsd ?? t?.marketCapUsd)} · 24h vol $${fmt(r?.stats?.volume24hUsd ?? t?.volume24hUsd)}`,
  ];
  if (ag) {
    lines.push(`AI founder: status ${q(ag.status)}${ag.feeRouted !== undefined ? ` · fees routed: ${ag.feeRouted ? "yes" : "no"}` : ""}${ag.budgetUsd !== undefined ? ` · budget $${fmt(ag.budgetUsd)}` : ""}`);
    if (ag.productUrl) lines.push(`Product: ${ag.productUrl}`);
  } else lines.push("AI founder: none");
  return ok(lines.join("\n"), (r && typeof r === "object" ? r : { result: r }) as Record<string, unknown>);
}

// ── launchpad_launch_token ───────────────────────────────────────────────────
function parseLaunchArgs(a: Record<string, any>): LaunchRequest & { description?: string; imageUrl?: string; website?: string; xHandle?: string; agentBrief?: string } {
  const chain = parseChain(a.chain) as LaunchChain;
  const quote = String(a.quote ?? "eth").toLowerCase() as LaunchQuote;
  if (quote !== "eth" && quote !== "usdg") throw new Error('quote must be "eth" or "usdg".');
  quoteFor(chain, quote); // throws if unavailable on this chain
  const name = String(a.name ?? "").trim();
  const symbol = String(a.symbol ?? "").trim().toUpperCase();
  if (!name || name.length > 32) throw new Error("Name must be 1-32 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol must be 1-10 letters or digits.");
  const description = optStr(a.description, 280, "description");
  const imageUrl = httpsUrl(a.imageUrl, "imageUrl");
  const website = httpsUrl(a.website, "website");
  const xHandle = optStr(a.xHandle, 50, "xHandle");
  const agentBrief = optStr(a.agentBrief, 500, "agentBrief");
  const feePct = a.feePercent === undefined ? 1 : Number(a.feePercent);
  if (![0, 1, 3].includes(feePct)) throw new Error("feePercent must be 0, 1 or 3.");
  const feeTo = String(a.feeTo ?? "creator");
  if (feeTo !== "creator" && feeTo !== "burn") throw new Error('feeTo must be "creator" or "burn".');
  const startingMarketCap = a.startingMarketCap === undefined ? DEFAULT_MCAP[quote] : Number(a.startingMarketCap);
  if (!(startingMarketCap > 0) || !Number.isFinite(startingMarketCap)) throw new Error("startingMarketCap must be a positive number (whole quote units).");
  startTickForFdv(startingMarketCap, quoteFor(chain, quote).decimals); // range check up front
  return { chain, quote, name, symbol, startingMarketCap, feePct: feePct as 0 | 1 | 3, feeTo, description, imageUrl, website, xHandle, agentBrief };
}

async function registerLaunch(chain: LaunchChain, txHash: string): Promise<{ ok: true; r: any } | { ok: false; error: string }> {
  try {
    const r = await walletSignedPost("/launchpad/register", { chain, txHash }, "launchpad_register");
    return { ok: true, r };
  } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}

function finalReport(chain: LaunchChain, token: string, txHash: string, reg: { ok: true; r: any } | { ok: false; error: string }, v: VerifiedLaunch | null): ToolResult {
  const explorerTx = `${EXPLORER[chain]}/tx/${txHash}`;
  const explorerToken = `${EXPLORER[chain]}/token/${token}`;
  const structured: Record<string, unknown> = { executed: true, chain, token, txHash, explorerTx, explorerToken };
  let text = `✅ Token launched on ${CHAIN_LABEL[chain]} (on-chain).\nToken: ${token}\nTx: ${explorerTx}\nToken page: ${explorerToken}\n`;
  if (reg.ok) {
    const r = reg.r ?? {};
    const slug = r.agent?.slug ?? null;
    const productUrl = r.productUrl ?? r.agent?.productUrl ?? (slug && r.agent?.siteVersion > 0 ? `https://${slug}.finchagentic.com` : null);
    Object.assign(structured, { registered: true, feeRouted: r.feeRouted === true, agentCreated: r.agent?.created === true, agentSlug: slug, productUrl: productUrl ?? null });
    text += `Registered with Finch: yes · fees routed to AI founder: ${r.feeRouted === true ? "yes" : "no"}\n`;
    text += r.agent?.created ? `AI founder created${slug ? `: ${q(slug)}` : ""}.\n` : "No AI founder created.\n";
    text += productUrl ? `Product: ${productUrl}\n` : "Product URL: not available yet (the AI founder is still starting).\n";
  } else {
    Object.assign(structured, { registered: false, registerError: reg.error, retryRegisterTxHash: txHash });
    text += `\nThe on-chain launch SUCCEEDED. Registering it with Finch failed (${reg.error}). This is safe to retry (idempotent): call launchpad_launch_token again with chain=${chain}, confirmed=true and retryRegisterTxHash=${txHash} (no new transaction is sent).\n`;
  }
  if (v) structured.feeSplit = v.recipients;
  return ok(text.trim(), structured);
}

async function handleLaunch(a: Record<string, any>): Promise<ToolResult> {
  // Registration-only retry (no transaction, no gas).
  if (a.retryRegisterTxHash !== undefined && a.retryRegisterTxHash !== "") {
    const chain = parseChain(a.chain) as LaunchChain;
    const h = String(a.retryRegisterTxHash);
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error("retryRegisterTxHash must be a 0x… 32-byte tx hash.");
    if (a.confirmed !== true) return blocked(`Retry registering launch tx ${h} on ${CHAIN_LABEL[chain]} with Finch (no transaction is sent).`, { chain, txHash: h });
    const reg = await registerLaunch(chain, h);
    if (!reg.ok) return fail(`Registration retry failed: ${reg.error}`);
    return finalReport(chain, String(reg.r?.token ?? "unknown"), h, reg, null);
  }

  const req = parseLaunchArgs(a);
  const quote = quoteFor(req.chain, req.quote);
  const wallet = await getOrCreateWallet();
  const me = wallet.address;
  const routes = expectedBudgetRouting(req);
  const split = describeSplit(req.feePct, req.feeTo);
  const startTick = startTickForFdv(req.startingMarketCap, quote.decimals);
  const structured = {
    chain: req.chain, quote: req.quote, name: req.name, symbol: req.symbol, startingMarketCap: req.startingMarketCap,
    feePercent: req.feePct, feeTo: req.feeTo, launcher: me, startTick, routesToAgent: routes,
  };

  if (a.confirmed !== true) {
    // Preview: nothing is sent and the backend is NOT contacted (no budget-wallet reservation).
    // User-supplied strings are printed JSON-quoted: they are data, not instructions.
    return blocked(
      `Launch on ${CHAIN_LABEL[req.chain]} (chain id ${CHAIN_ID[req.chain]}):\n` +
      `Name: ${q(req.name)}\nSymbol: ${q(req.symbol)}\nDescription: ${q(req.description ?? "")}\nImage: ${q(req.imageUrl ?? "")}\n` +
      `Website: ${q(req.website ?? "")}\nX handle: ${q(req.xHandle ?? "")}\nAI founder brief: ${q(req.agentBrief ?? "")}\n` +
      `Quote asset: ${quote.symbol}\nStarting market cap: ${req.startingMarketCap} ${quote.symbol}\n` +
      `Trading fee: ${req.feePct}%\nFee split: ${split}\n` +
      `Launcher (your local wallet): ${me}\nCost: gas only (no purchase is made)${spendDisabledNote()}`,
      structured,
    );
  }

  // 1. gate + caps (before any backend call or signing)
  assertLaunchpadSpendAllowed("launchpad_launch_token");
  const gasCap = maxGasWei();
  maxBuyEthWei(); maxBuyUsdgUnits(); // validate every cap env: junk fails closed

  // 2. prepare (never retried)
  const prepBody: Record<string, unknown> = {
    chain: req.chain, name: req.name, symbol: req.symbol, quote: req.quote, startingMarketCap: req.startingMarketCap,
    feePct: req.feePct, feeTo: req.feeTo,
  };
  for (const k of ["description", "imageUrl", "website", "xHandle", "agentBrief"] as const) if (req[k] !== undefined) prepBody[k] = req[k];
  const resp = await walletSignedPost("/launchpad/prepare", prepBody, "launchpad_prepare");

  // 3. independent verification: refuse (and sign nothing) on any mismatch
  const v = verifyPrepareResponse(resp, req, me);
  const params = toLaunchParams(v);
  const onChainPredicted = await launchpadDeps.chain.predictToken(req.chain, me, params);
  verifyPredictedToken(onChainPredicted, v.predictedToken);

  // 4. simulate, gas pre-check
  let gasEst: bigint;
  try { gasEst = await launchpadDeps.chain.simulateLaunch(req.chain, me, params); }
  catch (e: any) { throw new Error(`Launch simulation failed (nothing sent): ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 300)}`); }
  const gasLimit = (gasEst * 125n) / 100n;
  const price = await launchpadDeps.chain.gasPrice(req.chain);
  const gasCost = gasLimit * price;
  if (gasCost > gasCap) throw new Error(`Estimated launch gas ${ethers.formatEther(gasCost)} ETH exceeds FINCH_LAUNCHPAD_MAX_GAS_ETH (${ethers.formatEther(gasCap)}). Nothing sent.`);
  const bal = await launchpadDeps.chain.getBalance(req.chain, me);
  if (bal < gasCost) throw new Error(`Not enough ETH for gas on ${CHAIN_LABEL[req.chain]}: need about ${ethers.formatEther(gasCost)} ETH, wallet ${me} has ${ethers.formatEther(bal)}. Nothing sent.`);

  // 5. send + 1 confirmation
  const sent = await launchpadDeps.chain.sendLaunch(req.chain, wallet, params, gasLimit);
  if (sent.status !== 1) throw new Error(`Launch transaction ${sent.hash} did not succeed on-chain (status ${sent.status}).`);
  let token = v.predictedToken;
  for (const l of sent.logs) {
    if (l.address.toLowerCase() !== FACTORY.toLowerCase()) continue;
    try {
      const ev = factoryIface.parseLog({ topics: l.topics, data: l.data });
      if (ev?.name === "Launched") { token = String(ev.args.token); break; }
    } catch { /* not ours */ }
  }

  // 6. register; a failure here never turns the successful launch into an error
  const reg = await registerLaunch(req.chain, sent.hash);
  return finalReport(req.chain, token, sent.hash, reg, v);
}

// ── dispatcher ───────────────────────────────────────────────────────────────
export async function handleLaunchpadTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  try {
    const a = args ?? {};
    switch (name) {
      case "launchpad_wallet": return await handleWallet();
      case "launchpad_pairs": return await handlePairs();
      case "launchpad_launches": return await handleLaunches(a);
      case "launchpad_token": return await handleToken(a);
      case "launchpad_launch_token": return await handleLaunch(a);
      default: return fail(`Unknown launchpad tool: ${name}`);
    }
  } catch (e) {
    return fail(e);
  }
}

export { LaunchVerificationError, QUOTES, LOCKER, MAX_LP_FEE };
