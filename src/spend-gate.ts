// Spend gate for every tool that moves EVM funds from the local wallet.
//
//   * default-deny: nothing spends unless the operator sets FINCH_ALLOW_SPEND=1 in the MCP server env
//     (same model as FINCH_SOL_ALLOW_SPEND for Solana);
//   * kill-switch: env FINCH_SPEND_DISABLED=1 or the file ~/.finch/spend.OFF stops everything immediately;
//   * per-call and per-day USD caps (operator ceilings from env, tightened further by ~/.finch/policy.json);
//   * optional recipient allowlist (FINCH_SPEND_ALLOWLIST=0x..,0x.. and/or policy.json);
//   * preview binding: a spend needs `confirm:true` AND the `quoteId` minted by a preview of the very same
//     parameters. `confirm:true` alone (e.g. injected by scraped text) never spends.
//   * a bigint-safe ledger in ~/.finch/spend-ledger.json (0600): USD micros and wei are decimal strings.
//
// The model-callable wallet_policy tool can only TIGHTEN this policy. Loosening needs the operator's env.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ToolResult } from "./types.js";
import { finchDir, readJsonStrict, writePrivateJson, ensurePrivateDir } from "./secure-fs.js";

export const DEFAULT_MAX_PER_CALL_USD = "100";
export const DEFAULT_MAX_PER_DAY_USD = "500";
export const QUOTE_TTL_MS = 10 * 60 * 1000;
const USD_DECIMALS = 6;

const policyFile = () => path.join(finchDir(), "policy.json");
const ledgerFile = () => path.join(finchDir(), "spend-ledger.json");
export const killSwitchFile = () => path.join(finchDir(), "spend.OFF");

// ── USD micro helpers (bigint, no floats in the ledger) ─────────────────────
export function parseUsdMicros(v: string | number): bigint {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(USD_DECIMALS) : "") : String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid USD amount: ${JSON.stringify(v)}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(USD_DECIMALS) + BigInt((f + "0".repeat(USD_DECIMALS)).slice(0, USD_DECIMALS));
}
export function formatUsdMicros(m: bigint): string {
  const base = 10n ** BigInt(USD_DECIMALS);
  return `${m / base}.${(m % base).toString().padStart(USD_DECIMALS, "0").slice(0, 2)}`;
}
/** USD value of `raw` base units of an asset priced at `priceUsd` per whole unit. Rounds half-up to micros. */
export function usdMicrosFor(raw: bigint, decimals: number, priceUsd: number): bigint {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) throw new Error("price must be a positive number");
  const priceMicros = BigInt(Math.round(priceUsd * 1e6));
  return (raw * priceMicros + 10n ** BigInt(decimals) / 2n) / 10n ** BigInt(decimals);
}

// ── ETH/USD with sanity bounds ──────────────────────────────────────────────
export const ETH_USD_MIN = 50;
export const ETH_USD_MAX = 1_000_000;
let _ethCache: { px: number; at: number } | null = null;
export function resetPriceCache(): void { _ethCache = null; }

export function assertSanePrice(px: number): number {
  if (!Number.isFinite(px) || px < ETH_USD_MIN || px > ETH_USD_MAX) {
    throw new Error(`ETH/USD price ${px} failed the sanity check (${ETH_USD_MIN}..${ETH_USD_MAX}); refusing to size a spend from it.`);
  }
  return px;
}

export async function ethUsdPrice(): Promise<number> {
  const override = process.env.FINCH_ETH_USD_OVERRIDE;
  if (override) return assertSanePrice(Number(override));
  if (_ethCache && Date.now() - _ethCache.at < 60_000) return _ethCache.px;
  const sources: Array<() => Promise<number>> = [
    async () => Number(((await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(8000) })).json()) as any)?.data?.amount),
    async () => Number(((await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(8000) })).json()) as any)?.ethereum?.usd),
  ];
  const seen: number[] = [];
  for (const s of sources) { try { const p = await s(); if (p >= ETH_USD_MIN && p <= ETH_USD_MAX) seen.push(p); } catch { /* next */ } }
  if (!seen.length) throw new Error("Could not obtain a sane ETH/USD price; refusing to size a spend.");
  // Conservative for a cap: use the HIGHER price, and refuse if sources disagree wildly.
  const px = Math.max(...seen);
  if (seen.length > 1 && Math.min(...seen) < px * 0.8) throw new Error("ETH/USD sources disagree by >20%; refusing to size a spend.");
  _ethCache = { px, at: Date.now() };
  return px;
}

// ── Policy ──────────────────────────────────────────────────────────────────
export interface Policy {
  version: 1;
  maxPerCallUsd?: string;
  maxPerDayUsd?: string;
  allowlist?: string[];
}
export function loadPolicy(): Policy {
  try { return readJsonStrict<Policy>(policyFile(), { version: 1 }); }
  catch { throw new Error(`${policyFile()} is corrupt. Fix or remove it by hand; refusing to spend with an unreadable policy.`); }
}
export function savePolicy(p: Policy): void { writePrivateJson(policyFile(), p, { backup: true }); }

function envAllowlist(): string[] {
  return (process.env.FINCH_SPEND_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}
export function envCeilings(): { perCall: bigint; perDay: bigint } {
  return {
    perCall: parseUsdMicros(process.env.FINCH_MAX_SPEND_USD_PER_CALL || DEFAULT_MAX_PER_CALL_USD),
    perDay: parseUsdMicros(process.env.FINCH_MAX_SPEND_USD_PER_DAY || DEFAULT_MAX_PER_DAY_USD),
  };
}
export interface EffectivePolicy { perCall: bigint; perDay: bigint; allowlist: string[]; killed: boolean; spendEnabled: boolean }
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
export function effectivePolicy(): EffectivePolicy {
  const c = envCeilings();
  const p = loadPolicy();
  const perCall = p.maxPerCallUsd ? minB(c.perCall, parseUsdMicros(p.maxPerCallUsd)) : c.perCall;
  const perDay = p.maxPerDayUsd ? minB(c.perDay, parseUsdMicros(p.maxPerDayUsd)) : c.perDay;
  const env = envAllowlist();
  const file = (p.allowlist ?? []).map((s) => s.toLowerCase());
  // Both present -> a recipient must satisfy BOTH: the file can only narrow the operator's list.
  const merged = env.length && file.length ? env.filter((a) => file.includes(a)) : env.length ? env : file;
  const hasList = env.length > 0 || file.length > 0;
  return {
    perCall, perDay,
    // an allowlist that intersects to nothing must block everything, not allow everything
    allowlist: hasList && merged.length === 0 ? ["0x0000000000000000000000000000000000000000"] : merged,
    killed: isKilled(),
    spendEnabled: process.env.FINCH_ALLOW_SPEND === "1",
  };
}
export function isKilled(): boolean { return process.env.FINCH_SPEND_DISABLED === "1" || fs.existsSync(killSwitchFile()); }
export function setKillSwitch(on: boolean): void {
  if (on) { ensurePrivateDir(finchDir()); fs.writeFileSync(killSwitchFile(), `engaged ${new Date().toISOString()}\n`, { mode: 0o600 }); }
  else try { fs.unlinkSync(killSwitchFile()); } catch { /* absent */ }
}

// ── Ledger ──────────────────────────────────────────────────────────────────
interface LedgerEntry { id: string; ts: number; tool: string; usdMicros: string; wei?: string; txHash?: string; state: "reserved" | "committed" }
interface Ledger { version: 1; entries: LedgerEntry[] }
const DAY_MS = 24 * 3600 * 1000;

function loadLedger(): Ledger {
  const l = readJsonStrict<Ledger>(ledgerFile(), { version: 1, entries: [] });
  if (!Array.isArray(l.entries)) throw new Error(`${ledgerFile()} is malformed; refusing to spend with an unreadable ledger.`);
  return l;
}
function saveLedger(l: Ledger): void {
  const cutoff = Date.now() - 14 * DAY_MS;
  l.entries = l.entries.filter((e) => e.ts >= cutoff);
  writePrivateJson(ledgerFile(), l);
}
/** Rolling-24h total (reserved + committed), in USD micros. */
export function spentLast24h(now = Date.now()): bigint {
  return loadLedger().entries.filter((e) => e.ts > now - DAY_MS).reduce((s, e) => s + BigInt(e.usdMicros), 0n);
}
export function weiSpentLast24h(now = Date.now()): bigint {
  return loadLedger().entries.filter((e) => e.ts > now - DAY_MS).reduce((s, e) => s + BigInt(e.wei ?? "0"), 0n);
}

export interface Reservation { id: string; commit(txHash?: string): void; release(): void }
function reserve(tool: string, usd: bigint, wei?: bigint): Reservation {
  const l = loadLedger();
  const id = crypto.randomBytes(6).toString("hex");
  l.entries.push({ id, ts: Date.now(), tool, usdMicros: usd.toString(), wei: wei?.toString(), state: "reserved" });
  saveLedger(l);
  return {
    id,
    commit(txHash) { const x = loadLedger(); const m = x.entries.find((y) => y.id === id); if (m) { m.state = "committed"; m.txHash = txHash; saveLedger(x); } },
    release() { const x = loadLedger(); x.entries = x.entries.filter((y) => y.id !== id); saveLedger(x); },
  };
}

// ── quoteId binding ─────────────────────────────────────────────────────────
const quotes = new Map<string, { fp: string; exp: number }>();
function fingerprint(tool: string, chainId: number, params: Record<string, unknown>): string {
  const norm: Record<string, string> = {};
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    norm[k] = typeof v === "string" ? v.trim().toLowerCase() : String(v);
  }
  return crypto.createHash("sha256").update(JSON.stringify({ tool, chainId, norm })).digest("hex");
}
export function issueQuoteId(tool: string, chainId: number, params: Record<string, unknown>): string {
  const now = Date.now();
  for (const [k, v] of quotes) if (v.exp < now) quotes.delete(k);
  const id = "q_" + crypto.randomBytes(9).toString("hex");
  quotes.set(id, { fp: fingerprint(tool, chainId, params), exp: now + QUOTE_TTL_MS });
  return id;
}
function quoteValid(id: unknown, tool: string, chainId: number, params: Record<string, unknown>): boolean {
  if (typeof id !== "string") return false;
  const q = quotes.get(id);
  return !!q && q.exp >= Date.now() && q.fp === fingerprint(tool, chainId, params);
}
export function resetQuotes(): void { quotes.clear(); }
/** Validate AND consume a quoteId minted by issueQuoteId for these exact params (single use). */
export function consumeQuote(id: unknown, tool: string, chainId: number, params: Record<string, unknown>): boolean {
  if (!quoteValid(id, tool, chainId, params)) return false;
  quotes.delete(String(id));
  return true;
}

// ── Trusted internal calls (rh_orders_tick -> rh_mcp_swap) ──────────────────
// MCP arguments arrive as parsed JSON and can never be members of this WeakSet.
const trusted = new WeakSet<object>();
export function markTrusted<T extends object>(args: T): T { trusted.add(args); return args; }
export function isTrusted(args: unknown): boolean { return typeof args === "object" && args !== null && trusted.has(args as object); }

// ── Gate ────────────────────────────────────────────────────────────────────
export interface GateInput {
  tool: string;
  chainId: number;
  /** Everything that defines the spend; bound to the quoteId. */
  params: Record<string, unknown>;
  recipient?: string;
  /** USD value (micros) of what leaves the wallet. Resolved after the cheap checks. null = unknown -> refuse. */
  usd?: () => Promise<bigint | null>;
  wei?: bigint;
  /** Order-arming tools (DCA/bracket) have no immediate USD value: skip caps/ledger, still need enabled + quoteId. */
  arming?: boolean;
  confirm?: unknown;
  quoteId?: unknown;
  summary: string;
}
export type GateResult = { ok: true; reservation: Reservation | null; usd: bigint | null } | { ok: false; result: ToolResult };

function refuse(text: string, structured: Record<string, unknown> = {}): GateResult {
  return { ok: false, result: { content: [{ type: "text", text: `⛔ NOT EXECUTED — ${text}` }], isError: true, structuredContent: { executed: false, status: "refused", txHash: null, ...structured } } as ToolResult };
}

export async function gateSpend(g: GateInput): Promise<GateResult> {
  const chainId = g.chainId;
  if (isKilled()) return refuse(`${g.tool}: the spend kill-switch is engaged (FINCH_SPEND_DISABLED=1 or ${killSwitchFile()}). Remove it manually to resume.`, { reason: "kill_switch", chainId });
  if (process.env.FINCH_ALLOW_SPEND !== "1") {
    return refuse(
      `${g.tool} is disabled: spending from the local EVM wallet is default-deny. The human operator must set FINCH_ALLOW_SPEND=1 in the MCP server config and restart. ` +
      `Caps: FINCH_MAX_SPEND_USD_PER_CALL (default ${DEFAULT_MAX_PER_CALL_USD}), FINCH_MAX_SPEND_USD_PER_DAY (default ${DEFAULT_MAX_PER_DAY_USD}); optional FINCH_SPEND_ALLOWLIST=0x…,0x…`,
      { reason: "spend_disabled", chainId });
  }
  let pol: EffectivePolicy;
  try { pol = effectivePolicy(); } catch (e: any) { return refuse(e?.message ?? String(e), { reason: "policy_error", chainId }); }
  if (g.recipient && pol.allowlist.length && !pol.allowlist.includes(g.recipient.toLowerCase())) {
    return refuse(`recipient ${g.recipient} is not on the spend allowlist.`, { reason: "recipient_not_allowed", chainId });
  }
  let usd: bigint | null = null;
  if (g.arming) {
    // Arming an order has no immediate spend, but a single leg must not already exceed the per-call cap.
    if (g.usd) {
      try { usd = await g.usd(); } catch (e: any) { return refuse(`could not value this order in USD (${e?.message ?? e}). Failing closed.`, { reason: "unpriced", chainId }); }
      if (usd !== null && usd > pol.perCall) return refuse(`each leg is $${formatUsdMicros(usd)}, over the per-call cap of $${formatUsdMicros(pol.perCall)}.`, { reason: "per_call_cap", chainId });
    }
  } else {
    try { usd = g.usd ? await g.usd() : null; } catch (e: any) { return refuse(`could not value this spend in USD (${e?.message ?? e}). Failing closed.`, { reason: "unpriced", chainId }); }
    if (usd === null) return refuse("could not value this spend in USD (unknown asset price). Failing closed: caps cannot be enforced.", { reason: "unpriced", chainId });
    if (usd > pol.perCall) return refuse(`$${formatUsdMicros(usd)} exceeds the per-call cap of $${formatUsdMicros(pol.perCall)}.`, { reason: "per_call_cap", chainId });
    let day: bigint;
    try { day = spentLast24h(); } catch (e: any) { return refuse(e?.message ?? String(e), { reason: "ledger_error", chainId }); }
    if (day + usd > pol.perDay) return refuse(`$${formatUsdMicros(usd)} would take the rolling 24h total to $${formatUsdMicros(day + usd)}, over the daily cap of $${formatUsdMicros(pol.perDay)}.`, { reason: "daily_cap", chainId });
  }
  if (g.confirm !== true || !quoteValid(g.quoteId, g.tool, g.chainId, g.params)) {
    const quoteId = issueQuoteId(g.tool, g.chainId, g.params);
    const why = g.confirm === true ? "confirm:true was given without a valid quoteId from a preview of these exact parameters" : "confirmation required";
    const text =
      `${why}. Nothing was sent.\n${g.summary}\n` +
      (usd !== null ? `Value: ≈ $${formatUsdMicros(usd)} (per-call cap $${formatUsdMicros(pol.perCall)}, 24h cap $${formatUsdMicros(pol.perDay)})\n` : "") +
      `quoteId: ${quoteId} (valid ${QUOTE_TTL_MS / 60000} min, single use)\n` +
      `Show the user these exact details. To execute, re-run the SAME call with confirm:true and quoteId:"${quoteId}". Any changed parameter invalidates the quoteId.`;
    return { ok: false, result: { content: [{ type: "text", text: `⛔ NOT EXECUTED — ${text}` }], isError: true, structuredContent: { executed: false, status: "preview", txHash: null, chainId, quoteId, ...(usd !== null ? { usd: formatUsdMicros(usd) } : {}) } } as ToolResult };
  }
  quotes.delete(String(g.quoteId));
  const reservation = !g.arming && usd !== null ? reserve(g.tool, usd, g.wei) : null;
  return { ok: true, reservation, usd };
}

/** Unattended (cron) gate: no human preview, so no quoteId — but kill-switch, enable flag and the caps all apply. */
export async function gateUnattended(tool: string, usd: bigint, wei: bigint, opts: { skipCaps?: boolean } = {}): Promise<GateResult> {
  if (isKilled()) return refuse(`${tool}: kill-switch engaged.`, { reason: "kill_switch" });
  if (process.env.FINCH_ALLOW_SPEND !== "1") return refuse(`${tool}: FINCH_ALLOW_SPEND=1 is not set; unattended orders cannot spend.`, { reason: "spend_disabled" });
  // Risk-reducing exits (TP/SL sells) are not blocked by spend caps, only by the enable flag and kill-switch.
  if (opts.skipCaps) return { ok: true, reservation: null, usd };
  let pol: EffectivePolicy;
  try { pol = effectivePolicy(); } catch (e: any) { return refuse(e?.message ?? String(e), { reason: "policy_error" }); }
  if (usd > pol.perCall) return refuse(`$${formatUsdMicros(usd)} exceeds the per-call cap of $${formatUsdMicros(pol.perCall)}.`, { reason: "per_call_cap" });
  let day: bigint;
  try { day = spentLast24h(); } catch (e: any) { return refuse(e?.message ?? String(e), { reason: "ledger_error" }); }
  if (day + usd > pol.perDay) return refuse(`daily cap reached ($${formatUsdMicros(day)} of $${formatUsdMicros(pol.perDay)} used in 24h).`, { reason: "daily_cap" });
  return { ok: true, reservation: reserve(tool, usd, wei), usd };
}

/** Structured result for money-moving tools: { txHash, status, chainId }. */
export function moneyResult(
  text: string,
  s: { txHash?: string | null; status: "confirmed" | "pending" | "reverted" | "failed"; chainId: number; extra?: Record<string, unknown> },
  isError = false,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
    structuredContent: { executed: s.status !== "failed", txHash: s.txHash ?? null, status: s.status, chainId: s.chainId, ...(s.extra ?? {}) },
  } as ToolResult;
}

const STABLES = new Set(["USDC", "USDT", "DAI", "USDG"]);
/** USD micros for `amount` (human string) of a Base asset symbol. null when the asset cannot be priced locally. */
export async function baseAssetUsd(symbol: string, amount: string): Promise<bigint | null> {
  const sym = symbol.trim().toUpperCase();
  if (STABLES.has(sym)) return parseUsdMicros(amount);
  if (sym === "ETH" || sym === "WETH") {
    const wei = ethersParse(amount, 18);
    return usdMicrosFor(wei, 18, await ethUsdPrice());
  }
  return null;
}
function ethersParse(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) throw new Error(`invalid amount ${JSON.stringify(amount)}`);
  const [w, f = ""] = amount.trim().split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
}
export { ethersParse as parseAmountUnits };
