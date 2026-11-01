import { getOrCreateWallet } from "./wallet.js";
import { getSavedToken } from "./config.js";
import { callConvex } from "./convex.js";
import { rhProviderAsync } from "./tools/rh-mcp-provider.js";
import { ethers } from "ethers";
import { FINCH_RH_ADDRESS, FINCH_RH_CHAIN_ID } from "./constants.js";
import type { ToolResult } from "./types.js";

const CACHE_TTL = 5 * 60 * 1000; // 5 min - avoid per-call RPC / backend hit

// 1 FINCH (18 decimals). Override via FINCH_MIN_BALANCE env var.
const MIN_BALANCE = BigInt(process.env.FINCH_MIN_BALANCE ?? "1000000000000000000");

export type Tier = "holder" | "basic";

let _cache: { tier: Tier; at: number } | null = null;
let _authCache: { ok: boolean; at: number; cred: string } | null = null;
export function resetTierCache(): void { _cache = null; _authCache = null; }

async function erc20BalanceOf(address: string): Promise<bigint> {
  const provider = await rhProviderAsync();
  const c = new ethers.Contract(FINCH_RH_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
  return BigInt(await c.balanceOf(address));
}

/** A credential only counts if the backend accepts it. A non-empty string is NOT enough. */
export async function credentialIsValid(): Promise<boolean> {
  const cred = process.env.FINCH_API_KEY || getSavedToken() || "";
  if (!cred) return false;
  if (_authCache && _authCache.cred === cred && Date.now() - _authCache.at < CACHE_TTL) return _authCache.ok;
  let ok = false;
  try {
    // Cheap authenticated GET; callConvex throws on 401/403 and attaches the same credentials real calls use.
    await callConvex("/automations/list", "GET", undefined, "tier_check", 8000, true);
    ok = true;
  } catch { ok = false; }
  _authCache = { ok, at: Date.now(), cred };
  return ok;
}

export async function getTier(): Promise<Tier> {
  if (await credentialIsValid()) return "holder";
  if (_cache && Date.now() - _cache.at < CACHE_TTL) return _cache.tier;

  try {
    const wallet = await getOrCreateWallet();
    const balance = await erc20BalanceOf(wallet.address);
    const tier: Tier = balance >= MIN_BALANCE ? "holder" : "basic";
    _cache = { tier, at: Date.now() };
    return tier;
  } catch {
    // RPC unreachable - fail closed to the basic tier
    return "basic";
  }
}

// Tools that require FINCH token to unlock
export const PREMIUM_TOOLS = new Set<string>([
  // Simulation
  "miroshark_simulate", "miroshark_status", "miroshark_stop",
  // AI analysis
  "market_thesis", "trade_plan",
  // Advanced memory
  "memory_insight", "memory_extract", "memory_consolidate",
  // Automations
  "create_automation", "run_automation", "pause_automation", "delete_automation", "get_automation_runs",
  // Autonomous monitors
  "schedule_research",
  // Persistent agents
  "agent_spawn", "agent_recall", "agent_update",
]);

export function tokenGateError(toolName: string): ToolResult {
  return {
    content: [{
      type: "text",
      text: [
        "🔒 **Premium Tool**",
        "",
        `\`${toolName}\` requires a valid Finch account or FINCH token.`,
        "",
        "**Option 1 - Sign in (easiest):**",
        "1. Go to finchagentic.com and create an API key (Settings → API Keys)",
        "2. Add to your MCP config: `FINCH_API_KEY=finch_sk_…` (or run `finch login`)",
        "   (the key is validated with the Finch backend - a made-up value does not unlock anything)",
        "",
        `**Option 2 - Hold FINCH on Robinhood Chain (${FINCH_RH_CHAIN_ID}):**`,
        `1. Get FINCH  -  CA: \`${FINCH_RH_ADDRESS}\``,
        "2. Hold at least 1 FINCH in your local wallet",
        "3. Access unlocks automatically",
        "",
        "Run `finch_status` to check your current tier.",
      ].join("\n"),
    }],
    isError: true,
  };
}
