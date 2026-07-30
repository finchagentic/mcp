// Robinhood Chain automated orders — DCA / TP / SL (Phase 2).
//
// Self-contained order engine layered on the tested `rh_mcp_swap` path.
// Orders persist locally at ~/.finch/rh-orders.json. Execution is opt-in:
// `rh_orders_tick` previews by default and only trades when execute:true, and
// never when the kill-switch is set (env RH_ORDERS_DISABLED=1 or the file
// ~/.finch/rh-orders.OFF exists). DCA is bounded by a hard maxSpendEth;
// TP/SL only ever SELL tokens the wallet already holds.
//
// An always-on scheduler must call `rh_orders_tick {execute:true}` periodically
// (Convex cron via the CLI, Windows Task Scheduler, or the scheduled-tasks MCP).

import fs from "fs";
import os from "os";
import path from "path";
import { ethers } from "ethers";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { getOrCreateWallet } from "../wallet.js";
import {
  RH_EXPLORER,
  resolveTokenSmart,
  rhPriceUsd,
  rhErc20Balance,
  handleRhMcpTool,
} from "./rh-mcp.js";

const ORDERS_DIR = path.join(os.homedir(), ".finch");
const ORDERS_FILE = path.join(ORDERS_DIR, "rh-orders.json");
const KILL_FILE = path.join(ORDERS_DIR, "rh-orders.OFF");

interface DcaLeg {
  amountEthPerBuy: string; // human ETH
  intervalSec: number;
  totalBuys: number;
  completedBuys: number;
  nextRunAt: number; // epoch ms
  maxSpendEth: string; // hard cap (human ETH)
  spentEth: string; // accumulated (human ETH)
  fills: Array<{ ts: number; txHash: string; amountEth: string }>;
}

interface BracketLeg {
  entryPriceUsd: number | null;
  tpPriceUsd?: number;
  slPriceUsd?: number;
  sellPct: number; // 1..100 of current token balance on trigger
  fills: Array<{ ts: number; txHash: string; kind: "tp" | "sl"; priceUsd: number }>;
}

interface RhOrder {
  id: string;
  type: "dca" | "bracket";
  status: "active" | "completed" | "cancelled" | "error";
  token: { address: string; symbol: string; decimals: number };
  slippagePct: number;
  note?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  dca?: DcaLeg;
  bracket?: BracketLeg;
}

interface OrderStore {
  version: number;
  orders: RhOrder[];
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function loadStore(): OrderStore {
  try {
    const raw = fs.readFileSync(ORDERS_FILE, "utf8");
    const s = JSON.parse(raw) as OrderStore;
    if (s && Array.isArray(s.orders)) return s;
  } catch {
    /* fresh store */
  }
  return { version: 1, orders: [] };
}

function saveStore(s: OrderStore): void {
  try {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  // Atomic write: a crash mid-write must not corrupt the order store.
  const tmp = `${ORDERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, ORDERS_FILE);
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ── Tick lock ──────────────────────────────────────────────────────────────
// rh_orders_tick reads the store, awaits a real on-chain swap per due order
// (a slow network round trip), and only writes the store back at the end.
// Without a lock, two overlapping executing ticks (a slow RPC making one call
// outlast the next scheduler firing, or a manual call racing the scheduler)
// both read the SAME pre-update state, both see the same order as due, and
// both broadcast a real swap - real funds spent twice for what the store
// ends up recording as one buy. Preview ticks (execute:false) never write and
// are harmless to run concurrently, so only executing ticks take the lock.
const TICK_LOCK_FILE = path.join(ORDERS_DIR, "rh-orders.tick.lock");
const LOCK_STALE_MS = 5 * 60 * 1000; // a tick this slow is presumed crashed, not just slow

function acquireTickLock(): boolean {
  try {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    // Exclusive create - atomically fails if another tick already holds it.
    fs.writeFileSync(TICK_LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      const stat = fs.statSync(TICK_LOCK_FILE);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        // Prior holder almost certainly crashed without releasing - take over
        // rather than deadlocking every future tick forever.
        fs.writeFileSync(TICK_LOCK_FILE, String(process.pid));
        return true;
      }
    } catch {
      /* lock vanished between the failed create and this stat - try again next tick */
    }
    return false;
  }
}

function releaseTickLock(): void {
  try {
    fs.unlinkSync(TICK_LOCK_FILE);
  } catch {
    /* already gone */
  }
}

function killSwitchOn(): boolean {
  return process.env.RH_ORDERS_DISABLED === "1" || fs.existsSync(KILL_FILE);
}

function posNum(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : NaN;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "?";
  if (n >= 1) return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return "$" + n.toPrecision(4);
}

function extractTxHash(text: string): string | null {
  // Target the swap tx specifically — sells print "Permit2 approvals: 0x…" BEFORE
  // "Tx: 0x…", so a naive first-match would record the approval hash instead.
  const tx = text.match(/Tx:\s*`?(0x[a-fA-F0-9]{64})/i);
  if (tx) return tx[1];
  const any = text.match(/0x[a-fA-F0-9]{64}/);
  return any ? any[0] : null;
}

export const RH_ORDER_TOOLS: Tool[] = [
  {
    name: "rh_dca_create",
    description:
      "Robinhood Chain — create a DCA plan: buy a fixed ETH amount of a token every N hours, " +
      "up to a total number of buys, capped by maxSpendEth. Token by catalog symbol, crypto " +
      "ticker, or 0x contract address (resolved via DexScreener). Does NOT execute now — the " +
      "scheduler runs it via rh_orders_tick. Always confirm the resolved contract address first.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Ticker or 0x contract address to accumulate" },
        amountEthPerBuy: { type: "string", description: "ETH spent per buy, e.g. '0.01'" },
        intervalHours: { type: "number", description: "Hours between buys (e.g. 24 for daily)" },
        totalBuys: { type: "number", description: "How many buys total" },
        maxSpendEth: {
          type: "string",
          description: "Hard cap on total ETH spent (default amountEthPerBuy × totalBuys)",
        },
        slippagePct: { type: "number", description: "Slippage % per buy (default 3.0)" },
        note: { type: "string", description: "Optional label" },
      },
      required: ["token", "amountEthPerBuy", "intervalHours", "totalBuys"],
    },
  },
  {
    name: "rh_bracket_create",
    description:
      "Robinhood Chain — set take-profit and/or stop-loss on a token you HOLD. When DexScreener " +
      "price crosses tpPriceUsd (≥) or slPriceUsd (≤), the scheduler sells sellPct% of your " +
      "current balance for ETH via rh_orders_tick. Provide at least one of tpPriceUsd / slPriceUsd. " +
      "Only ever sells tokens already in the wallet — never borrows or shorts.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Ticker or 0x contract address you hold" },
        tpPriceUsd: { type: "number", description: "Take-profit price in USD (sell when ≥)" },
        slPriceUsd: { type: "number", description: "Stop-loss price in USD (sell when ≤)" },
        sellPct: { type: "number", description: "Percent of balance to sell on trigger (default 100)" },
        slippagePct: { type: "number", description: "Slippage % on the sell (default 5.0)" },
        note: { type: "string", description: "Optional label" },
      },
      required: ["token"],
    },
  },
  {
    name: "rh_orders_list",
    description:
      "Robinhood Chain — list saved DCA / TP / SL orders and their progress. Optional status filter.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter: active | completed | cancelled | error (default all)",
        },
      },
      required: [],
    },
  },
  {
    name: "rh_order_cancel",
    description: "Robinhood Chain — cancel a saved order by id (stops future DCA buys / TP-SL fills).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Order id (rho_… / rhb_…)" } },
      required: ["id"],
    },
  },
  {
    name: "rh_orders_tick",
    description:
      "Robinhood Chain — evaluate all active orders and act on any that are due (DCA interval " +
      "reached) or triggered (TP/SL price crossed). PREVIEW by default; pass execute:true to " +
      "broadcast real swaps. Refuses to execute when the kill-switch is set (RH_ORDERS_DISABLED=1 " +
      "or ~/.finch/rh-orders.OFF). This is the entry point an always-on scheduler calls.",
    inputSchema: {
      type: "object",
      properties: {
        execute: {
          type: "boolean",
          description: "true = broadcast real swaps; false/omitted = dry-run preview only",
        },
      },
      required: [],
    },
  },
];

// Structured output builder for rh_orders_list (schema in output-schemas.ts).
export function buildOrdersList(orders: any[]): Record<string, unknown> {
  return {
    count: orders.length,
    orders: orders.map((o) => ({
      id: o.id,
      type: o.type ?? null,
      status: o.status ?? null,
      symbol: o.token?.symbol ?? null,
      address: o.token?.address ?? null,
      dca: o.dca ?? null,
      bracket: o.bracket ?? null,
      lastError: o.lastError ?? null,
    })),
  };
}

export async function handleRhOrderTool(name: string, args: unknown): Promise<ToolResult | null> {
  const a = (args ?? {}) as any;

  switch (name) {
    case "rh_dca_create": {
      const amountEth = posNum(a.amountEthPerBuy);
      const intervalHours = posNum(a.intervalHours);
      const totalBuys = Math.floor(posNum(a.totalBuys));
      if (!(amountEth > 0)) return textResult("amountEthPerBuy must be > 0", true);
      if (!(intervalHours > 0)) return textResult("intervalHours must be > 0", true);
      if (!(totalBuys > 0)) return textResult("totalBuys must be ≥ 1", true);
      let resolved;
      try {
        resolved = await resolveTokenSmart(String(a.token));
      } catch (e: any) {
        return textResult(`Token resolve failed: ${e?.message ?? e}`, true);
      }
      if (resolved.kind !== "token") return textResult("token must be a stock/crypto, not ETH", true);
      const defaultCap = amountEth * totalBuys;
      const maxSpendEth = a.maxSpendEth != null ? posNum(a.maxSpendEth) : defaultCap;
      if (!(maxSpendEth > 0)) return textResult("maxSpendEth must be > 0", true);
      if (maxSpendEth < amountEth) {
        return textResult(
          `maxSpendEth (${maxSpendEth}) is below amountEthPerBuy (${amountEth}) — no buy could ever fire.`,
          true
        );
      }

      const now = Date.now();
      const order: RhOrder = {
        id: genId("rho"),
        type: "dca",
        status: "active",
        token: { address: resolved.address, symbol: resolved.symbol, decimals: resolved.decimals },
        slippagePct: posNum(a.slippagePct) > 0 ? posNum(a.slippagePct) : 3.0,
        note: a.note ? String(a.note) : undefined,
        createdAt: now,
        updatedAt: now,
        dca: {
          amountEthPerBuy: String(amountEth),
          intervalSec: Math.round(intervalHours * 3600),
          totalBuys,
          completedBuys: 0,
          nextRunAt: now, // first buy on the next tick
          maxSpendEth: String(maxSpendEth),
          spentEth: "0",
          fills: [],
        },
      };
      const store = loadStore();
      store.orders.push(order);
      saveStore(store);
      return textResult(
        [
          `## ✅ DCA created — ${order.id}`,
          `Buy **${amountEth} ETH → ${resolved.symbol}** every **${intervalHours}h**, **${totalBuys}×** (cap **${maxSpendEth} ETH**).`,
          `\`${resolved.address}\` · slippage ${order.slippagePct}%`,
          ``,
          `First buy fires on the next \`rh_orders_tick {execute:true}\`. Preview anytime with \`rh_orders_tick\`.`,
          `⚠️ Autonomous execution needs a scheduler calling the tick. Kill-switch: create \`~/.finch/rh-orders.OFF\`.`,
        ].join("\n")
      );
    }

    case "rh_bracket_create": {
      const hasTp = a.tpPriceUsd != null;
      const hasSl = a.slPriceUsd != null;
      if (!hasTp && !hasSl) return textResult("Provide at least one of tpPriceUsd / slPriceUsd", true);
      const tp = hasTp ? posNum(a.tpPriceUsd) : undefined;
      const sl = hasSl ? posNum(a.slPriceUsd) : undefined;
      if (hasTp && !(tp! > 0)) return textResult("tpPriceUsd must be > 0", true);
      if (hasSl && !(sl! > 0)) return textResult("slPriceUsd must be > 0", true);
      if (hasTp && hasSl && sl! >= tp!) return textResult("slPriceUsd must be below tpPriceUsd", true);
      const sellPct = a.sellPct != null ? posNum(a.sellPct) : 100;
      if (!(sellPct > 0 && sellPct <= 100)) return textResult("sellPct must be 1..100", true);

      let resolved;
      try {
        resolved = await resolveTokenSmart(String(a.token));
      } catch (e: any) {
        return textResult(`Token resolve failed: ${e?.message ?? e}`, true);
      }
      if (resolved.kind !== "token") return textResult("token must be a stock/crypto, not ETH", true);

      const entry = await rhPriceUsd(resolved.address);
      const now = Date.now();
      const order: RhOrder = {
        id: genId("rhb"),
        type: "bracket",
        status: "active",
        token: { address: resolved.address, symbol: resolved.symbol, decimals: resolved.decimals },
        slippagePct: posNum(a.slippagePct) > 0 ? posNum(a.slippagePct) : 5.0,
        note: a.note ? String(a.note) : undefined,
        createdAt: now,
        updatedAt: now,
        bracket: { entryPriceUsd: entry, tpPriceUsd: tp, slPriceUsd: sl, sellPct, fills: [] },
      };
      const store = loadStore();
      store.orders.push(order);
      saveStore(store);
      return textResult(
        [
          `## ✅ TP/SL created — ${order.id}`,
          `Token **${resolved.symbol}** \`${resolved.address}\``,
          `Now: ${fmtUsd(entry)}${tp != null ? ` · 🎯 TP ${fmtUsd(tp)}` : ""}${sl != null ? ` · 🛑 SL ${fmtUsd(sl)}` : ""}`,
          `Sells **${sellPct}%** of balance on trigger · slippage ${order.slippagePct}%`,
          ``,
          `Fires via \`rh_orders_tick {execute:true}\` when price crosses. Only sells tokens you already hold.`,
        ].join("\n")
      );
    }

    case "rh_orders_list": {
      const filter = a.status ? String(a.status) : null;
      const store = loadStore();
      const orders = filter ? store.orders.filter((o) => o.status === filter) : store.orders;
      if (!orders.length) return { content: [{ type: "text", text: `No orders${filter ? ` with status ${filter}` : ""}.` }], structuredContent: buildOrdersList(orders) };
      const lines = [`## 📋 RH orders (${orders.length})`, ""];
      for (const o of orders) {
        if (o.type === "dca" && o.dca) {
          lines.push(
            `**${o.id}** · DCA · ${o.status}`,
            `  ${o.dca.amountEthPerBuy} ETH → ${o.token.symbol} every ${(o.dca.intervalSec / 3600).toFixed(1)}h · ${o.dca.completedBuys}/${o.dca.totalBuys} done · spent ${o.dca.spentEth}/${o.dca.maxSpendEth} ETH`,
            `  next: ${o.status === "active" ? new Date(o.dca.nextRunAt).toISOString() : "—"}${o.lastError ? ` · ⚠️ ${o.lastError}` : ""}`
          );
        } else if (o.type === "bracket" && o.bracket) {
          const b = o.bracket;
          lines.push(
            `**${o.id}** · TP/SL · ${o.status}`,
            `  ${o.token.symbol}${b.tpPriceUsd != null ? ` · 🎯 ${fmtUsd(b.tpPriceUsd)}` : ""}${b.slPriceUsd != null ? ` · 🛑 ${fmtUsd(b.slPriceUsd)}` : ""} · sell ${b.sellPct}% · entry ${fmtUsd(b.entryPriceUsd)}`,
            `  fills: ${b.fills.length}${o.lastError ? ` · ⚠️ ${o.lastError}` : ""}`
          );
        }
        lines.push(`  \`${o.token.address}\``);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: buildOrdersList(orders) };
    }

    case "rh_order_cancel": {
      const id = String(a.id ?? "").trim();
      if (!id) return textResult("Required: id", true);
      const store = loadStore();
      const o = store.orders.find((x) => x.id === id);
      if (!o) return textResult(`Order ${id} not found.`, true);
      if (o.status === "active") o.status = "cancelled";
      o.updatedAt = Date.now();
      saveStore(store);
      return textResult(`🚫 Order ${id} cancelled.`);
    }

    case "rh_orders_tick": {
      const execute = a.execute === true;
      const blocked = execute && killSwitchOn();
      const doExecute = execute && !blocked;

      // Only an executing tick can double-spend; a preview never writes and
      // is harmless to overlap, so only take the lock when it matters.
      if (doExecute && !acquireTickLock()) {
        return textResult(
          "⏳ Another rh_orders_tick is already executing - refusing to run a second one " +
          "concurrently (this is what prevents a slow tick from double-firing the same order). " +
          "Try again shortly.",
          true
        );
      }

      try {
      const store = loadStore();
      const active = store.orders.filter((o) => o.status === "active");
      const now = Date.now();
      const report: string[] = [
        `## ⏱️ RH orders tick — ${execute ? (blocked ? "EXECUTE (BLOCKED by kill-switch → preview)" : "EXECUTE") : "PREVIEW"}`,
        `${active.length} active order(s)`,
        "",
      ];
      let acted = 0;
      let wallet: { address: string } | null = null;

      for (const o of active) {
       try {
        // ---- DCA ----
        if (o.type === "dca" && o.dca) {
          const d = o.dca;
          if (d.completedBuys >= d.totalBuys) {
            o.status = "completed";
            continue;
          }
          if (now < d.nextRunAt) {
            report.push(`⏳ ${o.id} DCA ${o.token.symbol}: next buy at ${new Date(d.nextRunAt).toISOString()}`);
            continue;
          }
          const wouldSpend = Number(d.spentEth) + Number(d.amountEthPerBuy);
          if (wouldSpend > Number(d.maxSpendEth) + 1e-12) {
            o.status = "completed";
            report.push(`✅ ${o.id} DCA ${o.token.symbol}: maxSpend reached — completed`);
            continue;
          }
          acted++;
          if (!doExecute) {
            report.push(
              `🟡 ${o.id} DCA: would buy ${d.amountEthPerBuy} ETH → ${o.token.symbol} (${d.completedBuys + 1}/${d.totalBuys})`
            );
            continue;
          }
          const res = await handleRhMcpTool("rh_mcp_swap", {
            fromToken: "ETH",
            toToken: o.token.address,
            amount: d.amountEthPerBuy,
            maxSlippagePct: o.slippagePct,
            confirm: true,
          });
          const txt = res?.content?.[0]?.text ?? "";
          if (res?.isError) {
            o.lastError = txt.slice(0, 140);
            o.updatedAt = now;
            report.push(`🔴 ${o.id} DCA buy failed: ${o.lastError}`);
            continue;
          }
          const txHash = extractTxHash(txt) ?? "unknown";
          d.fills.push({ ts: now, txHash, amountEth: d.amountEthPerBuy });
          d.completedBuys += 1;
          d.spentEth = String(Number(d.spentEth) + Number(d.amountEthPerBuy));
          d.nextRunAt = now + d.intervalSec * 1000; // no burst catch-up
          o.lastError = undefined;
          o.updatedAt = now;
          if (d.completedBuys >= d.totalBuys) o.status = "completed";
          report.push(
            `🟢 ${o.id} DCA bought ${d.amountEthPerBuy} ETH → ${o.token.symbol} · ${d.completedBuys}/${d.totalBuys} · tx \`${txHash}\``
          );
          continue;
        }

        // ---- Bracket (TP/SL) ----
        if (o.type === "bracket" && o.bracket) {
          const b = o.bracket;
          const price = await rhPriceUsd(o.token.address);
          if (price == null) {
            report.push(`⚠️ ${o.id} TP/SL ${o.token.symbol}: no price available`);
            continue;
          }
          let trigger: "tp" | "sl" | null = null;
          if (b.tpPriceUsd != null && price >= b.tpPriceUsd) trigger = "tp";
          else if (b.slPriceUsd != null && price <= b.slPriceUsd) trigger = "sl";
          if (!trigger) {
            report.push(
              `⏳ ${o.id} TP/SL ${o.token.symbol}: ${fmtUsd(price)} (🎯${b.tpPriceUsd != null ? fmtUsd(b.tpPriceUsd) : "—"} / 🛑${b.slPriceUsd != null ? fmtUsd(b.slPriceUsd) : "—"})`
            );
            continue;
          }
          if (!wallet) wallet = await getOrCreateWallet();
          const balRaw = await rhErc20Balance(o.token.address, wallet.address);
          if (balRaw <= 0n) {
            o.status = "completed";
            report.push(`✅ ${o.id} TP/SL ${o.token.symbol}: ${trigger.toUpperCase()} hit but 0 balance — completed`);
            continue;
          }
          const sellRaw = (balRaw * BigInt(Math.round(b.sellPct * 100))) / 10_000n;
          const sellHuman = ethers.formatUnits(sellRaw, o.token.decimals);
          acted++;
          if (!doExecute) {
            report.push(
              `🟡 ${o.id} ${trigger.toUpperCase()} at ${fmtUsd(price)}: would sell ${b.sellPct}% (${sellHuman} ${o.token.symbol}) → ETH`
            );
            continue;
          }
          const res = await handleRhMcpTool("rh_mcp_swap", {
            fromToken: o.token.address,
            toToken: "ETH",
            amount: sellHuman,
            maxSlippagePct: o.slippagePct,
            confirm: true,
          });
          const txt = res?.content?.[0]?.text ?? "";
          if (res?.isError) {
            o.lastError = txt.slice(0, 140);
            o.updatedAt = now;
            report.push(`🔴 ${o.id} ${trigger.toUpperCase()} sell failed: ${o.lastError}`);
            continue;
          }
          const txHash = extractTxHash(txt) ?? "unknown";
          b.fills.push({ ts: now, txHash, kind: trigger, priceUsd: price });
          o.status = "completed";
          o.lastError = undefined;
          o.updatedAt = now;
          report.push(
            `🟢 ${o.id} ${trigger.toUpperCase()} sold ${sellHuman} ${o.token.symbol} → ETH at ${fmtUsd(price)} · tx \`${txHash}\``
          );
          continue;
        }
       } catch (e: any) {
          // One bad order (e.g. wallet decrypt failure) must not abort the whole tick.
          o.lastError = String(e?.message ?? e).slice(0, 140);
          o.updatedAt = now;
          report.push(`🔴 ${o.id}: tick error — ${o.lastError}`);
       }
      }

      // Preview must be read-only: only persist state when actually executing.
      if (doExecute) saveStore(store);
      if (blocked) {
        report.push("", "🛑 Kill-switch active — no swaps broadcast. Remove ~/.finch/rh-orders.OFF or unset RH_ORDERS_DISABLED to enable.");
      } else if (acted === 0) {
        report.push("", "Nothing due or triggered this tick.");
      } else if (!doExecute) {
        report.push("", `${acted} action(s) pending. Re-run with \`execute:true\` (via scheduler) to broadcast.`);
      }
      report.push("", `_Explorer: ${RH_EXPLORER}_`);
      return textResult(report.join("\n"));
      } finally {
        if (doExecute) releaseTickLock();
      }
    }

    default:
      return null;
  }
}
