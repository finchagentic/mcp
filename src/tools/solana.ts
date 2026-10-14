// Solana tools: balances, token info, Jupiter quotes/swaps, transfers and
// pump.fun launches. Uses plain @solana/web3.js v1 for keys/transactions and
// raw JSON-RPC over fetch for network calls (so everything is mockable).
//
// Safety model mirrors rh_mcp_swap: every fund-moving tool needs
// confirmed=true; without it the tool only returns an estimate and sends
// nothing. The local keypair is never returned or logged.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as net from "net";
import dns from "dns";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { getMachineKey, getKeyMaterial } from "../wallet.js";

// ── Constants ────────────────────────────────────────────────────────────────
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
// Official $FINCH (Solana pump.fun). Do not confuse with stale EVM addresses elsewhere.
export const FINCH_MINT = "4LKS9yUYaBEZyzsaExmFXcWbG9pDBX7AWhseigVYpump";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const KNOWN_MINTS: Record<string, { mint: string; decimals: number }> = {
  SOL: { mint: SOL_MINT, decimals: 9 },
  WSOL: { mint: SOL_MINT, decimals: 9 },
  USDC: { mint: USDC_MINT, decimals: 6 },
  USDT: { mint: USDT_MINT, decimals: 6 },
  FINCH: { mint: FINCH_MINT, decimals: 6 },
};

export const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
const JUP_TOKENS = "https://lite-api.jup.ag/tokens/v2/search";
const DEXSCREENER = "https://api.dexscreener.com/latest/dex/tokens";
const PUMP_IPFS = "https://pump.fun/api/ipfs";
const PUMPPORTAL_LOCAL = "https://pumpportal.fun/api/trade-local";

export const MAX_PRICE_IMPACT_PCT = 5;
export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_MAX_SLIPPAGE_BPS = 500;   // 5% unless allowHighSlippage
export const MAX_SLIPPAGE_BPS = 1000;          // hard ceiling, even with allowHighSlippage
export const MAX_QUOTE_DRIFT_BPS = 50;         // 0.5% worse min-out between preview and execution
const SWAP_SOL_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL for fees + ATA rent
const ATA_RENT_LAMPORTS = 2_100_000n;          // ~0.0021 SOL
const SYSTEM_MIN_RENT_LAMPORTS = 890_880n;
const MAX_DESCRIPTION_CHARS = 1000;
const MAX_IMAGE_REDIRECTS = 3;
export const MAX_DEV_BUY_SOL = 10;
const MIN_LAUNCH_BUFFER_LAMPORTS = 30_000_000n; // 0.03 SOL for mint rent + fees
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function solanaRpcUrl(): string {
  return process.env.FINCH_SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
}

// ── Exact amount math (BigInt, no floats) ────────────────────────────────────
/** Parse a human decimal string ("1.5") to base units. Throws on anything inexact. */
export function parseHumanToBaseUnits(amount: string | number, decimals: number): bigint {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount "${s}": use a plain positive decimal string like "1.5" (no exponent, no sign).`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`Invalid decimals ${decimals}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    // Allow trailing zeros beyond precision, reject real precision loss.
    if (/[1-9]/.test(frac.slice(decimals))) {
      throw new Error(`Amount "${s}" has more than ${decimals} decimal places for this token.`);
    }
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  if (v <= 0n) throw new Error("Amount must be greater than zero.");
  if (v > 0xffffffffffffffffn) throw new Error("Amount exceeds u64.");
  return v;
}

/** Format base units to a human decimal string, trimming trailing zeros. */
export function formatBaseUnits(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

// ── Mint resolution ──────────────────────────────────────────────────────────
export function isValidPubkey(s: string): boolean {
  try {
    if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** Resolve SOL/USDC/USDT/FINCH (case-insensitive) or a base58 mint to {mint, decimals?}. */
export function resolveMint(input: string): { mint: string; decimals?: number } {
  const t = String(input ?? "").trim();
  if (!t) throw new Error("Missing token: give a symbol (SOL, USDC, USDT, FINCH) or a mint address.");
  const known = KNOWN_MINTS[t.toUpperCase()];
  if (known) return { ...known };
  if (!isValidPubkey(t)) throw new Error(`Unknown token "${t}": use SOL, USDC, USDT, FINCH or a valid base58 mint address.`);
  const hit = Object.values(KNOWN_MINTS).find((k) => k.mint === t);
  return hit ? { ...hit } : { mint: t };
}

// ── JSON-RPC / HTTP helpers ──────────────────────────────────────────────────
async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(solanaRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    // Never include the URL: it may embed an API key.
    throw new Error(`Solana RPC ${method} request failed: ${String(e?.message ?? e).replace(/https?:\/\/\S+/g, "<url>")}`);
  }
  if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`);
  const data: any = await res.json();
  if (data.error) throw new Error(`Solana RPC ${method}: ${data.error.message ?? JSON.stringify(data.error)}`);
  return data.result as T;
}

// retries: only for idempotent calls (quotes, token lookups, swap-tx *building*);
// never for uploads or anything that submits a transaction.
async function getJson(url: string, init?: RequestInit, retries = 0): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJsonOnce(url, init);
    } catch (e: any) {
      const transient = /^HTTP (429|5\d\d) /.test(String(e?.message)) || /fetch failed|timeout|aborted/i.test(String(e?.message));
      if (attempt >= retries || !transient) throw e;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

async function getJsonOnce(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" && body ? (body.error ?? body.message ?? JSON.stringify(body)) : String(body).slice(0, 200);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${String(msg).slice(0, 300)}`);
  }
  return body;
}

export async function getMintDecimals(mint: string): Promise<number> {
  const known = Object.values(KNOWN_MINTS).find((k) => k.mint === mint);
  if (known) return known.decimals;
  const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const d = info?.value?.data?.parsed?.info?.decimals;
  if (typeof d !== "number") throw new Error(`Could not read decimals for mint ${mint} (not a token mint?).`);
  return d;
}

// ── Local Solana wallet (never returned by any tool) ─────────────────────────
// ~/.finch/solana-wallet.json, mode 0600. 64-byte ed25519 secret encrypted with
// AES-256-GCM, key derived from the SAME key material as the EVM wallet
// (FINCH_WALLET_PASSPHRASE, or per-install random secret + machine info).
function walletDir(): string { return path.join(os.homedir(), ".finch"); }
function walletFile(): string { return path.join(walletDir(), "solana-wallet.json"); }

// v2 files ("kdf":"scrypt-v1"): key = scrypt(raw key material, random 16-byte salt, N=2^15, r=8, p=1).
// Legacy files (no "kdf"): key = sha256("finch-solana-wallet:" + getMachineKey()). Still readable.
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function legacyAesKey(): Buffer {
  return crypto.createHash("sha256").update("finch-solana-wallet:" + getMachineKey()).digest();
}
function scryptKey(salt: Buffer): Buffer {
  return crypto.scryptSync(getKeyMaterial(), salt, 32, SCRYPT_PARAMS);
}

function encryptSecret(secret: Uint8Array): string {
  const iv = crypto.randomBytes(12);
  const salt = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-gcm", scryptKey(salt), iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return JSON.stringify({ v: 2, kdf: "scrypt-v1", alg: "aes-256-gcm", salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") });
}

/** Test/support helper: the pre-scrypt format, kept only so legacy files stay readable. */
export function encryptSecretLegacy(secret: Uint8Array): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", legacyAesKey(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") });
}

function decryptSecret(raw: string): Uint8Array {
  const j = JSON.parse(raw);
  const key = j.kdf === "scrypt-v1" ? scryptKey(Buffer.from(String(j.salt), "hex")) : legacyAesKey();
  if (j.kdf !== undefined && j.kdf !== "scrypt-v1") throw new Error(`Unsupported wallet kdf ${String(j.kdf)}`);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(j.iv, "hex"));
  d.setAuthTag(Buffer.from(j.tag, "hex"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]));
}

export function solanaWalletExists(): boolean {
  return fs.existsSync(walletFile());
}

/** Write to a temp file in the same dir (mode 600), fsync, then atomically publish.
 *  exclusive=true uses link() so an existing file is never replaced (EEXIST). */
function writeFileAtomic(file: string, content: string, exclusive: boolean): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    if (exclusive) fs.linkSync(tmp, file);
    else fs.renameSync(tmp, file);
  } finally {
    if (exclusive || fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
  try { const dfd = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* not supported everywhere */ }
}

/** Load the local keypair. Returns null if absent and create=false. */
export function loadSolanaKeypair(create: boolean): { keypair: Keypair; created: boolean } | null {
  const file = walletFile();
  if (fs.existsSync(file)) {
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e: any) { throw new Error(`Could not read the local Solana wallet at ${file}: ${e?.code ?? e?.message}. Refusing to replace it.`); }
    try {
      return { keypair: Keypair.fromSecretKey(decryptSecret(raw)), created: false };
    } catch (e: any) {
      // Never overwrite an existing file we cannot decrypt (would orphan funds).
      const why = /\.local-secret|per-install secret/.test(String(e?.message)) ? ` ${e.message}` : "";
      throw new Error(
        `Could not decrypt the local Solana wallet at ${file}. FINCH_WALLET_PASSPHRASE likely differs from the one used at creation (or the file is damaged). Refusing to replace it.${why}`,
      );
    }
  }
  if (!create) return null;
  const keypair = Keypair.generate();
  if (!fs.existsSync(walletDir())) fs.mkdirSync(walletDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(walletDir(), 0o700); } catch { /* best effort */ }
  try {
    writeFileAtomic(file, encryptSecret(keypair.secretKey), true);
  } catch (e: any) {
    if (e?.code === "EEXIST") return loadSolanaKeypair(false); // lost a creation race: use the persisted one
    throw e;
  }
  return { keypair, created: true };
}

function requireWallet(): Keypair {
  const w = loadSolanaKeypair(false);
  if (!w) throw new Error("No local Solana wallet exists. Run sol_wallet first to create one and fund it, then retry.");
  return w.keypair;
}

// ── Output helpers ───────────────────────────────────────────────────────────
function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}
function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${String((e as any)?.message ?? e)}` }], isError: true };
}
function blocked(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: `⛔ NOT EXECUTED — confirmation required.\n\n${text}\n\nRe-run with confirmed=true after the user has approved these exact details.` }], ...(structured ? { structuredContent: { executed: false, ...structured } } : {}) };
}

function parseSlippage(v: unknown, allowHigh = false): number {
  if (v === undefined || v === null) return DEFAULT_SLIPPAGE_BPS;
  const n = Number(v);
  const cap = allowHigh === true ? MAX_SLIPPAGE_BPS : DEFAULT_MAX_SLIPPAGE_BPS;
  if (!Number.isInteger(n) || n < 1) throw new Error(`slippageBps must be a positive integer.`);
  if (n > MAX_SLIPPAGE_BPS) throw new Error(`slippageBps ${n} exceeds the hard limit of ${MAX_SLIPPAGE_BPS} bps.`);
  if (n > cap) throw new Error(`slippageBps ${n} exceeds the default limit of ${DEFAULT_MAX_SLIPPAGE_BPS} bps. Pass allowHighSlippage:true to allow up to ${MAX_SLIPPAGE_BPS} bps (only if the user explicitly asked for it).`);
  return n;
}

// ── Spend gate & caps (default-deny) ─────────────────────────────────────────
export function assertSpendAllowed(tool: string): void {
  if (process.env.FINCH_SOL_ALLOW_SPEND !== "1") {
    throw new Error(
      `${tool} is disabled: spending from the local Solana wallet is default-deny. ` +
      "To enable it, the human operator must set the environment variable FINCH_SOL_ALLOW_SPEND=1 in the MCP server config and restart. " +
      "Per-call caps: FINCH_SOL_MAX_SEND_SOL (default 1, sol_send and launch dev buy) and FINCH_SOL_MAX_SWAP_SOL (default 5, swap input value in SOL).",
    );
  }
}
function capFromEnv(name: string, dflt: number): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return BigInt(Math.round(dflt * LAMPORTS_PER_SOL));
  return parseHumanToBaseUnits(raw, 9); // throws on junk: fail closed
}
export const maxSendLamports = () => capFromEnv("FINCH_SOL_MAX_SEND_SOL", 1);
export const maxSwapLamports = () => capFromEnv("FINCH_SOL_MAX_SWAP_SOL", 5);
const spendEnabled = () => process.env.FINCH_SOL_ALLOW_SPEND === "1";

// ── Jupiter ──────────────────────────────────────────────────────────────────
export interface SolQuote {
  inputMint: string; outputMint: string;
  inDecimals: number; outDecimals: number;
  inAmountRaw: bigint; outAmountRaw: bigint; minOutRaw: bigint;
  priceImpactPct: number; slippageBps: number;
  routes: string[];
  raw: any;
}

export async function fetchSolQuote(args: { inputMint: string; outputMint: string; amount: string; slippageBps?: number; allowHighSlippage?: boolean }): Promise<SolQuote> {
  const inp = resolveMint(args.inputMint);
  const out = resolveMint(args.outputMint);
  if (inp.mint === out.mint) throw new Error("inputMint and outputMint are the same token.");
  const slippageBps = parseSlippage(args.slippageBps, args.allowHighSlippage === true);
  const inDecimals = inp.decimals ?? (await getMintDecimals(inp.mint));
  const outDecimals = out.decimals ?? (await getMintDecimals(out.mint));
  const inAmountRaw = parseHumanToBaseUnits(args.amount, inDecimals);
  const q = new URL(JUP_QUOTE);
  q.searchParams.set("inputMint", inp.mint);
  q.searchParams.set("outputMint", out.mint);
  q.searchParams.set("amount", inAmountRaw.toString());
  q.searchParams.set("slippageBps", String(slippageBps));
  const raw = await getJson(q.toString(), undefined, 3);
  if (!raw?.outAmount) throw new Error(`Jupiter returned no route: ${JSON.stringify(raw).slice(0, 200)}`);
  // Jupiter priceImpactPct is a FRACTION string ("0.63" = 63%). A missing/blank/non-finite value must
  // NEVER be read as 0%: it would silently defeat the price-impact gate.
  if (raw.priceImpactPct === undefined || raw.priceImpactPct === null || String(raw.priceImpactPct).trim() === "") {
    throw new Error("Jupiter quote has no priceImpactPct; refusing to proceed.");
  }
  const priceImpactPct = Number(raw.priceImpactPct) * 100;
  if (!Number.isFinite(priceImpactPct)) throw new Error("Jupiter returned an unreadable priceImpactPct; refusing to proceed.");
  if (raw.otherAmountThreshold === undefined || raw.otherAmountThreshold === null || !/^\d+$/.test(String(raw.otherAmountThreshold))) {
    throw new Error("Jupiter quote has no valid otherAmountThreshold (min received); refusing to proceed.");
  }
  if (!/^\d+$/.test(String(raw.outAmount))) throw new Error("Jupiter returned an unreadable outAmount; refusing to proceed.");
  if (raw.inAmount !== undefined && String(raw.inAmount) !== inAmountRaw.toString()) throw new Error("Jupiter quote inAmount does not match the requested amount; refusing to proceed.");
  const routes = Array.from(new Set<string>((raw.routePlan ?? []).map((r: any) => r?.swapInfo?.label).filter(Boolean)));
  return {
    inputMint: inp.mint, outputMint: out.mint, inDecimals, outDecimals,
    inAmountRaw, outAmountRaw: BigInt(raw.outAmount), minOutRaw: BigInt(raw.otherAmountThreshold),
    priceImpactPct, slippageBps, routes, raw,
  };
}

export function quoteIdOf(q: { inputMint: string; outputMint: string; inAmountRaw: bigint; minOutRaw: bigint; slippageBps: number }): string {
  return crypto.createHash("sha256").update([q.inputMint, q.outputMint, q.inAmountRaw.toString(), q.minOutRaw.toString(), String(q.slippageBps)].join("|")).digest("hex").slice(0, 16);
}
// In-memory record of previewed quotes (quoteId -> quote). A confirmed swap must reference one.
const previewedQuotes = new Map<string, { q: SolQuote; at: number }>();
const QUOTE_TTL_MS = 10 * 60_000;
function rememberQuote(q: SolQuote): string {
  const now = Date.now();
  for (const [k, v] of previewedQuotes) if (now - v.at > QUOTE_TTL_MS) previewedQuotes.delete(k);
  if (previewedQuotes.size > 200) previewedQuotes.delete(previewedQuotes.keys().next().value as string);
  const id = quoteIdOf(q);
  previewedQuotes.set(id, { q, at: now });
  return id;
}

function describeQuote(q: SolQuote): string {
  return [
    `In:  ${formatBaseUnits(q.inAmountRaw, q.inDecimals)} (${q.inputMint})`,
    `Out: ${formatBaseUnits(q.outAmountRaw, q.outDecimals)} (${q.outputMint})`,
    `Min received (slippage ${q.slippageBps} bps): ${formatBaseUnits(q.minOutRaw, q.outDecimals)}`,
    `Price impact: ${q.priceImpactPct.toFixed(4)}%`,
    `Route: ${q.routes.join(" → ") || "unknown"}`,
    `quoteId: ${quoteIdOf(q)}`,
  ].join("\n");
}

function quoteStructured(q: SolQuote): Record<string, unknown> {
  return {
    inputMint: q.inputMint, outputMint: q.outputMint,
    inAmount: formatBaseUnits(q.inAmountRaw, q.inDecimals),
    outAmount: formatBaseUnits(q.outAmountRaw, q.outDecimals),
    minReceived: formatBaseUnits(q.minOutRaw, q.outDecimals),
    priceImpactPct: q.priceImpactPct, slippageBps: q.slippageBps, routes: q.routes, quoteId: quoteIdOf(q),
  };
}

// ── Transaction verification (shared by swap + launch) ───────────────────────
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MEMO_V1_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const MEMO_V2_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** Wrapper program that pumpportal's create+dev-buy transactions route the buy through (it CPIs into the pump
 *  program; observed in live trade-local output and mainnet transactions, not in the original allowlist spec).
 *  Its SOL effect is bounded by the simulation guard + System-transfer cap. */
export const PUMP_BUY_WRAPPER_PROGRAM = "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe";
export const METAPLEX_METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const JUPITER_ALLOWED_PROGRAMS = [JUPITER_V6_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, MEMO_V1_PROGRAM, MEMO_V2_PROGRAM];
export const PUMP_ALLOWED_PROGRAMS = [PUMP_PROGRAM, PUMP_BUY_WRAPPER_PROGRAM, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, METAPLEX_METADATA_PROGRAM, MEMO_V1_PROGRAM, MEMO_V2_PROGRAM];

export interface TxPolicy {
  wallet: PublicKey;
  allowedPrograms: string[];
  /** Max total lamports the transaction may move OUT of the wallet via top-level System instructions. */
  maxLamportsOut: bigint;
  /** If set, System transfers from the wallet may only go to these addresses (or to accounts created in the same tx). */
  allowedSolDestinations?: string[];
  /** Additional required signers allowed besides the wallet (e.g. the fresh mint keypair). */
  extraSigners?: string[];
  /** Max lamports the wallet may fund into a new account via CreateAccount (rent). Default 0.01 SOL. */
  maxCreateAccountLamports?: bigint;
  /** pump.fun creates the bonding-curve ATA (owner = curve PDA, rent paid by the wallet); bounded by simulation. */
  allowAtaAnyOwner?: boolean;
  /** Pre-fetched lookup tables; otherwise fetched via RPC. */
  lookupTables?: AddressLookupTableAccount[];
}

export async function fetchLookupTables(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
  const lookups = tx.message.addressTableLookups ?? [];
  const out: AddressLookupTableAccount[] = [];
  if (lookups.length === 0) return out;
  const keys = lookups.map((l) => l.accountKey.toBase58());
  const r = await rpc("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
  const vals: any[] = r?.value ?? [];
  if (vals.length !== keys.length) throw new Error("Could not resolve address lookup tables; refusing to sign.");
  keys.forEach((k, i) => {
    const v = vals[i];
    const b64 = Array.isArray(v?.data) ? v.data[0] : undefined;
    if (!b64) throw new Error(`Address lookup table ${k} not found; refusing to sign a transaction I cannot fully inspect.`);
    out.push(new AddressLookupTableAccount({ key: new PublicKey(k), state: AddressLookupTableAccount.deserialize(Buffer.from(b64, "base64")) }));
  });
  return out;
}

/**
 * Inspect an UNSIGNED transaction received from a third party and throw unless every
 * instruction is something we expect. Lookup tables are resolved so the full account list
 * is known. Returns the total lamports the top-level instructions move out of the wallet.
 */
export async function assertSafeTx(tx: VersionedTransaction, policy: TxPolicy): Promise<{ lamportsOut: bigint; programs: string[] }> {
  const wallet = policy.wallet.toBase58();
  const msg = tx.message;
  const tables = policy.lookupTables ?? (await fetchLookupTables(tx));
  let keys;
  try { keys = msg.getAccountKeys({ addressLookupTableAccounts: tables }); } catch (e: any) { throw new Error(`Refusing to sign: cannot resolve transaction accounts (${e?.message ?? e}).`); }
  const staticKeys = msg.staticAccountKeys;
  if (staticKeys.length === 0 || staticKeys[0].toBase58() !== wallet) {
    throw new Error(`Refusing to sign: fee payer is ${staticKeys[0]?.toBase58() ?? "missing"}, not the local wallet.`);
  }
  const nSigners = msg.header.numRequiredSignatures;
  const allowedSigners = new Set([wallet, ...(policy.extraSigners ?? [])]);
  for (let i = 0; i < nSigners; i++) {
    if (!allowedSigners.has(staticKeys[i].toBase58())) throw new Error(`Refusing to sign: transaction requires an unexpected signer ${staticKeys[i].toBase58()}.`);
  }
  const allowed = new Set(policy.allowedPrograms);
  const dests = policy.allowedSolDestinations ? new Set(policy.allowedSolDestinations) : null;
  const createdAccounts = new Set<string>();
  const maxCreate = policy.maxCreateAccountLamports ?? 10_000_000n;
  const programs: string[] = [];
  let out = 0n;
  const walletIdx = (idx: number) => keys.get(idx)?.toBase58() === wallet;

  for (const ix of msg.compiledInstructions) {
    const prog = keys.get(ix.programIdIndex)?.toBase58();
    if (!prog) throw new Error("Refusing to sign: instruction references an unresolvable program.");
    if (!allowed.has(prog)) throw new Error(`Refusing to sign: transaction invokes a program that is not on the allowlist (${prog}).`);
    programs.push(prog);
    const acct = (n: number) => { const i = ix.accountKeyIndexes[n]; return i === undefined ? undefined : keys.get(i)?.toBase58(); };
    const data = Buffer.from(ix.data);

    if (prog === SYSTEM_PROGRAM) {
      if (data.length < 4) throw new Error("Refusing to sign: malformed System instruction.");
      const t = data.readUInt32LE(0);
      if (t === 2) { // Transfer
        if (data.length < 12) throw new Error("Refusing to sign: malformed System transfer.");
        const lamports = data.readBigUInt64LE(4);
        if (acct(0) === wallet) {
          const to = acct(1)!;
          if (dests && !dests.has(to) && !createdAccounts.has(to)) throw new Error(`Refusing to sign: System transfer of ${formatBaseUnits(lamports, 9)} SOL from the wallet to ${to}, which is not an expected destination.`);
          out += lamports;
        }
      } else if (t === 0) { // CreateAccount
        if (data.length < 52) throw new Error("Refusing to sign: malformed CreateAccount.");
        const lamports = data.readBigUInt64LE(4);
        const owner = new PublicKey(data.subarray(20, 52)).toBase58();
        if (acct(0) === wallet) {
          if (lamports > maxCreate) throw new Error(`Refusing to sign: CreateAccount funds ${formatBaseUnits(lamports, 9)} SOL from the wallet (limit ${formatBaseUnits(maxCreate, 9)}).`);
          if (!allowed.has(owner)) throw new Error(`Refusing to sign: CreateAccount assigns a new account to non-allowlisted program ${owner}.`);
          out += lamports; createdAccounts.add(acct(1)!);
        }
      } else if (t === 3) { // CreateAccountWithSeed: u32 type, base(32), seed(u64 len + bytes), lamports, space, owner
        if (data.length < 4 + 32 + 8) throw new Error("Refusing to sign: malformed CreateAccountWithSeed.");
        const seedLen = Number(data.readBigUInt64LE(36));
        const o = 44 + seedLen;
        if (seedLen > 32 || data.length < o + 48) throw new Error("Refusing to sign: malformed CreateAccountWithSeed.");
        const lamports = data.readBigUInt64LE(o);
        const owner = new PublicKey(data.subarray(o + 16, o + 48)).toBase58();
        if (acct(0) === wallet) {
          if (lamports > maxCreate) throw new Error(`Refusing to sign: CreateAccountWithSeed funds ${formatBaseUnits(lamports, 9)} SOL from the wallet (limit ${formatBaseUnits(maxCreate, 9)}).`);
          if (!allowed.has(owner)) throw new Error(`Refusing to sign: CreateAccountWithSeed assigns a new account to non-allowlisted program ${owner}.`);
          out += lamports; createdAccounts.add(acct(1)!);
        }
      } else if (t === 8 || t === 9) { // Allocate / AllocateWithSeed: harmless unless the target is the wallet
        if (acct(0) === wallet) throw new Error("Refusing to sign: System Allocate on the wallet account.");
      } else {
        // Assign, TransferWithSeed, nonce ops (AdvanceNonce/Withdraw/Authorize/...), etc.
        throw new Error(`Refusing to sign: System instruction type ${t} (Assign/TransferWithSeed/nonce/other) is not permitted.`);
      }
    } else if (prog === TOKEN_PROGRAM || prog === TOKEN_2022_PROGRAM) {
      const t = data[0];
      if (t === 9) { // CloseAccount: lamports go to accounts[1]; only allowed back to the wallet
        if (acct(1) !== wallet) throw new Error(`Refusing to sign: token CloseAccount sends the account's lamports to ${acct(1)}, not the wallet.`);
      } else if (t === 16 || t === 18) { // InitializeAccount2/3: owner is in data
        if (data.length < 33 || new PublicKey(data.subarray(1, 33)).toBase58() !== wallet) throw new Error("Refusing to sign: token account is initialised with an owner other than the wallet.");
      } else if (t === 1) { // InitializeAccount: owner = accounts[2]
        if (acct(2) !== wallet) throw new Error("Refusing to sign: token account is initialised with an owner other than the wallet.");
      } else if (t === 17 || t === 21 || t === 22 || t === 14) {
        // SyncNative, GetAccountDataSize, InitializeImmutableOwner, Revoke: harmless
      } else {
        throw new Error(`Refusing to sign: token instruction type ${t} (Transfer/Approve/SetAuthority/Burn/extension/...) is not permitted at top level.`);
      }
    } else if (prog === ATA_PROGRAM) {
      const t = data.length === 0 ? 0 : data[0];
      if (t === 0 || t === 1) {
        if (!policy.allowAtaAnyOwner && acct(2) !== wallet) throw new Error(`Refusing to sign: associated token account is created for owner ${acct(2)}, not the wallet.`);
      } else {
        throw new Error(`Refusing to sign: associated-token instruction type ${t} is not permitted.`);
      }
    }
    // Jupiter / pump / metaplex / compute-budget / memo: program-level allowlist only. Their
    // effect on the wallet is bounded by the simulation check performed by the caller.
  }
  if (out > policy.maxLamportsOut) {
    throw new Error(`Refusing to sign: transaction moves ${formatBaseUnits(out, 9)} SOL out of the wallet via System instructions; the limit for this operation is ${formatBaseUnits(policy.maxLamportsOut, 9)} SOL.`);
  }
  void walletIdx;
  return { lamportsOut: out, programs };
}

export interface SimAccountState { lamports: bigint; tokenAmount?: bigint }

function parseAccountState(a: any): SimAccountState | null {
  if (!a) return null;
  const st: SimAccountState = { lamports: BigInt(a.lamports ?? 0) };
  const b64 = Array.isArray(a.data) ? a.data[0] : undefined;
  if (b64) {
    const buf = Buffer.from(b64, "base64");
    if (buf.length >= 72 && (a.owner === TOKEN_PROGRAM || a.owner === TOKEN_2022_PROGRAM)) st.tokenAmount = buf.readBigUInt64LE(64);
  }
  return st;
}

export async function simulateTx(tx: VersionedTransaction, accounts?: string[]): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number; accounts?: any[] | null }> {
  const cfg: Record<string, unknown> = { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" };
  if (accounts?.length) cfg.accounts = { encoding: "base64", addresses: accounts };
  const r = await rpc("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), cfg]);
  return { err: r?.value?.err ?? null, logs: r?.value?.logs ?? null, unitsConsumed: r?.value?.unitsConsumed, accounts: r?.value?.accounts ?? null };
}

async function readAccountStates(addresses: string[]): Promise<Array<SimAccountState | null>> {
  const r = await rpc("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
  const vals: any[] = r?.value ?? [];
  if (vals.length !== addresses.length) throw new Error("Could not read pre-transaction account state.");
  return vals.map(parseAccountState);
}

export interface SimulationGuard {
  wallet: PublicKey;
  /** Max SOL (lamports) the wallet balance may DROP by (including fees and rent). */
  maxSolDecrease: bigint;
  /** Optional min SOL increase (e.g. SOL output). */
  minSolIncrease?: bigint;
  /** Token accounts to watch: inputs may drop by at most maxDecrease; outputs must rise by at least minIncrease. */
  tokens?: Array<{ mint: string; maxDecrease?: bigint; minIncrease?: bigint }>;
}

/** Simulate the (unsigned) tx and assert that the wallet's balances change only within bounds. */
export async function simulateAndAssert(tx: VersionedTransaction, g: SimulationGuard): Promise<void> {
  const wallet = g.wallet.toBase58();
  const watch: string[] = [wallet];
  const meta: Array<{ idx: number; spec: NonNullable<SimulationGuard["tokens"]>[number] }> = [];
  for (const spec of g.tokens ?? []) {
    const mintPk = new PublicKey(spec.mint);
    for (const prog of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      watch.push(deriveAta(g.wallet, mintPk, new PublicKey(prog)).toBase58());
      meta.push({ idx: watch.length - 1, spec });
    }
  }
  const pre = await readAccountStates(watch);
  const sim = await simulateTx(tx, watch);
  if (sim.err) throw new Error(`Refusing to sign: simulation failed (${JSON.stringify(sim.err)}).`);
  if (!sim.accounts || sim.accounts.length !== watch.length) throw new Error("Refusing to sign: simulation did not return post-state for the wallet.");
  const post = sim.accounts.map(parseAccountState);
  const preSol = pre[0]?.lamports ?? 0n;
  const postSol = post[0]?.lamports ?? 0n;
  const decrease = preSol - postSol;
  if (decrease > g.maxSolDecrease) {
    throw new Error(`Refusing to sign: simulation shows the wallet's SOL balance dropping by ${formatBaseUnits(decrease, 9)} SOL; the limit for this operation is ${formatBaseUnits(g.maxSolDecrease, 9)} SOL.`);
  }
  if (g.minSolIncrease !== undefined && postSol - preSol < g.minSolIncrease) {
    throw new Error(`Refusing to sign: simulation shows the wallet receiving only ${formatBaseUnits(postSol - preSol > 0n ? postSol - preSol : 0n, 9)} SOL, less than the quoted minimum ${formatBaseUnits(g.minSolIncrease, 9)} SOL.`);
  }
  // Per spec entry: aggregate over both token programs (only one will exist).
  const bySpec = new Map<object, { dpre: bigint; dpost: bigint }>();
  for (const m of meta) {
    const e = bySpec.get(m.spec) ?? { dpre: 0n, dpost: 0n };
    e.dpre += pre[m.idx]?.tokenAmount ?? 0n;
    e.dpost += post[m.idx]?.tokenAmount ?? 0n;
    bySpec.set(m.spec, e);
  }
  for (const [spec, e] of bySpec as Map<any, { dpre: bigint; dpost: bigint }>) {
    if (spec.maxDecrease !== undefined && e.dpre - e.dpost > spec.maxDecrease) throw new Error(`Refusing to sign: simulation shows token ${spec.mint} leaving the wallet beyond the swap input.`);
    if (spec.minIncrease !== undefined && e.dpost - e.dpre < spec.minIncrease) throw new Error(`Refusing to sign: simulation shows the wallet receiving less ${spec.mint} than the quoted minimum.`);
  }
}

/** Ask Jupiter for the unsigned swap tx for a given quote and payer. */
export async function buildSwapTx(quote: any, userPublicKey: string): Promise<VersionedTransaction> {
  const body = await getJson(JUP_SWAP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey, dynamicComputeUnitLimit: true }),
  }, 2);
  if (!body?.swapTransaction) throw new Error("Jupiter returned no swapTransaction.");
  return VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
}

/** Verify (static + lookup tables + simulation) a Jupiter swap tx for `q`. Throws on anything suspicious. */
export async function verifyJupiterSwapTx(tx: VersionedTransaction, wallet: PublicKey, q: SolQuote): Promise<void> {
  const inIsSol = q.inputMint === SOL_MINT;
  const outIsSol = q.outputMint === SOL_MINT;
  const wsolAtas = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => deriveAta(wallet, new PublicKey(SOL_MINT), new PublicKey(p)).toBase58());
  const maxOut = (inIsSol ? q.inAmountRaw : 0n) + SWAP_SOL_RESERVE_LAMPORTS;
  await assertSafeTx(tx, { wallet, allowedPrograms: JUPITER_ALLOWED_PROGRAMS, maxLamportsOut: maxOut, allowedSolDestinations: wsolAtas });
  const tokens: NonNullable<SimulationGuard["tokens"]> = [];
  if (!inIsSol) tokens.push({ mint: q.inputMint, maxDecrease: q.inAmountRaw });
  if (!outIsSol) tokens.push({ mint: q.outputMint, minIncrease: q.minOutRaw });
  await simulateAndAssert(tx, {
    wallet,
    maxSolDecrease: (inIsSol ? q.inAmountRaw : 0n) + SWAP_SOL_RESERVE_LAMPORTS,
    ...(outIsSol ? { minSolIncrease: q.minOutRaw - SWAP_SOL_RESERVE_LAMPORTS } : {}),
    tokens,
  });
}

export async function sendAndConfirm(tx: VersionedTransaction): Promise<string> {
  const sig: string = await rpc("sendTransaction", [
    Buffer.from(tx.serialize()).toString("base64"),
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
  ]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const st = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
    const s = st?.value?.[0];
    if (s) {
      if (s.err) throw new Error(`Transaction ${sig} failed on-chain: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return sig;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Transaction ${sig} was sent but not confirmed within 60s. Check https://solscan.io/tx/${sig} before retrying (do NOT blindly resend).`);
}

// ── Balances ─────────────────────────────────────────────────────────────────
async function getSolLamports(address: string): Promise<bigint> {
  const r = await rpc("getBalance", [address, { commitment: "confirmed" }]);
  return BigInt(r?.value ?? 0);
}

async function getTokenBalances(owner: string): Promise<Array<{ mint: string; amount: string; decimals: number; program: string; symbol?: string }>> {
  const out: Array<{ mint: string; amount: string; decimals: number; program: string; symbol?: string }> = [];
  for (const [label, programId] of [["Token", TOKEN_PROGRAM], ["Token-2022", TOKEN_2022_PROGRAM]] as const) {
    const r = await rpc("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    for (const acc of r?.value ?? []) {
      const info = acc?.account?.data?.parsed?.info;
      const ta = info?.tokenAmount;
      if (!info || !ta || ta.amount === "0") continue;
      const sym = info.mint === SOL_MINT ? "wSOL" : Object.entries(KNOWN_MINTS).find(([, v]) => v.mint === info.mint)?.[0];
      out.push({ mint: info.mint, amount: formatBaseUnits(ta.amount, ta.decimals), decimals: ta.decimals, program: label, ...(sym ? { symbol: sym } : {}) });
    }
  }
  return out;
}

// ── SPL helpers (hand-rolled, no @solana/spl-token) ──────────────────────────
function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], new PublicKey(ATA_PROGRAM))[0];
}

export function createAtaIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ATA_PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function transferCheckedIx(source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number, tokenProgram: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function token2022Extensions(mintInfo: any): string[] {
  const exts = mintInfo?.value?.data?.parsed?.info?.extensions;
  return Array.isArray(exts) ? exts.map((e: any) => String(e?.extension ?? "")).filter(Boolean) : [];
}

async function buildTransfer(from: PublicKey, to: PublicKey, amountHuman: string, mint?: string, allowToken2022Extensions = false): Promise<{ tx: VersionedTransaction; summary: string; amountRaw: bigint; decimals: number; kind: "SOL" | "SPL"; mint?: string; warnings: string[] }> {
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  let ixs: TransactionInstruction[];
  let decimals = 9;
  let kind: "SOL" | "SPL" = "SOL";
  let amountRaw: bigint;
  const warnings: string[] = [];
  const resolved = mint ? resolveMint(mint) : { mint: SOL_MINT, decimals: 9 };
  if (resolved.mint === SOL_MINT) {
    amountRaw = parseHumanToBaseUnits(amountHuman, 9);
    ixs = [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: amountRaw })];
  } else {
    kind = "SPL";
    const mintPk = new PublicKey(resolved.mint);
    const mintInfo = await rpc("getAccountInfo", [resolved.mint, { encoding: "jsonParsed" }]);
    const owner: string | undefined = mintInfo?.value?.owner;
    if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) throw new Error(`${resolved.mint} is not an SPL token mint.`);
    decimals = mintInfo.value.data?.parsed?.info?.decimals;
    if (typeof decimals !== "number") throw new Error("Could not read mint decimals.");
    if (owner === TOKEN_2022_PROGRAM) {
      const risky = token2022Extensions(mintInfo).filter((e) => /^transferFee|^transferHook/i.test(e));
      if (risky.length) {
        if (!allowToken2022Extensions) throw new Error(`Mint ${resolved.mint} is a Token-2022 mint with ${risky.join(", ")}: the recipient may receive less than sent, or the transfer may call arbitrary hook programs. Refusing. Pass allowToken2022Extensions:true to proceed anyway.`);
        warnings.push(`Token-2022 extensions present: ${risky.join(", ")} (recipient may receive less than the amount sent)`);
      }
    }
    amountRaw = parseHumanToBaseUnits(amountHuman, decimals);
    const prog = new PublicKey(owner);
    const src = deriveAta(from, mintPk, prog);
    const dst = deriveAta(to, mintPk, prog);
    let have = 0n;
    try {
      const bal = await rpc("getTokenAccountBalance", [src.toBase58(), { commitment: "confirmed" }]);
      have = BigInt(bal?.value?.amount ?? "0");
    } catch (e: any) {
      // A missing token account is a genuine zero balance; any other error must surface.
      if (!/could not find account|invalid param/i.test(String(e?.message))) throw e;
    }
    if (have < amountRaw) throw new Error(`Insufficient token balance: have ${formatBaseUnits(have, decimals)}, need ${formatBaseUnits(amountRaw, decimals)}.`);
    ixs = [createAtaIdempotentIx(from, dst, to, mintPk, prog), transferCheckedIx(src, mintPk, dst, from, amountRaw, decimals, prog)];
  }
  const msg = new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return {
    tx: new VersionedTransaction(msg),
    summary: `${formatBaseUnits(amountRaw, decimals)} ${kind === "SOL" ? "SOL" : resolved.mint} → ${to.toBase58()}`,
    amountRaw, decimals, kind, mint: kind === "SPL" ? resolved.mint : undefined, warnings,
  };
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const CONFIRM_PROP = { type: "boolean", description: "Must be true to actually send. Without it only an estimate is returned and nothing is signed or sent." };

export const SOLANA_TOOLS: Tool[] = [
  {
    name: "sol_wallet",
    description:
      "Get the public address of your local Solana wallet (ed25519 keypair stored encrypted at ~/.finch/solana-wallet.json, mode 600). " +
      "Creates it on first use and says so. The secret key is never returned. Fund this address with SOL to use sol_swap/sol_send/sol_launch_token.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "sol_balance",
    description:
      "SOL balance plus all SPL token balances (Token and Token-2022 programs) for an address. Defaults to the local Solana wallet. " +
      "RPC: FINCH_SOLANA_RPC_URL (default public mainnet-beta).",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Solana address (default: local wallet)" } }, required: [] },
  },
  {
    name: "sol_token_info",
    description: "Token info for a Solana mint: name, symbol, decimals, price, liquidity, market cap (Jupiter) plus top DEX pair (DexScreener). Accepts SOL/USDC/USDT/FINCH or a mint address.",
    inputSchema: { type: "object", properties: { mint: { type: "string", description: "Mint address or symbol (SOL, USDC, USDT, FINCH)" } }, required: ["mint"] },
  },
  {
    name: "sol_quote",
    description:
      "Jupiter swap quote on Solana (no signing, no funds moved). amount is a HUMAN decimal string (e.g. \"0.5\" SOL). " +
      "Symbols SOL/USDC/USDT/FINCH resolve to mints. Returns out amount, min received, price impact and route.",
    inputSchema: {
      type: "object",
      properties: {
        inputMint: { type: "string", description: "Input mint or symbol" },
        outputMint: { type: "string", description: "Output mint or symbol" },
        amount: { type: "string", description: "Human amount of the input token, e.g. \"0.5\"" },
        slippageBps: { type: "number", description: `Slippage in bps (default ${DEFAULT_SLIPPAGE_BPS}, max ${DEFAULT_MAX_SLIPPAGE_BPS}; up to ${MAX_SLIPPAGE_BPS} only with allowHighSlippage)` },
        allowHighSlippage: { type: "boolean", description: `Allow slippageBps above ${DEFAULT_MAX_SLIPPAGE_BPS} (hard max ${MAX_SLIPPAGE_BPS}). Only if the user explicitly asked.` },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },
  {
    name: "sol_swap",
    description:
      "CAUTION: swap tokens on Solana via Jupiter using the local Solana wallet. Real funds. Disabled unless the operator sets FINCH_SOL_ALLOW_SPEND=1. Without confirmed=true (and the quoteId from the preview) it returns only the estimate and sends nothing. The swap transaction is verified (program allowlist, lookup tables resolved, simulation) before signing. " +
      `Rejects price impact above ${MAX_PRICE_IMPACT_PCT}%. Requires an existing local wallet (see sol_wallet). Show the user the estimate before confirming.`,
    inputSchema: {
      type: "object",
      properties: {
        inputMint: { type: "string" }, outputMint: { type: "string" },
        amount: { type: "string", description: "Human amount of input token" },
        slippageBps: { type: "number" },
        allowHighSlippage: { type: "boolean", description: `Allow slippageBps above ${DEFAULT_MAX_SLIPPAGE_BPS} (hard max ${MAX_SLIPPAGE_BPS}). Only if the user explicitly asked.` },
        quoteId: { type: "string", description: "quoteId from the preview. Required with confirmed=true; a confirmed call without the matching quoteId executes nothing and returns the preview." },
        confirmed: CONFIRM_PROP,
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },
  {
    name: "sol_send",
    description:
      "CAUTION: send SOL or an SPL token (Token or Token-2022) from the local Solana wallet. Real funds, irreversible. " +
      "Disabled unless the operator sets FINCH_SOL_ALLOW_SPEND=1; SOL amount capped by FINCH_SOL_MAX_SEND_SOL (default 1). Without confirmed=true returns a preview only. Omit mint for SOL.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient Solana address" },
        amount: { type: "string", description: "Human amount, e.g. \"0.1\"" },
        mint: { type: "string", description: "SPL mint or symbol (omit for SOL)" },
        allowToken2022Extensions: { type: "boolean", description: "Allow Token-2022 mints with transfer-fee/transfer-hook extensions (recipient may get less)." },
        confirmed: CONFIRM_PROP,
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "sol_launch_token",
    description:
      "LEGACY / NOT THE FINCH LAUNCHPAD: this launches on pump.fun (a third-party launchpad via pumpportal) from the local Solana wallet. A token launched this way has no Finch AI founder, no fee split and does not appear on the Finch launchpad. To launch on Finch (Meteora pool, AI founder funded 90% by trading fees) use launchpad_launch_token with chain=\"solana\". CAUTION: real funds, optional dev buy. Disabled unless the operator sets FINCH_SOL_ALLOW_SPEND=1; devBuySol also capped by FINCH_SOL_MAX_SEND_SOL (default 1). " +
      `Uploads image+metadata to pump.fun IPFS, then signs with a fresh mint keypair and the local wallet. Without confirmed=true returns a preview only. Needs balance >= devBuySol + 0.03 SOL; devBuySol max ${MAX_DEV_BUY_SOL}.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Token name (max 32 chars)" },
        symbol: { type: "string", description: "Ticker (max 10 chars)" },
        description: { type: "string", description: `Max ${MAX_DESCRIPTION_CHARS} characters` },
        imageUrl: { type: "string", description: "https URL of the token image (max 5 MB)" },
        devBuySol: { type: "string", description: "SOL to spend buying at launch (default \"0\")" },
        confirmed: CONFIRM_PROP,
      },
      required: ["name", "symbol", "description", "imageUrl"],
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────────────
function argsObj(args: unknown): Record<string, any> { return (args && typeof args === "object" ? args : {}) as Record<string, any>; }
function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required field: ${field}`);
  return v.trim();
}

async function handleBalance(a: Record<string, any>): Promise<ToolResult> {
  let address: string;
  if (a.address) {
    address = str(a.address, "address");
    if (!isValidPubkey(address)) throw new Error("Invalid Solana address.");
  } else {
    const w = loadSolanaKeypair(false);
    if (!w) throw new Error("No address given and no local Solana wallet exists. Pass address, or run sol_wallet.");
    address = w.keypair.publicKey.toBase58();
  }
  const [lamports, tokens] = await Promise.all([getSolLamports(address), getTokenBalances(address)]);
  const sol = formatBaseUnits(lamports, 9);
  const lines = [`**Solana balance** \`${address}\``, "", `SOL: ${sol}`, ""];
  const MAX_TEXT = 50;
  if (tokens.length === 0) lines.push("No SPL token balances.");
  else for (const t of tokens.slice(0, MAX_TEXT)) lines.push(`- ${t.symbol ?? t.mint}: ${t.amount}  (${t.program}${t.symbol ? `, ${t.mint}` : ""})`);
  if (tokens.length > MAX_TEXT) lines.push(`… and ${tokens.length - MAX_TEXT} more token accounts (see structuredContent.tokens, capped at 500).`);
  return ok(lines.join("\n"), { address, sol, tokenCount: tokens.length, tokens: tokens.slice(0, 500) });
}

async function handleTokenInfo(a: Record<string, any>): Promise<ToolResult> {
  const { mint } = resolveMint(str(a.mint, "mint"));
  const [jup, dex] = await Promise.allSettled([
    getJson(`${JUP_TOKENS}?query=${encodeURIComponent(mint)}`, undefined, 2),
    getJson(`${DEXSCREENER}/${encodeURIComponent(mint)}`, undefined, 2),
  ]);
  const j = jup.status === "fulfilled" && Array.isArray(jup.value) ? jup.value.find((t: any) => t.id === mint) : undefined;
  const pairs: any[] = dex.status === "fulfilled" ? (dex.value?.pairs ?? []).filter((p: any) => p.chainId === "solana") : [];
  pairs.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0));
  const p = pairs[0];
  if (!j && !p) throw new Error(`No data found for mint ${mint} on Jupiter or DexScreener.`);
  const info = {
    mint,
    name: j?.name ?? p?.baseToken?.name ?? null,
    symbol: j?.symbol ?? p?.baseToken?.symbol ?? null,
    decimals: j?.decimals ?? null,
    priceUsd: j?.usdPrice ?? (p?.priceUsd ? Number(p.priceUsd) : null),
    liquidityUsd: j?.liquidity ?? p?.liquidity?.usd ?? null,
    marketCapUsd: j?.mcap ?? p?.marketCap ?? null,
    fdvUsd: j?.fdv ?? p?.fdv ?? null,
    holders: j?.holderCount ?? null,
    verified: j?.isVerified ?? null,
    launchpad: j?.launchpad ?? null,
    topPair: p ? { dex: p.dexId, pair: p.pairAddress, url: p.url, volume24hUsd: p.volume?.h24 ?? null, priceChange24hPct: p.priceChange?.h24 ?? null } : null,
  };
  const f = (v: unknown) => (v === null || v === undefined ? "n/a" : String(v));
  return ok(
    [
      `**${f(info.name)} (${f(info.symbol)})** \`${mint}\``,
      `Decimals: ${f(info.decimals)} · Price: $${f(info.priceUsd)} · Liquidity: $${f(info.liquidityUsd)} · MCap: $${f(info.marketCapUsd)}`,
      `Holders: ${f(info.holders)} · Verified: ${f(info.verified)} · Launchpad: ${f(info.launchpad)}`,
      info.topPair ? `Top pair: ${info.topPair.dex} ${info.topPair.url} · 24h vol $${f(info.topPair.volume24hUsd)} · 24h ${f(info.topPair.priceChange24hPct)}%` : "No DEX pair found.",
    ].join("\n"),
    info,
  );
}

async function handleQuote(a: Record<string, any>): Promise<ToolResult> {
  const q = await fetchSolQuote({ inputMint: str(a.inputMint, "inputMint"), outputMint: str(a.outputMint, "outputMint"), amount: String(a.amount ?? ""), slippageBps: a.slippageBps, allowHighSlippage: a.allowHighSlippage === true });
  return ok(`**Jupiter quote**\n${describeQuote(q)}`, quoteStructured(q));
}

function spendDisabledNote(): string {
  return spendEnabled() ? "" : "\n\nNOTE: spending is disabled (FINCH_SOL_ALLOW_SPEND is not 1); a confirmed call will be refused until the operator enables it.";
}

async function assertSolReserve(address: string, needLamports: bigint, what: string): Promise<bigint> {
  const have = await getSolLamports(address); // errors surface; never read as zero
  if (have < needLamports) throw new Error(`Insufficient SOL for ${what}: have ${formatBaseUnits(have, 9)}, need at least ${formatBaseUnits(needLamports, 9)}.`);
  return have;
}

/** Input value of a swap in lamports (for the per-call cap). */
async function swapValueLamports(q: SolQuote): Promise<bigint> {
  if (q.inputMint === SOL_MINT) return q.inAmountRaw;
  if (q.outputMint === SOL_MINT) return q.outAmountRaw; // best estimate of what the input is worth
  const probe = await fetchSolQuote({ inputMint: q.inputMint, outputMint: SOL_MINT, amount: formatBaseUnits(q.inAmountRaw, q.inDecimals), slippageBps: q.slippageBps });
  return probe.outAmountRaw;
}

async function handleSwap(a: Record<string, any>): Promise<ToolResult> {
  const q = await fetchSolQuote({ inputMint: str(a.inputMint, "inputMint"), outputMint: str(a.outputMint, "outputMint"), amount: String(a.amount ?? ""), slippageBps: a.slippageBps, allowHighSlippage: a.allowHighSlippage === true });
  const structured = quoteStructured(q);
  if (q.priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    return { content: [{ type: "text", text: `⛔ REJECTED: price impact ${q.priceImpactPct.toFixed(2)}% exceeds the ${MAX_PRICE_IMPACT_PCT}% limit. Reduce the amount or pick a deeper pool.\n\n${describeQuote(q)}` }], structuredContent: { executed: false, rejected: "price_impact", ...structured }, isError: true };
  }
  const id = rememberQuote(q);
  const prev = previewedQuotes.get(typeof a.quoteId === "string" ? a.quoteId : "");
  const matches = !!prev && prev.q.inputMint === q.inputMint && prev.q.outputMint === q.outputMint && prev.q.inAmountRaw === q.inAmountRaw && prev.q.slippageBps === q.slippageBps && quoteIdOf(prev.q) === a.quoteId;
  if (a.confirmed !== true || !matches) {
    const why = a.confirmed === true ? "\n\n(confirmed=true was ignored: no matching quoteId from a preview of THESE parameters. Show the user this preview, then call again with confirmed=true and quoteId=" + id + ".)" : "";
    return blocked(describeQuote(q) + why + spendDisabledNote(), { ...structured, quoteId: id });
  }
  // From here on: confirmed, bound to a previewed quote.
  assertSpendAllowed("sol_swap");
  const drift = (prev!.q.minOutRaw * BigInt(10_000 - MAX_QUOTE_DRIFT_BPS)) / 10_000n;
  if (q.minOutRaw < drift) {
    throw new Error(`Quote moved: minimum received is now ${formatBaseUnits(q.minOutRaw, q.outDecimals)}, more than ${MAX_QUOTE_DRIFT_BPS / 100}% worse than the previewed ${formatBaseUnits(prev!.q.minOutRaw, q.outDecimals)}. Nothing was sent; request a new preview.`);
  }
  const value = await swapValueLamports(q);
  if (value > maxSwapLamports()) throw new Error(`Swap value ~${formatBaseUnits(value, 9)} SOL exceeds FINCH_SOL_MAX_SWAP_SOL (${formatBaseUnits(maxSwapLamports(), 9)}). Nothing was sent.`);
  const kp = requireWallet();
  const need = (q.inputMint === SOL_MINT ? q.inAmountRaw : 0n) + SWAP_SOL_RESERVE_LAMPORTS;
  await assertSolReserve(kp.publicKey.toBase58(), need, "this swap (input + 0.01 SOL fee/rent reserve)");
  const tx = await buildSwapTx(q.raw, kp.publicKey.toBase58());
  await verifyJupiterSwapTx(tx, kp.publicKey, q);
  tx.sign([kp]);
  const sig = await sendAndConfirm(tx);
  return ok(`✅ Swap confirmed.\n${describeQuote(q)}\nSignature: ${sig}\nhttps://solscan.io/tx/${sig}`, { executed: true, signature: sig, ...structured });
}

async function handleSend(a: Record<string, any>): Promise<ToolResult> {
  const to = str(a.to, "to");
  if (!isValidPubkey(to)) throw new Error("Invalid recipient address.");
  const w = loadSolanaKeypair(false);
  if (!w) throw new Error("No local Solana wallet exists. Run sol_wallet first.");
  const from = w.keypair.publicKey;
  const built = await buildTransfer(from, new PublicKey(to), String(a.amount ?? ""), a.mint ? String(a.mint) : undefined, a.allowToken2022Extensions === true);
  const have = await getSolLamports(from.toBase58());
  if (built.kind === "SOL") {
    if (built.amountRaw > maxSendLamports()) throw new Error(`Amount ${formatBaseUnits(built.amountRaw, 9)} SOL exceeds FINCH_SOL_MAX_SEND_SOL (${formatBaseUnits(maxSendLamports(), 9)}).`);
    if (have < built.amountRaw + 5_000n) throw new Error(`Insufficient SOL: have ${formatBaseUnits(have, 9)}, need ${formatBaseUnits(built.amountRaw, 9)} plus fees.`);
    const left = have - built.amountRaw - 5_000n;
    if (left > 0n && left < SYSTEM_MIN_RENT_LAMPORTS) throw new Error(`This send would leave ${formatBaseUnits(left, 9)} SOL, below the rent-exempt minimum (${formatBaseUnits(SYSTEM_MIN_RENT_LAMPORTS, 9)}), and fail on-chain. Send a smaller amount or the whole balance minus fees.`);
    if (built.amountRaw < SYSTEM_MIN_RENT_LAMPORTS && (await getSolLamports(to)) === 0n) throw new Error(`Recipient account does not exist yet; the first transfer must be at least ${formatBaseUnits(SYSTEM_MIN_RENT_LAMPORTS, 9)} SOL (rent-exempt minimum).`);
  } else if (have < ATA_RENT_LAMPORTS + 10_000n) {
    throw new Error(`Insufficient SOL for fees and recipient token-account rent: have ${formatBaseUnits(have, 9)}, need about ${formatBaseUnits(ATA_RENT_LAMPORTS + 10_000n, 9)}.`);
  }
  const structured = { from: from.toBase58(), to, amount: formatBaseUnits(built.amountRaw, built.decimals), asset: built.kind === "SOL" ? "SOL" : built.mint, warnings: built.warnings };
  const extra = (built.kind === "SPL" ? `\nCost: network fee plus up to ~${formatBaseUnits(ATA_RENT_LAMPORTS, 9)} SOL rent if the recipient token account must be created.` : "") + built.warnings.map((x) => `\n⚠ ${x}`).join("");
  if (a.confirmed !== true) return blocked(`Send ${built.summary}\nFrom: ${from.toBase58()}${extra}${spendDisabledNote()}`, structured);
  assertSpendAllowed("sol_send");
  built.tx.sign([w.keypair]);
  const sig = await sendAndConfirm(built.tx);
  return ok(`✅ Sent ${built.summary}\nSignature: ${sig}\nhttps://solscan.io/tx/${sig}`, { executed: true, signature: sig, ...structured });
}

// ── SSRF-safe image fetch ────────────────────────────────────────────────────
export function isBlockedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && ip.startsWith("192.0.0.")) || (a === 198 && (b === 18 || b === 19));
  }
  if (fam === 6) {
    const l = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    const mapped = l.match(/^(?:0*:)+ffff:(\d+\.\d+\.\d+\.\d+)$/) ;
    if (mapped) return isBlockedIp(mapped[1]);
    const mappedHex = l.match(/^(?:0*:)+ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) { const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16); return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    if (l === "::" || l === "::1") return true;
    const first = parseInt(l.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true; // not an IP: refuse
}

async function assertPublicHost(u: URL): Promise<void> {
  if (u.protocol !== "https:") throw new Error("imageUrl must be https.");
  if (u.username || u.password) throw new Error("imageUrl must not contain credentials.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("imageUrl has no host.");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`imageUrl points to a private/internal address (${host}).`);
    return;
  }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error("imageUrl host is internal.");
  let addrs: Array<{ address: string }>;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch { throw new Error(`imageUrl host ${host} could not be resolved.`); }
  if (!addrs.length) throw new Error(`imageUrl host ${host} did not resolve.`);
  for (const ad of addrs) if (isBlockedIp(ad.address)) throw new Error(`imageUrl host ${host} resolves to a private/internal address; refusing.`);
}

function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export async function fetchImage(url: string): Promise<{ bytes: Buffer; type: string }> {
  let current = new URL(url);
  let res: Response | undefined;
  for (let hop = 0; ; hop++) {
    await assertPublicHost(current);
    res = await fetch(current.toString(), { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (!loc) throw new Error(`Image fetch failed: redirect without Location (HTTP ${res.status}).`);
      if (hop >= MAX_IMAGE_REDIRECTS) throw new Error(`imageUrl redirected more than ${MAX_IMAGE_REDIRECTS} times.`);
      current = new URL(loc, current);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
  const cl = res.headers.get("content-length");
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > MAX_IMAGE_BYTES)) throw new Error(`Image too large (content-length ${cl}; max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error(`Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`); }
      chunks.push(Buffer.from(value));
    }
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new Error("Image body is empty.");
  const type = sniffImage(bytes);
  if (!type) throw new Error("imageUrl is not a PNG, JPEG, GIF or WEBP image (magic bytes mismatch).");
  return { bytes, type };
}

const METADATA_HOSTS = [/^ipfs\.io$/, /\.ipfs\.io$/, /^cf-ipfs\.com$/, /^gateway\.pinata\.cloud$/, /^pump\.fun$/, /\.pump\.fun$/];
export function assertMetadataUri(uri: unknown): string {
  if (typeof uri !== "string") throw new Error("pump.fun IPFS upload returned no metadataUri.");
  let u: URL;
  try { u = new URL(uri); } catch { throw new Error("pump.fun returned an invalid metadataUri; refusing."); }
  if (u.protocol !== "https:" || u.username || u.password || !METADATA_HOSTS.some((r) => r.test(u.hostname.toLowerCase()))) {
    throw new Error(`pump.fun returned a metadataUri on an unexpected host (${u.protocol}//${u.hostname}); refusing.`);
  }
  if (uri.length > 300) throw new Error("metadataUri too long; refusing.");
  return uri;
}

async function handleLaunch(a: Record<string, any>): Promise<ToolResult> {
  const name = str(a.name, "name");
  const symbol = str(a.symbol, "symbol");
  const description = str(a.description, "description");
  const imageUrl = str(a.imageUrl, "imageUrl");
  if (name.length > 32) throw new Error("name max 32 characters.");
  if (symbol.length > 10) throw new Error("symbol max 10 characters.");
  if (description.length > MAX_DESCRIPTION_CHARS) throw new Error(`description max ${MAX_DESCRIPTION_CHARS} characters.`);
  const devBuyStr = a.devBuySol === undefined || a.devBuySol === null || String(a.devBuySol) === "" ? "0" : String(a.devBuySol);
  const devBuyLamports = devBuyStr === "0" ? 0n : parseHumanToBaseUnits(devBuyStr, 9);
  if (devBuyLamports > BigInt(MAX_DEV_BUY_SOL) * BigInt(LAMPORTS_PER_SOL)) throw new Error(`devBuySol max ${MAX_DEV_BUY_SOL} SOL.`);
  if (devBuyLamports > maxSendLamports()) throw new Error(`devBuySol ${formatBaseUnits(devBuyLamports, 9)} exceeds FINCH_SOL_MAX_SEND_SOL (${formatBaseUnits(maxSendLamports(), 9)}).`);
  await assertPublicHost(new URL(imageUrl)); // fail early on obviously bad URLs (also re-checked on every fetch hop)
  const w = loadSolanaKeypair(false);
  if (!w) throw new Error("No local Solana wallet exists. Run sol_wallet first and fund it.");
  const payer = w.keypair.publicKey.toBase58();
  const have = await getSolLamports(payer);
  const need = devBuyLamports + MIN_LAUNCH_BUFFER_LAMPORTS;
  if (have < need) throw new Error(`Insufficient SOL: have ${formatBaseUnits(have, 9)}, need at least ${formatBaseUnits(need, 9)} (devBuy + 0.03 SOL fees/rent).`);
  const structured = { name, symbol, imageUrl, devBuySol: formatBaseUnits(devBuyLamports, 9), payer };
  if (a.confirmed !== true) {
    // User-supplied strings are printed JSON-quoted: they are data, not instructions.
    return blocked(`Launch on pump.fun:\nName: ${JSON.stringify(name)}\nSymbol: ${JSON.stringify(symbol)}\nDescription: ${JSON.stringify(description)}\nImage: ${JSON.stringify(imageUrl)}\nDev buy: ${formatBaseUnits(devBuyLamports, 9)} SOL\nCreator/payer: ${payer}${spendDisabledNote()}`, structured);
  }
  assertSpendAllowed("sol_launch_token");
  const img = await fetchImage(imageUrl);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(img.bytes)], { type: img.type }), "token-image");
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description);
  form.append("showName", "true");
  const up = await getJson(PUMP_IPFS, { method: "POST", body: form });
  const uri = assertMetadataUri(up?.metadataUri);
  const mintKp = Keypair.generate();
  const res = await fetch(PUMPPORTAL_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: payer, action: "create",
      tokenMetadata: { name, symbol, uri },
      mint: mintKp.publicKey.toBase58(),
      denominatedInSol: "true", amount: Number(formatBaseUnits(devBuyLamports, 9)),
      slippage: 10, priorityFee: 0.0005, pool: "pump",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`pumpportal trade-local HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  await verifyPumpCreateTx(tx, w.keypair.publicKey, mintKp.publicKey, devBuyLamports);
  tx.sign([mintKp, w.keypair]);
  const sig = await sendAndConfirm(tx);
  const mint = mintKp.publicKey.toBase58();
  return ok(`✅ Token launched on pump.fun.\nMint: ${mint}\nMetadata: ${uri}\nSignature: ${sig}\nhttps://pump.fun/coin/${mint}`, { executed: true, mint, signature: sig, metadataUri: uri, ...structured });
}

/** Verify a pumpportal "create" tx: allowlisted programs, fee payer == wallet, bounded SOL out, simulation. */
export async function verifyPumpCreateTx(tx: VersionedTransaction, wallet: PublicKey, mint: PublicKey, devBuyLamports: bigint): Promise<void> {
  const limit = devBuyLamports + MIN_LAUNCH_BUFFER_LAMPORTS;
  await assertSafeTx(tx, { wallet, allowedPrograms: PUMP_ALLOWED_PROGRAMS, maxLamportsOut: limit, extraSigners: [mint.toBase58()], maxCreateAccountLamports: limit, allowAtaAnyOwner: true });
  await simulateAndAssert(tx, { wallet, maxSolDecrease: limit });
}

export async function handleSolanaTool(name: string, args: unknown): Promise<ToolResult | null> {
  const a = argsObj(args);
  try {
    switch (name) {
      case "sol_wallet": {
        const w = loadSolanaKeypair(true)!;
        const address = w.keypair.publicKey.toBase58();
        return ok(
          `**Local Solana wallet**\nAddress: \`${address}\`\n${w.created ? "Created a NEW wallet just now (encrypted at ~/.finch/solana-wallet.json, mode 600). Fund it with SOL to use it.\n" : "Loaded existing wallet.\n"}The secret key never leaves this machine and is never shown by any tool.`,
          { address, created: w.created },
        );
      }
      case "sol_balance": return await handleBalance(a);
      case "sol_token_info": return await handleTokenInfo(a);
      case "sol_quote": return await handleQuote(a);
      case "sol_swap": return await handleSwap(a);
      case "sol_send": return await handleSend(a);
      case "sol_launch_token": return await handleLaunch(a);
      default: return null;
    }
  } catch (e) {
    return fail(e);
  }
}
