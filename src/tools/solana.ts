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
import {
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
import { getMachineKey } from "../wallet.js";

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
export const MAX_SLIPPAGE_BPS = 5000;
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

function aesKey(): Buffer {
  return crypto.createHash("sha256").update("finch-solana-wallet:" + getMachineKey()).digest();
}

function encryptSecret(secret: Uint8Array): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("hex") });
}

function decryptSecret(raw: string): Uint8Array {
  const j = JSON.parse(raw);
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey(), Buffer.from(j.iv, "hex"));
  d.setAuthTag(Buffer.from(j.tag, "hex"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(j.ct, "hex")), d.final()]));
}

export function solanaWalletExists(): boolean {
  return fs.existsSync(walletFile());
}

/** Load the local keypair. Returns null if absent and create=false. */
export function loadSolanaKeypair(create: boolean): { keypair: Keypair; created: boolean } | null {
  const file = walletFile();
  if (fs.existsSync(file)) {
    try {
      return { keypair: Keypair.fromSecretKey(decryptSecret(fs.readFileSync(file, "utf8"))), created: false };
    } catch {
      // Never overwrite an existing file we cannot decrypt (would orphan funds).
      throw new Error(
        `Could not decrypt the local Solana wallet at ${file}. FINCH_WALLET_PASSPHRASE likely differs from the one used at creation. Refusing to replace it.`,
      );
    }
  }
  if (!create) return null;
  const keypair = Keypair.generate();
  if (!fs.existsSync(walletDir())) fs.mkdirSync(walletDir(), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, encryptSecret(keypair.secretKey), { mode: 0o600, flag: "wx" });
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

function parseSlippage(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_SLIPPAGE_BPS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SLIPPAGE_BPS) throw new Error(`slippageBps must be an integer between 1 and ${MAX_SLIPPAGE_BPS}.`);
  return n;
}

// ── Jupiter ──────────────────────────────────────────────────────────────────
export interface SolQuote {
  inputMint: string; outputMint: string;
  inDecimals: number; outDecimals: number;
  inAmountRaw: bigint; outAmountRaw: bigint; minOutRaw: bigint;
  priceImpactPct: number; slippageBps: number;
  routes: string[];
  raw: any;
}

export async function fetchSolQuote(args: { inputMint: string; outputMint: string; amount: string; slippageBps?: number }): Promise<SolQuote> {
  const inp = resolveMint(args.inputMint);
  const out = resolveMint(args.outputMint);
  if (inp.mint === out.mint) throw new Error("inputMint and outputMint are the same token.");
  const slippageBps = parseSlippage(args.slippageBps);
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
  // Jupiter priceImpactPct is a FRACTION string ("0.63" = 63%), verified against a 100 SOL buy
  // into a ~$19k-mcap pool. Convert to percent.
  const priceImpactPct = Number(raw.priceImpactPct ?? 0) * 100;
  if (!Number.isFinite(priceImpactPct)) throw new Error("Jupiter returned an unreadable priceImpactPct; refusing to proceed.");
  const routes = Array.from(new Set<string>((raw.routePlan ?? []).map((r: any) => r?.swapInfo?.label).filter(Boolean)));
  return {
    inputMint: inp.mint, outputMint: out.mint, inDecimals, outDecimals,
    inAmountRaw, outAmountRaw: BigInt(raw.outAmount), minOutRaw: BigInt(raw.otherAmountThreshold ?? raw.outAmount),
    priceImpactPct, slippageBps, routes, raw,
  };
}

function describeQuote(q: SolQuote): string {
  return [
    `In:  ${formatBaseUnits(q.inAmountRaw, q.inDecimals)} (${q.inputMint})`,
    `Out: ${formatBaseUnits(q.outAmountRaw, q.outDecimals)} (${q.outputMint})`,
    `Min received (slippage ${q.slippageBps} bps): ${formatBaseUnits(q.minOutRaw, q.outDecimals)}`,
    `Price impact: ${q.priceImpactPct.toFixed(4)}%`,
    `Route: ${q.routes.join(" → ") || "unknown"}`,
  ].join("\n");
}

function quoteStructured(q: SolQuote): Record<string, unknown> {
  return {
    inputMint: q.inputMint, outputMint: q.outputMint,
    inAmount: formatBaseUnits(q.inAmountRaw, q.inDecimals),
    outAmount: formatBaseUnits(q.outAmountRaw, q.outDecimals),
    minReceived: formatBaseUnits(q.minOutRaw, q.outDecimals),
    priceImpactPct: q.priceImpactPct, slippageBps: q.slippageBps, routes: q.routes,
  };
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

export async function simulateTx(tx: VersionedTransaction): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }> {
  const r = await rpc("simulateTransaction", [
    Buffer.from(tx.serialize()).toString("base64"),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  return { err: r?.value?.err ?? null, logs: r?.value?.logs ?? null, unitsConsumed: r?.value?.unitsConsumed };
}

async function sendAndConfirm(tx: VersionedTransaction): Promise<string> {
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

async function buildTransfer(from: PublicKey, to: PublicKey, amountHuman: string, mint?: string): Promise<{ tx: VersionedTransaction; summary: string; amountRaw: bigint; decimals: number; kind: "SOL" | "SPL"; mint?: string }> {
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  let ixs: TransactionInstruction[];
  let decimals = 9;
  let kind: "SOL" | "SPL" = "SOL";
  let amountRaw: bigint;
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
    amountRaw = parseHumanToBaseUnits(amountHuman, decimals);
    const prog = new PublicKey(owner);
    const src = deriveAta(from, mintPk, prog);
    const dst = deriveAta(to, mintPk, prog);
    const bal = await rpc("getTokenAccountBalance", [src.toBase58(), { commitment: "confirmed" }]).catch(() => null);
    const have = BigInt(bal?.value?.amount ?? "0");
    if (have < amountRaw) throw new Error(`Insufficient token balance: have ${formatBaseUnits(have, decimals)}, need ${formatBaseUnits(amountRaw, decimals)}.`);
    ixs = [createAtaIdempotentIx(from, dst, to, mintPk, prog), transferCheckedIx(src, mintPk, dst, from, amountRaw, decimals, prog)];
  }
  const msg = new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return {
    tx: new VersionedTransaction(msg),
    summary: `${formatBaseUnits(amountRaw, decimals)} ${kind === "SOL" ? "SOL" : resolved.mint} → ${to.toBase58()}`,
    amountRaw, decimals, kind, mint: kind === "SPL" ? resolved.mint : undefined,
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
        slippageBps: { type: "number", description: `Slippage in bps (default ${DEFAULT_SLIPPAGE_BPS}, max ${MAX_SLIPPAGE_BPS})` },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },
  {
    name: "sol_swap",
    description:
      "CAUTION: swap tokens on Solana via Jupiter using the local Solana wallet. Real funds. Without confirmed=true it returns only the estimate and sends nothing. " +
      `Rejects price impact above ${MAX_PRICE_IMPACT_PCT}%. Requires an existing local wallet (see sol_wallet). Show the user the estimate before confirming.`,
    inputSchema: {
      type: "object",
      properties: {
        inputMint: { type: "string" }, outputMint: { type: "string" },
        amount: { type: "string", description: "Human amount of input token" },
        slippageBps: { type: "number" },
        confirmed: CONFIRM_PROP,
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },
  {
    name: "sol_send",
    description:
      "CAUTION: send SOL or an SPL token (Token or Token-2022) from the local Solana wallet. Real funds, irreversible. " +
      "Without confirmed=true returns a preview only. Omit mint for SOL.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient Solana address" },
        amount: { type: "string", description: "Human amount, e.g. \"0.1\"" },
        mint: { type: "string", description: "SPL mint or symbol (omit for SOL)" },
        confirmed: CONFIRM_PROP,
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "sol_launch_token",
    description:
      "CAUTION: launch a token on pump.fun (via pumpportal) from the local Solana wallet, optional dev buy. Real funds. " +
      `Uploads image+metadata to pump.fun IPFS, then signs with a fresh mint keypair and the local wallet. Without confirmed=true returns a preview only. Needs balance >= devBuySol + 0.03 SOL; devBuySol max ${MAX_DEV_BUY_SOL}.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Token name (max 32 chars)" },
        symbol: { type: "string", description: "Ticker (max 10 chars)" },
        description: { type: "string" },
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
  const q = await fetchSolQuote({ inputMint: str(a.inputMint, "inputMint"), outputMint: str(a.outputMint, "outputMint"), amount: String(a.amount ?? ""), slippageBps: a.slippageBps });
  return ok(`**Jupiter quote**\n${describeQuote(q)}`, quoteStructured(q));
}

async function handleSwap(a: Record<string, any>): Promise<ToolResult> {
  const q = await fetchSolQuote({ inputMint: str(a.inputMint, "inputMint"), outputMint: str(a.outputMint, "outputMint"), amount: String(a.amount ?? ""), slippageBps: a.slippageBps });
  const structured = quoteStructured(q);
  if (q.priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    return { content: [{ type: "text", text: `⛔ REJECTED: price impact ${q.priceImpactPct.toFixed(2)}% exceeds the ${MAX_PRICE_IMPACT_PCT}% limit. Reduce the amount or pick a deeper pool.\n\n${describeQuote(q)}` }], structuredContent: { executed: false, rejected: "price_impact", ...structured }, isError: true };
  }
  if (a.confirmed !== true) return blocked(describeQuote(q), structured);
  const kp = requireWallet();
  const tx = await buildSwapTx(q.raw, kp.publicKey.toBase58());
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
  const built = await buildTransfer(from, new PublicKey(to), String(a.amount ?? ""), a.mint ? String(a.mint) : undefined);
  if (built.kind === "SOL") {
    const have = await getSolLamports(from.toBase58());
    if (have < built.amountRaw + 5_000n) throw new Error(`Insufficient SOL: have ${formatBaseUnits(have, 9)}, need ${formatBaseUnits(built.amountRaw, 9)} plus fees.`);
  }
  const structured = { from: from.toBase58(), to, amount: formatBaseUnits(built.amountRaw, built.decimals), asset: built.kind === "SOL" ? "SOL" : built.mint };
  if (a.confirmed !== true) return blocked(`Send ${built.summary}\nFrom: ${from.toBase58()}`, structured);
  built.tx.sign([w.keypair]);
  const sig = await sendAndConfirm(built.tx);
  return ok(`✅ Sent ${built.summary}\nSignature: ${sig}\nhttps://solscan.io/tx/${sig}`, { executed: true, signature: sig, ...structured });
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; type: string }> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("imageUrl must be https.");
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error(`imageUrl is not an image (content-type "${type || "unknown"}").`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image must be 1 byte to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  return { bytes, type };
}

async function handleLaunch(a: Record<string, any>): Promise<ToolResult> {
  const name = str(a.name, "name");
  const symbol = str(a.symbol, "symbol");
  const description = str(a.description, "description");
  const imageUrl = str(a.imageUrl, "imageUrl");
  if (name.length > 32) throw new Error("name max 32 characters.");
  if (symbol.length > 10) throw new Error("symbol max 10 characters.");
  const devBuyStr = a.devBuySol === undefined || a.devBuySol === null || String(a.devBuySol) === "" ? "0" : String(a.devBuySol);
  const devBuyLamports = devBuyStr === "0" ? 0n : parseHumanToBaseUnits(devBuyStr, 9);
  if (devBuyLamports > BigInt(MAX_DEV_BUY_SOL) * BigInt(LAMPORTS_PER_SOL)) throw new Error(`devBuySol max ${MAX_DEV_BUY_SOL} SOL.`);
  const w = loadSolanaKeypair(false);
  if (!w) throw new Error("No local Solana wallet exists. Run sol_wallet first and fund it.");
  const payer = w.keypair.publicKey.toBase58();
  const have = await getSolLamports(payer);
  const need = devBuyLamports + MIN_LAUNCH_BUFFER_LAMPORTS;
  if (have < need) throw new Error(`Insufficient SOL: have ${formatBaseUnits(have, 9)}, need at least ${formatBaseUnits(need, 9)} (devBuy + 0.03 SOL fees/rent).`);
  const structured = { name, symbol, imageUrl, devBuySol: formatBaseUnits(devBuyLamports, 9), payer };
  if (a.confirmed !== true) {
    return blocked(`Launch on pump.fun:\nName: ${name}\nSymbol: ${symbol}\nDescription: ${description}\nImage: ${imageUrl}\nDev buy: ${formatBaseUnits(devBuyLamports, 9)} SOL\nCreator/payer: ${payer}`, structured);
  }
  const img = await fetchImage(imageUrl);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(img.bytes)], { type: img.type }), "token-image");
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description);
  form.append("showName", "true");
  const up = await getJson(PUMP_IPFS, { method: "POST", body: form });
  const uri: string | undefined = up?.metadataUri;
  if (!uri) throw new Error(`pump.fun IPFS upload returned no metadataUri: ${JSON.stringify(up).slice(0, 200)}`);
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
  tx.sign([mintKp, w.keypair]);
  const sig = await sendAndConfirm(tx);
  const mint = mintKp.publicKey.toBase58();
  return ok(`✅ Token launched on pump.fun.\nMint: ${mint}\nMetadata: ${uri}\nSignature: ${sig}\nhttps://pump.fun/coin/${mint}`, { executed: true, mint, signature: sig, metadataUri: uri, ...structured });
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
