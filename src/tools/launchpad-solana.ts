// Solana support for the launchpad_* tools (dispatched from launchpad.ts / launchpad-swap.ts when chain="solana").
//
//  • Reads (pairs / launches / token) are formatted here for SOL + exact base58 mints.
//  • launch: executes in the user's FINCH account (custodial wallet) through POST /launchpad/solana/launch, because the
//    agent's 90% fee share is claimed by Finch's cron from that custodial wallet. A launch signed from a local wallet would
//    never fund its AI founder. Needs a REAL session token (`finch login`); an API key is not enough.
//  • buy / sell: LOCAL Solana wallet, DIRECT cp-amm swap built locally (launchpad-solana.ts, byte-parity with the backend).

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ToolResult } from "../types.js";
import { callConvex, CONVEX_SITE } from "../convex.js";
import { getSavedToken, isApiKey } from "../config.js";
import {
  assertSafeTx, simulateAndAssert, sendAndConfirm, loadSolanaKeypair, quoteIdOf, solanaRpcUrl, isValidPubkey,
  parseHumanToBaseUnits, formatBaseUnits, MAX_QUOTE_DRIFT_BPS, TOKEN_PROGRAM as TOKEN_PROGRAM_STR,
} from "./solana.js";
import { slippagePctToBps } from "../launchpad-v4.js";
import {
  METEORA_CP_AMM_PROGRAM, WSOL_MINT, TOKEN_PROGRAM, SOLANA_SWAP_PROGRAMS, SWAP_RESERVE, MAX_PRICE_IMPACT_PCT,
  POOL_ACCOUNT_DISCRIMINATOR, MIN_POOL_ACCOUNT_BYTES, decodeSwapPool, quoteExactIn, ataAddress, buildSwapInstructions,
  compileSwapTx, assertTxMatchesPlan, type SwapPoolState, type MeteoraQuote,
} from "../launchpad-solana.js";

// ── output helpers (same shape as the EVM launchpad tools) ───────────────────
function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}
function blockedMsg(text: string, structured: Record<string, unknown>, tail: string): ToolResult {
  return { content: [{ type: "text", text: `⛔ NOT EXECUTED — confirmation required.\n\n${text}\n\n${tail}` }], structuredContent: { executed: false, ...structured } };
}
const q = (s: unknown) => JSON.stringify(String(s));
const fmtNum = (n: unknown, d = 6) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US", { maximumSignificantDigits: d }) : "n/a");

export const SOLANA_QUOTE_SOL = { key: "sol", address: WSOL_MINT.toBase58(), decimals: 9, symbol: "SOL" } as const;
export const SOLANA_RENT_SOL = 0.025;             // creator-paid rent + fees of one launch (backend: ~0.025 SOL)
export const SOLANA_RENT_LAMPORTS = 25_000_000n;
export const DEFAULT_SOLANA_MCAP_SOL = 30;
export const SOLANA_TOKEN_DECIMALS = 9;

// ── spend gate & caps (default-deny, fail closed on junk) ────────────────────
export const launchpadSolanaSpendEnabled = (): boolean => process.env.FINCH_LAUNCHPAD_ALLOW_SPEND === "1";
export function assertLaunchpadSolanaSpend(tool: string): void {
  if (!launchpadSolanaSpendEnabled()) {
    throw new Error(
      `${tool} is disabled: spending (Solana launch from your Finch account / buy and sell from the local Solana wallet) is default-deny. ` +
      "To enable it, the human operator must set FINCH_LAUNCHPAD_ALLOW_SPEND=1 in the MCP server config and restart. " +
      "Per-call caps: FINCH_LAUNCHPAD_MAX_BUY_SOL (default 0.5) and FINCH_LAUNCHPAD_MAX_SOL_LAUNCH (default 0.5, boost + rent).",
    );
  }
}
/** Lamport cap from env: unset/empty -> default; junk, zero or >9 decimals -> throws (fail closed). */
export function solanaCapLamports(name: string, dflt: string): bigint {
  const raw = process.env[name];
  const s = raw === undefined || raw.trim() === "" ? dflt : raw.trim();
  try { return parseHumanToBaseUnits(s, 9); }
  catch { throw new Error(`${name}=${JSON.stringify(raw)} is not a valid positive SOL amount; refusing (fail closed).`); }
}
export const maxBuyLamports = () => solanaCapLamports("FINCH_LAUNCHPAD_MAX_BUY_SOL", "0.5");
export const maxLaunchLamports = () => solanaCapLamports("FINCH_LAUNCHPAD_MAX_SOL_LAUNCH", "0.5");
const spendNote = () => launchpadSolanaSpendEnabled() ? "" : "\n\nNOTE: spending is disabled (FINCH_LAUNCHPAD_ALLOW_SPEND is not 1); a confirmed call will be refused until the operator enables it.";

// ── Solana JSON-RPC (polite retry on rate limit) ─────────────────────────────
let rid = 1;
export async function solRpc(method: string, params: unknown[]): Promise<any> {
  let last: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(solanaRpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rid++, method, params }), signal: AbortSignal.timeout(20_000) });
    } catch (e: any) { last = new Error(`Solana RPC unreachable (${String(e?.message ?? e).slice(0, 100)})`); continue; }
    if (res.status === 429 || res.status >= 500) { last = new Error(`Solana RPC HTTP ${res.status} (rate limited or unavailable)`); continue; }
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.error) throw new Error(`Solana RPC ${method} failed: ${String(j.error.message ?? "error").slice(0, 200)}`);
    return j.result;
  }
  throw last ?? new Error("Solana RPC failed");
}
async function getAccount(address: string): Promise<{ data: Buffer; owner: string; lamports: bigint } | null> {
  const r = await solRpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  const v = r?.value;
  if (!v) return null;
  const b64 = Array.isArray(v.data) ? v.data[0] : undefined;
  if (typeof b64 !== "string") throw new Error("Solana RPC returned an unreadable account.");
  return { data: Buffer.from(b64, "base64"), owner: String(v.owner), lamports: BigInt(v.lamports ?? 0) };
}

// ── input parsing ────────────────────────────────────────────────────────────
export function parseSolanaMint(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!isValidPubkey(s) || new PublicKey(s).toBase58() !== s) throw new Error("token must be a base58 Solana mint address (case-sensitive).");
  return s;
}
const isSig = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const isPk = (s: unknown): s is string => typeof s === "string" && isValidPubkey(s);

// ═══ READS ═══════════════════════════════════════════════════════════════════
export function formatSolanaPairs(chainsEntry: any): string {
  const quotes: any[] = Array.isArray(chainsEntry?.quotes) ? chainsEntry.quotes : [];
  return `${q("solana")}: ` + quotes.map((x) => `${x.symbol} (${x.key}, ${x.decimals} dec, ${x.address})`).join(", ");
}

export function formatSolanaLaunch(l: any, i: number): string {
  const mc = typeof l.marketCapSol === "number" ? `${fmtNum(l.marketCapSol)} SOL${typeof l.marketCapUsd === "number" ? ` ($${fmtNum(l.marketCapUsd)})` : ""}` : `$${fmtNum(l.marketCapUsd)}`;
  return `${i + 1}. ${q(l.name)} (${q(l.symbol)}) on solana · ${l.token} · mcap ${mc} · 24h vol ${typeof l.volume24hSol === "number" ? fmtNum(l.volume24hSol) + " SOL" : "$" + fmtNum(l.volume24hUsd)}${l.hasAgent ? ` · AI founder${l.agentSlug ? " " + q(l.agentSlug) : ""}` : ""}`;
}

export async function solanaTokenRead(mint: string): Promise<any> {
  return callConvex(`/launchpad/token?chain=solana&token=${encodeURIComponent(mint)}`, "GET", undefined, "launchpad_token");
}

export function formatSolanaToken(r: any, mint: string): { text: string } {
  const t = r?.token && typeof r.token === "object" ? r.token : r;
  const st = r?.stats ?? {};
  const ag = r?.agent ?? r?.agentDetail ?? null;
  const price = typeof st.priceSol === "number" ? `${fmtNum(st.priceSol)} SOL` : "";
  const mc = typeof st.marketCapSol === "number" ? `${fmtNum(st.marketCapSol)} SOL` : "";
  const usd = (v: unknown) => (typeof v === "number" ? ` ($${fmtNum(v)})` : "");
  const lines = [
    `${q(t?.name ?? "?")} (${q(t?.symbol ?? "?")}) on solana · ${mint}`,
    `Price ${price || "n/a"}${usd(st.priceUsd)} · mcap ${mc || "n/a"}${usd(st.marketCapUsd)} · 24h vol ${typeof st.volume24hSol === "number" ? fmtNum(st.volume24hSol) + " SOL" : "n/a"}${usd(st.volume24hUsd)}`,
  ];
  if (t?.poolId) lines.push(`Pool (Meteora DAMM v2): ${t.poolId}`);
  if (ag) {
    lines.push(`AI founder: status ${q(ag.status)}${ag.feeRouted !== undefined ? ` · fees routed: ${ag.feeRouted ? "yes" : "no"}` : ""}${ag.budgetUsd !== undefined ? ` · budget $${fmtNum(ag.budgetUsd)}` : ""}`);
    const pu = ag.productUrl ?? r?.productUrl;
    if (pu) lines.push(`Product: ${pu}`);
  } else lines.push("AI founder: none");
  return { text: lines.join("\n") };
}

// ═══ LAUNCH (server-side, user's Finch account) ═════════════════════════════
export const LOGIN_REQUIRED_MSG =
  "Launching on Solana runs in YOUR FINCH ACCOUNT (its custodial Solana wallet), so it needs a real logged-in session. " +
  "Run `finch login` (or set FINCH_SESSION_TOKEN to your session token in the MCP config) and retry. " +
  "A FINCH_API_KEY or a wallet signature alone cannot launch on Solana. Nothing was sent.";

/** The session token for Finch-account actions. API keys (finch_sk_/noel_sk_) are NOT session tokens. */
export function requireSessionToken(): string {
  const t = getSavedToken();
  if (!t || isApiKey(t)) throw new Error(LOGIN_REQUIRED_MSG);
  return t.trim();
}

async function sessionFetch(route: string, method: "GET" | "POST", token: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(`${CONVEX_SITE}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw Object.assign(new Error(`${String(e?.message ?? e).slice(0, 160)} - request may or may not have completed (no response received).`), { ambiguous: true });
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
const apiErr = (r: { status: number; json: any; text: string }): string => String(r.json?.error ?? r.json?.message ?? r.text.slice(0, 200) ?? "").slice(0, 300) || "(no body)";

export interface FinchSolWallet { address: string; balanceLamports: bigint | null }
export async function fetchFinchSolanaWallet(token: string): Promise<FinchSolWallet> {
  const r = await sessionFetch("/launchpad/solana/wallet", "GET", token);
  if (r.status === 401) throw new Error(`Your Finch session was rejected (${apiErr(r)}). Run \`finch login\` again. Nothing was sent.`);
  if (r.status < 200 || r.status >= 300) throw new Error(`Could not read your Finch Solana wallet (HTTP ${r.status}: ${apiErr(r)}).`);
  const j = r.json ?? {};
  const address = j.address ?? j.wallet;
  if (!isPk(address)) throw new Error("Finch returned an invalid Solana wallet address; refusing to proceed.");
  let balanceLamports: bigint | null = null;
  try {
    if (j.lamports !== undefined && j.lamports !== null) balanceLamports = BigInt(j.lamports);
    else if (j.balanceLamports !== undefined && j.balanceLamports !== null) balanceLamports = BigInt(j.balanceLamports);
    else if (typeof j.balanceSol === "number" && Number.isFinite(j.balanceSol) && j.balanceSol >= 0) balanceLamports = BigInt(Math.round(j.balanceSol * 1e9));
    else if (typeof j.balance === "number" && Number.isFinite(j.balance) && j.balance >= 0) balanceLamports = BigInt(Math.round(j.balance * 1e9));
  } catch { balanceLamports = null; }
  return { address, balanceLamports };
}

export interface SolanaLaunchRequest {
  name: string; symbol: string; startingMarketCapSol: number; boostSol: number;
  description?: string; imageUrl?: string; website?: string; agentBrief?: string;
}
export function parseSolanaLaunchArgs(a: Record<string, any>, helpers: { optStr: (v: unknown, max: number, what: string) => string | undefined; httpsUrl: (v: unknown, what: string) => string | undefined }): SolanaLaunchRequest {
  const name = String(a.name ?? "").trim();
  const symbol = String(a.symbol ?? "").trim().toUpperCase();
  if (!name || name.length > 32) throw new Error("Name must be 1-32 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol must be 1-10 letters or digits.");
  const startingMarketCapSol = a.startingMarketCapSol === undefined || a.startingMarketCapSol === null ? DEFAULT_SOLANA_MCAP_SOL : Number(a.startingMarketCapSol);
  if (!(startingMarketCapSol > 0) || !Number.isFinite(startingMarketCapSol) || startingMarketCapSol > 10_000_000) throw new Error("startingMarketCapSol must be a positive number of WHOLE SOL (max 10,000,000).");
  const boostSol = a.boostSol === undefined || a.boostSol === null || a.boostSol === "" ? 0 : Number(a.boostSol);
  if (!Number.isFinite(boostSol) || boostSol < 0 || boostSol > 1_000) throw new Error("boostSol must be a number of SOL >= 0.");
  // exact lamports (9 dp max) so the cap math is exact
  if (boostSol > 0) { try { parseHumanToBaseUnits(String(boostSol), 9); } catch { throw new Error("boostSol must be a plain decimal with at most 9 decimal places."); } }
  return {
    name, symbol, startingMarketCapSol, boostSol,
    description: helpers.optStr(a.description, 280, "description"),
    imageUrl: helpers.httpsUrl(a.imageUrl, "imageUrl"),
    website: helpers.httpsUrl(a.website, "website"),
    agentBrief: helpers.optStr(a.agentBrief, 500, "agentBrief"),
  };
}
const boostLamports = (boostSol: number): bigint => (boostSol > 0 ? parseHumanToBaseUnits(String(boostSol), 9) : 0n);

export const EXPECTED_SPLIT = { agentBps: 9000, creatorBps: 1000, platformBps: 0 } as const;
export function splitIsTruthful(s: any): boolean {
  return !!s && s.agentBps === EXPECTED_SPLIT.agentBps && s.creatorBps === EXPECTED_SPLIT.creatorBps && s.platformBps === EXPECTED_SPLIT.platformBps;
}

export async function handleSolanaLaunch(a: Record<string, any>, helpers: Parameters<typeof parseSolanaLaunchArgs>[1]): Promise<ToolResult> {
  if (a.retryRegisterTxHash !== undefined && a.retryRegisterTxHash !== "") throw new Error("retryRegisterTxHash is for Base/Robinhood only: a Solana launch is a single server-side action with nothing to re-register.");
  const req = parseSolanaLaunchArgs(a, helpers);
  const boost = boostLamports(req.boostSol);
  const totalNeed = boost + SOLANA_RENT_LAMPORTS;

  // login check BEFORE any launch-route contact (and before the wallet read, which also needs the session)
  const token = requireSessionToken();
  const wallet = await fetchFinchSolanaWallet(token);
  const balTxt = wallet.balanceLamports === null ? "unavailable" : `${formatBaseUnits(wallet.balanceLamports, 9)} SOL`;
  const structured = {
    chain: "solana", name: req.name, symbol: req.symbol, startingMarketCapSol: req.startingMarketCapSol, boostSol: req.boostSol,
    finchWallet: wallet.address, finchWalletBalanceSol: wallet.balanceLamports === null ? null : formatBaseUnits(wallet.balanceLamports, 9),
    estimatedCostSol: formatBaseUnits(totalNeed, 9), split: { ...EXPECTED_SPLIT },
  };

  if (a.confirmed !== true) {
    const short = wallet.balanceLamports !== null && wallet.balanceLamports < totalNeed
      ? `\n\n⚠ Your Finch Solana wallet does not hold enough SOL yet: send at least ${formatBaseUnits(totalNeed, 9)} SOL to ${wallet.address} (this is the wallet that executes the launch), then confirm.` : "";
    return blockedMsg(
      `Launch on Solana (executes in YOUR FINCH ACCOUNT's custodial Solana wallet, not your local wallet):\n` +
      `Name: ${q(req.name)}\nSymbol: ${q(req.symbol)}\nDescription: ${q(req.description ?? "")}\nImage: ${q(req.imageUrl ?? "")}\nWebsite: ${q(req.website ?? "")}\nAI founder brief: ${q(req.agentBrief ?? "")}\n` +
      `Pool: Meteora DAMM v2, single-sided, quote asset SOL; fixed 1,000,000,000 supply, 9 decimals, mint authority revoked.\n` +
      `Starting market cap: ${req.startingMarketCapSol} SOL\nBoost to the AI founder's budget: ${req.boostSol} SOL\n` +
      `Cost: ~${SOLANA_RENT_SOL} SOL rent + fees (no seed liquidity is deposited)${req.boostSol > 0 ? ` + ${req.boostSol} SOL boost = ~${formatBaseUnits(totalNeed, 9)} SOL` : ""}\n` +
      `Fee split: the agent self-funds: 90% agent / 10% you / 0% Finch (claimed by Finch's cron from your Finch wallet).\n` +
      `Finch Solana wallet (pays for the launch): ${wallet.address}\nIts SOL balance: ${balTxt}${short}${spendNote()}`,
      structured, "Re-run with confirmed=true after the user has approved these exact details. This is a server-side action: it cannot be undone and must not be retried blindly.",
    );
  }

  // gate + caps, before the launch route is touched
  assertLaunchpadSolanaSpend("launchpad_launch_token");
  const cap = maxLaunchLamports(); maxBuyLamports(); // validate every cap env: junk fails closed
  if (totalNeed > cap) throw new Error(`Launch cost ${formatBaseUnits(totalNeed, 9)} SOL (rent ${SOLANA_RENT_SOL} + boost ${req.boostSol}) exceeds FINCH_LAUNCHPAD_MAX_SOL_LAUNCH (${formatBaseUnits(cap, 9)}). Nothing was sent.`);
  if (wallet.balanceLamports !== null && wallet.balanceLamports < totalNeed) {
    throw new Error(`Not enough SOL in your Finch Solana wallet ${wallet.address}: it has ${balTxt}, the launch needs about ${formatBaseUnits(totalNeed, 9)} SOL. Deposit SOL there and retry. Nothing was sent.`);
  }

  const body: Record<string, unknown> = { name: req.name, symbol: req.symbol, startingMarketCapSol: req.startingMarketCapSol };
  for (const k of ["description", "imageUrl", "website", "agentBrief"] as const) if (req[k] !== undefined) body[k] = req[k];
  if (req.boostSol > 0) body.boostSol = req.boostSol;

  const NO_RETRY = "DO NOT retry the launch: check launchpad_token / launchpad_launches and your Finch Solana wallet balance first, since a retry could launch a second token.";
  let r: { status: number; json: any; text: string };
  try { r = await sessionFetch("/launchpad/solana/launch", "POST", token, body, 180_000); }
  catch (e: any) { throw new Error(`${String(e?.message ?? e)} The launch may have been executed. ${NO_RETRY} (Finch wallet: ${wallet.address})`); }
  if (r.status === 401) throw new Error(`Finch rejected the launch (401): ${apiErr(r)} Run \`finch login\` and retry. Nothing was sent.`);
  if (r.status < 200 || r.status >= 300) {
    const definite = r.status >= 400 && r.status < 500;
    throw new Error(`Finch launch API error ${r.status}: ${apiErr(r)}${definite ? " Nothing was launched." : ` The launch may have been executed. ${NO_RETRY}`}`);
  }
  const j = r.json;
  if (!j || j.ok !== true || !isPk(j.mint) || !isPk(j.poolId) || !isSig(j.mintTx) || !isSig(j.poolTx) || (j.wallet !== null && j.wallet !== undefined && !isPk(j.wallet))) {
    throw new Error(`Finch returned an unexpected launch response; the launch may have been executed. ${NO_RETRY} (Finch wallet: ${wallet.address})`);
  }
  // the backend may omit the wallet (null); when present it MUST be the wallet shown in the preview
  if (j.wallet !== null && j.wallet !== undefined && j.wallet !== wallet.address) {
    throw new Error(`Finch executed the launch from ${j.wallet}, which differs from the wallet shown in the preview (${wallet.address}). Mint: ${j.mint}. ${NO_RETRY}`);
  }
  const splitOk = splitIsTruthful(j.split);
  const slug = typeof j.agentSlug === "string" ? j.agentSlug : null;
  const productUrl = typeof j.productUrl === "string" && /^https:\/\//.test(j.productUrl) ? j.productUrl : null;
  const out = {
    executed: true, chain: "solana", mint: j.mint, poolId: j.poolId, mintTx: j.mintTx, poolTx: j.poolTx,
    agentSlug: slug, productUrl, split: j.split ?? null, splitVerified: splitOk,
    explorerMint: `https://solscan.io/token/${j.mint}`, explorerPool: `https://solscan.io/account/${j.poolId}`,
    wallet: j.wallet ?? wallet.address, explorerMintTx: `https://solscan.io/tx/${j.mintTx}`, explorerPoolTx: `https://solscan.io/tx/${j.poolTx}`,
  };
  const text =
    `✅ Token launched on Solana from your Finch account.\nMint: ${j.mint}\nPool (Meteora DAMM v2): ${j.poolId}\n` +
    `Mint tx: ${out.explorerMintTx}\nPool tx: ${out.explorerPoolTx}\nToken page: ${out.explorerMint}\nLaunched from Finch wallet: ${out.wallet}\n` +
    (slug ? `AI founder created: ${q(slug)}\n` : "No AI founder reported yet.\n") +
    (productUrl ? `Product: ${productUrl}\n` : "Product URL: not available yet (the AI founder is still starting).\n") +
    (splitOk ? "Fee split (agent self-funds): 90% agent / 10% you / 0% Finch. Claimed by Finch's cron from your Finch wallet (not a contract split).\n"
      : `⚠ Finch reported an UNEXPECTED fee split ${JSON.stringify(j.split ?? null)} (expected 90/10/0). Verify with launchpad_token before relying on it.\n`);
  return ok(text.trim(), out);
}

// ═══ BUY / SELL (local wallet, direct cp-amm) ═══════════════════════════════
export interface SolanaLaunchInfo { mint: string; pool: PublicKey; state: SwapPoolState; symbol: string; name: string }

/** Only Finch-launched mints; pool = WSOL + token verified on-chain. Throws otherwise. */
export async function resolveSolanaLaunch(mintIn: unknown): Promise<SolanaLaunchInfo> {
  const mint = parseSolanaMint(mintIn);
  const r = await solanaTokenRead(mint).catch((e: any) => {
    if (/404|not found/i.test(String(e?.message))) throw new Error(`Refused: ${q(mint)} is not a Finch launch. Only Finch-launched tokens can be traded with this tool.`);
    throw e;
  });
  const t = r;
  if (t?.chain !== "solana" || t?.token !== mint) {
    throw new Error(`Refused: Finch does not report ${q(mint)} as a Solana launch. Only Finch-launched tokens can be traded with this tool.`);
  }
  if ((t?.source ?? r?.source) !== "finch") throw new Error(`Refused: ${q(mint)} is not a Finch-launched token (source ${q(t?.source ?? r?.source ?? "unknown")}). Only Finch-launched tokens can be traded with this tool.`);
  const poolId = t?.poolId ?? r?.poolId;
  if (!isPk(poolId)) throw new Error("Refused: Finch has no pool recorded for this token.");
  const pool = new PublicKey(poolId);
  const acc = await getAccount(pool.toBase58());
  if (!acc) throw new Error("Refused: the recorded pool was not found on-chain.");
  if (acc.owner !== METEORA_CP_AMM_PROGRAM.toBase58()) throw new Error("Refused: the recorded pool is not owned by the Meteora cp-amm program.");
  if (acc.data.length < MIN_POOL_ACCOUNT_BYTES || Buffer.compare(acc.data.subarray(0, 8), POOL_ACCOUNT_DISCRIMINATOR) !== 0) throw new Error("Refused: the recorded pool account is not a cp-amm pool.");
  const state = decodeSwapPool(acc.data);
  const aSol = state.tokenAMint.equals(WSOL_MINT), bSol = state.tokenBMint.equals(WSOL_MINT);
  if (aSol === bSol) throw new Error("Refused: the pool is not a SOL pair.");
  const other = aSol ? state.tokenBMint : state.tokenAMint;
  if (other.toBase58() !== mint) throw new Error("Refused: the pool does not match the token.");
  if (state.collectFeeMode !== 0) throw new Error("Refused: the pool uses a fee mode this tool cannot quote exactly.");
  if (state.liquidity <= 0n) throw new Error("Refused: the pool has no liquidity.");
  const m = await getAccount(mint);
  if (!m || m.owner !== TOKEN_PROGRAM_STR || m.data.length < 82) throw new Error("Refused: the token mint is not a classic SPL token mint.");
  if (m.data.readUInt8(44) !== SOLANA_TOKEN_DECIMALS) throw new Error("Refused: unexpected token decimals (Finch launches use 9).");
  return { mint, pool, state, symbol: String(t?.symbol ?? "?").slice(0, 32), name: String(t?.name ?? "?").slice(0, 64) };
}

export interface SolTradeArgs {
  side: "buy" | "sell"; li: SolanaLaunchInfo; amountIn: bigint; slippageBps: number;
  wallet: PublicKey | null; confirmed: boolean; quoteId?: string;
}
interface Prev { side: "buy" | "sell"; mint: string; amountIn: bigint; minOut: bigint; slippageBps: number; wallet: string | null; at: number }
const previews = new Map<string, Prev>();
const TTL_MS = 10 * 60_000;
export function _resetSolanaPreviews(): void { previews.clear(); }

const mints = (side: "buy" | "sell", mint: string) => side === "buy" ? { inputMint: WSOL_MINT.toBase58(), outputMint: mint } : { inputMint: mint, outputMint: WSOL_MINT.toBase58() };
function idFor(side: "buy" | "sell", mint: string, amountIn: bigint, minOut: bigint, slippageBps: number): string {
  return quoteIdOf({ ...mints(side, mint), inAmountRaw: amountIn, minOutRaw: minOut, slippageBps });
}
function remember(p: Omit<Prev, "at">): string {
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.at > TTL_MS) previews.delete(k);
  if (previews.size > 200) previews.delete(previews.keys().next().value as string);
  const id = idFor(p.side, p.mint, p.amountIn, p.minOut, p.slippageBps);
  previews.set(id, { ...p, at: now });
  return id;
}

export function quoteSolanaSwap(li: SolanaLaunchInfo, side: "buy" | "sell", amountIn: bigint, slippageBps: number): MeteoraQuote {
  const inputMint = side === "buy" ? WSOL_MINT : new PublicKey(li.mint);
  // both sides are 9-decimal classic SPL (verified in resolveSolanaLaunch); the date only matters for scheduled fees
  const qt = quoteExactIn(li.state, inputMint, amountIn, slippageBps, 9, 9, BigInt(Math.floor(Date.now() / 1000)));
  if (!Number.isFinite(qt.priceImpactPct)) throw new Error("Could not read the price impact. Nothing was sent.");
  if (qt.outAmount <= 0n) throw new Error("The pool has no output liquidity for this trade. Nothing was sent.");
  if (qt.minOut <= 0n) throw new Error("Computed minimum received is zero; amount too small. Nothing was sent.");
  return qt;
}

function describeTrade(a: SolTradeArgs, qt: MeteoraQuote, id: string): { text: string; structured: Record<string, unknown> } {
  const inSym = a.side === "buy" ? "SOL" : a.li.symbol, outSym = a.side === "buy" ? a.li.symbol : "SOL";
  const text = [
    `${a.side === "buy" ? "BUY" : "SELL"} on solana (direct Meteora cp-amm swap, pool ${a.li.pool.toBase58()})`,
    `Token: ${q(a.li.mint)} symbol ${q(a.li.symbol)} · quote asset SOL`,
    `Wallet (local): ${a.wallet ? a.wallet.toBase58() : "none yet (run sol_wallet to create and fund one)"}`,
    `In:  ${formatBaseUnits(a.amountIn, 9)} ${inSym}`,
    `Expected out: ${formatBaseUnits(qt.outAmount, 9)} ${outSym}`,
    `Min received (slippage ${a.slippageBps / 100}%): ${formatBaseUnits(qt.minOut, 9)} ${outSym}`,
    `Price impact: ${qt.priceImpactPct.toFixed(2)}% (limit ${MAX_PRICE_IMPACT_PCT}%)`,
    a.side === "buy" ? "A temporary wSOL account is created, funded, swapped from and closed in one transaction (about 0.01 SOL is kept for fees/rent)." : "Proceeds are unwrapped to native SOL in the same transaction.",
    `quoteId: ${id}`,
  ].join("\n");
  return { text, structured: {
    chain: "solana", side: a.side, token: a.li.mint, symbol: a.li.symbol, quote: "SOL", pool: a.li.pool.toBase58(), wallet: a.wallet?.toBase58() ?? null,
    amountIn: formatBaseUnits(a.amountIn, 9), expectedOut: formatBaseUnits(qt.outAmount, 9), minOut: formatBaseUnits(qt.minOut, 9),
    slippageBps: a.slippageBps, priceImpactPct: qt.priceImpactPct, quoteId: id,
  } };
}

const CONFIRM_TAIL = "Re-run with confirmed=true and the quoteId after the user has approved these exact details.";

export async function runSolanaTrade(a: SolTradeArgs): Promise<ToolResult> {
  const tool = a.side === "buy" ? "launchpad_buy" : "launchpad_sell";
  const qt = quoteSolanaSwap(a.li, a.side, a.amountIn, a.slippageBps);
  const walletStr = a.wallet?.toBase58() ?? null;
  if (qt.priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    const d = describeTrade(a, qt, idFor(a.side, a.li.mint, a.amountIn, qt.minOut, a.slippageBps));
    return { content: [{ type: "text", text: `⛔ REJECTED: price impact ${qt.priceImpactPct.toFixed(2)}% exceeds the ${MAX_PRICE_IMPACT_PCT}% limit. Reduce the amount.\n\n${d.text}` }], structuredContent: { executed: false, rejected: "price_impact", ...d.structured }, isError: true };
  }
  const prev = typeof a.quoteId === "string" ? previews.get(a.quoteId) : undefined;
  const matches = !!prev && prev.side === a.side && prev.mint === a.li.mint && prev.amountIn === a.amountIn && prev.slippageBps === a.slippageBps && idFor(prev.side, prev.mint, prev.amountIn, prev.minOut, prev.slippageBps) === a.quoteId;
  if (a.confirmed !== true || !matches) {
    const id = remember({ side: a.side, mint: a.li.mint, amountIn: a.amountIn, minOut: qt.minOut, slippageBps: a.slippageBps, wallet: walletStr });
    const d = describeTrade(a, qt, id);
    const why = a.confirmed === true ? `\n\n(confirmed=true was ignored: no matching quoteId from a preview of THESE parameters. Show the user this preview, then call again with confirmed=true and quoteId=${id}.)` : "";
    return blockedMsg(d.text + why + spendNote(), d.structured, CONFIRM_TAIL);
  }
  // ── confirmed, bound to a previewed quote ──
  assertLaunchpadSolanaSpend(tool);
  // drift: the live guaranteed minimum must not be >0.5% worse than the previewed one
  if (qt.minOut * 10_000n < prev!.minOut * BigInt(10_000 - MAX_QUOTE_DRIFT_BPS)) {
    throw new Error(`Quote moved: minimum received is now ${formatBaseUnits(qt.minOut, 9)}, more than ${MAX_QUOTE_DRIFT_BPS / 100}% worse than the previewed ${formatBaseUnits(prev!.minOut, 9)}. Nothing was sent; request a new preview.`);
  }
  if (a.side === "buy") {
    const cap = maxBuyLamports();
    if (a.amountIn > cap) throw new Error(`Buy amount ${formatBaseUnits(a.amountIn, 9)} SOL exceeds the per-call cap ${formatBaseUnits(cap, 9)} (FINCH_LAUNCHPAD_MAX_BUY_SOL). Nothing was sent.`);
  } else maxBuyLamports(); // junk cap env fails closed on every confirmed trade
  const w = loadSolanaKeypair(false);
  if (!w) throw new Error("No local Solana wallet exists. Run sol_wallet first to create one and fund it, then retry.");
  const wallet = w.keypair.publicKey;
  if (wallet.toBase58() !== prev!.wallet) throw new Error("Wallet changed (or was created) between preview and execution; request a new preview.");

  // balances (errors surface; never read as zero)
  const bal = BigInt((await solRpc("getBalance", [wallet.toBase58(), { commitment: "confirmed" }]))?.value ?? 0);
  const need = (a.side === "buy" ? a.amountIn : 0n) + SWAP_RESERVE;
  if (bal < need) throw new Error(`Insufficient SOL: have ${formatBaseUnits(bal, 9)}, need at least ${formatBaseUnits(need, 9)} (${a.side === "buy" ? "amount + " : ""}0.01 SOL fee/rent reserve). Nothing was sent.`);
  if (a.side === "sell") {
    const tokBal = await tokenBalance(wallet, a.li.mint);
    if (tokBal < a.amountIn) throw new Error(`Insufficient token balance: have ${formatBaseUnits(tokBal, 9)}, need ${formatBaseUnits(a.amountIn, 9)}. Nothing was sent.`);
  }

  // build exactly the backend's instruction list
  const inputMint = a.side === "buy" ? WSOL_MINT : new PublicKey(a.li.mint);
  const ixs = buildSwapInstructions({ wallet, pool: a.li.pool, state: a.li.state, inputMint, amountIn: a.amountIn, minOut: qt.minOut, tokenAProgram: TOKEN_PROGRAM, tokenBProgram: TOKEN_PROGRAM });
  const bh = (await solRpc("getLatestBlockhash", [{ commitment: "confirmed" }]))?.value?.blockhash;
  if (typeof bh !== "string") throw new Error("Could not fetch a recent blockhash. Nothing was sent.");
  const tx = compileSwapTx(wallet, bh, ixs);
  const wsolAta = ataAddress(WSOL_MINT, wallet, TOKEN_PROGRAM).toBase58();
  // 1) exactly our instructions, nothing added; 2) program allowlist/signers/transfer destinations; 3) simulation bounds
  assertTxMatchesPlan(tx, ixs);
  await assertSafeTx(tx, { wallet, allowedPrograms: SOLANA_SWAP_PROGRAMS, maxLamportsOut: a.side === "buy" ? a.amountIn : 0n, allowedSolDestinations: [wsolAta], lookupTables: [] });
  await simulateAndAssert(tx, {
    wallet,
    maxSolDecrease: (a.side === "buy" ? a.amountIn : 0n) + SWAP_RESERVE,
    ...(a.side === "sell" ? { minSolIncrease: qt.minOut - SWAP_RESERVE } : {}),
    tokens: a.side === "buy" ? [{ mint: a.li.mint, minIncrease: qt.minOut }] : [{ mint: a.li.mint, maxDecrease: a.amountIn }],
  });
  tx.sign([w.keypair]);
  const sig = await sendAndConfirm(tx);
  const d = describeTrade(a, qt, a.quoteId!);
  const link = `https://solscan.io/tx/${sig}`;
  return ok(`✅ ${a.side === "buy" ? "Buy" : "Sell"} confirmed.\n${d.text}\nSignature: ${sig}\n${link}`, { ...d.structured, executed: true, confirmed: true, signature: sig, explorer: link });
}

async function tokenBalance(owner: PublicKey, mint: string): Promise<bigint> {
  const ata = ataAddress(new PublicKey(mint), owner, TOKEN_PROGRAM);
  const acc = await getAccount(ata.toBase58());
  if (!acc || acc.owner !== TOKEN_PROGRAM_STR || acc.data.length < 72) return 0n;
  return acc.data.readBigUInt64LE(64);
}

function parseSolAmount(v: unknown, name: string): bigint {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${name} must be a positive decimal number (e.g. "0.1").`);
  return parseHumanToBaseUnits(s, 9); // validates decimals, > 0 and u64 range
}

export async function handleSolanaBuy(a: Record<string, any>): Promise<ToolResult> {
  const slippageBps = slippagePctToBps(a.slippagePct);
  const li = await resolveSolanaLaunch(a.token);
  const amountIn = parseSolAmount(a.amount, "amount");
  const w = loadSolanaKeypair(false);
  return runSolanaTrade({ side: "buy", li, amountIn, slippageBps, wallet: w?.keypair.publicKey ?? null, confirmed: a.confirmed === true, quoteId: typeof a.quoteId === "string" ? a.quoteId : undefined });
}

export async function handleSolanaSell(a: Record<string, any>): Promise<ToolResult> {
  const slippageBps = slippagePctToBps(a.slippagePct);
  const li = await resolveSolanaLaunch(a.token);
  const w = loadSolanaKeypair(false);
  if (!w) throw new Error("No local Solana wallet exists, so there is nothing to sell. Run sol_wallet to create one.");
  const hasPct = a.percent !== undefined && a.percent !== null;
  const hasAmt = a.amount !== undefined && a.amount !== null && a.amount !== "";
  if (hasPct === hasAmt) throw new Error("Provide exactly one of percent or amount.");
  const bal = await tokenBalance(w.keypair.publicKey, li.mint);
  if (bal === 0n) throw new Error(`The local wallet ${w.keypair.publicKey.toBase58()} holds none of this token.`);
  let amountIn: bigint;
  if (hasPct) {
    const p = Number(a.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error("percent must be a number in (0, 100].");
    amountIn = p === 100 ? bal : (bal * BigInt(Math.round(p * 100))) / 10_000n;
    if (amountIn <= 0n) throw new Error("percent of balance rounds to zero.");
  } else {
    amountIn = parseSolAmount(a.amount, "amount");
    if (amountIn > bal) throw new Error(`amount exceeds your balance of ${formatBaseUnits(bal, 9)}.`);
  }
  return runSolanaTrade({ side: "sell", li, amountIn, slippageBps, wallet: w.keypair.publicKey, confirmed: a.confirmed === true, quoteId: typeof a.quoteId === "string" ? a.quoteId : undefined });
}

export type { VersionedTransaction };
