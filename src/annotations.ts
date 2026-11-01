import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";

// MCP tool annotation hints (spec 2025-06-18): readOnlyHint (no state
// change), destructiveHint (irreversible - delete/cancel/move funds),
// idempotentHint (safe to re-run with same args), openWorldHint (touches an
// external system). Default here is FAIL-CLOSED (destructive); every tool is
// classified explicitly below. Single injection point (withAnnotations) instead of
// scattering this across 25 tool files.

type Ann = NonNullable<Tool["annotations"]>;

// Read-only, open-world (touch an external system but change nothing). EVERY read-only tool must be
// listed here by name: annotationsFor() is fail-closed, so a tool missing from all sets is treated as
// destructive and clients will confirm before running it. test/annotations-failclosed.test.ts enforces
// that every registered tool has an explicit entry.
const READ_ONLY_OPEN = new Set<string>([
  "get_market_data",
  "get_token_data",
  "compare_tokens",
  "market_overview",
  "token_history",
  "get_base_token_data",
  "ask_finch",
  "market_thesis",
  "trade_plan",
  "get_defi_yields",
  "list_automations",
  "get_automation_runs",
  "vault_read",
  "vault_list",
  "vault_search",
  "vault_history",
  "vault_diff",
  "vault_export",
  "vault_related",
  "list_projects",
  "get_wallet_address",
  "get_wallet_balance",
  "miroshark_status",
  "agent_recall",
  "agent_ledger",
  "score_token",
  "check_token",
  "scan_market",
  "stock_fundamentals",
  "stock_insider",
  "stock_events",
  "base_mcp_yield_vaults",
  "base_mcp_lending_rates",
  "base_mcp_deposit_guide",
  "base_mcp_network",
  "base_mcp_status",
  "base_mcp_balance",
  "base_mcp_estimate",
  "base_mcp_lend",
  "base_mcp_resolve",
  "sol_balance",
  "sol_token_info",
  "sol_quote",
  "launchpad_pairs",
  "launchpad_launches",
  "launchpad_token",
  "rh_mcp_status",
  "rh_mcp_list_stocks",
  "rh_mcp_balance",
  "rh_mcp_estimate",
  "rh_token_resolve",
  "rh_analyze",
  "rh_safety_check",
  "rh_orders_list",
  "rh_stock_bridge",
  "memory_search",
  "memory_context",
  "memory_profile",
  "memory_list",
  "memory_insight",
  "finch_diagnostics",
  "web_scrape",
  "web_search",
  "deep_research",
  "research_compare",
  "research_chain",
  "list_monitors",
  "github_list_repos",
  "github_list_prs",
  "github_get_pr",
  "github_list_issues",
  "github_get_issue",
  "github_get_file",
  "github_get_commits",
  "github_search_code",
  "chronicle_list",
  "chronicle_search",
  "chronicle_stats",
  "packet_list",
  "stake_finch_status",
  "finch_status",
]);

// Reads that expose SECRETS. Not mutating, but a client must not auto-run them (a prompt-injected
// page could otherwise exfiltrate credentials): readOnlyHint=false so clients ask first.
const SENSITIVE_READ = new Set<string>([
  "vault_get_credential",
]);

// Read-only AND no network - a purely local computation (static analysis).
// Read-only but open-world is the default, so this set only exists to flip
// openWorldHint off for the rare offline tool.
const READ_ONLY_LOCAL = new Set<string>([
  "audit_contract", // deterministic static Solidity scan, no backend call
]);

// readOnly=false, destructive=false, idempotent=true.
// Toggles and upserts: re-running with the same args lands in the same state.
const WRITE_IDEMPOTENT = new Set<string>([
  "agent_update",
  "pause_automation",
  "stake_auto_restake",
  "vault_link",
  "vault_pin",
  "vault_tag",
  "vault_unpublish",
]);

// readOnly=false, destructive=false.
// Additive writes / new resources: they create or append, they don't destroy.
const WRITE = new Set<string>([
  "agent_spawn",
  "chronicle_add",
  "code_session_save",
  "memory_add",
  "sol_wallet", // creates the local keypair on first use
  "launchpad_wallet", // creates the local EVM wallet on first use
  "memory_extract",
  "memory_consolidate",
  "packet_create",
  "schedule_research",
  "vault_save",
  "vault_store_credential",
  "miroshark_simulate",
  "finch_shell_chat", // orchestrator: can spawn/save/create via delegated tools
]);

// readOnly=false, destructive=true.
// Deletes, cancels, irreversible publishes, and anything that moves real funds
// (or arms an order engine that will). Clients should confirm before running.
const DESTRUCTIVE = new Set<string>([
  // removals / cancels
  "cancel_monitor",
  "delete_automation",
  "memory_delete",
  "miroshark_stop",
  "rh_order_cancel",
  "vault_delete",
  // irreversible public exposure
  "packet_share", // "copies already taken remain" per its own description
  // money movement (Base)
  // NOTE: base_mcp_lend deliberately excluded - per its own description it
  // "Returns deposit INSTRUCTIONS only... Does NOT broadcast" - it's a read,
  // not a fund move, so it falls through to the read-only default below.
  "base_mcp_send",
  "base_mcp_swap",
  // off-chain signature that can itself authorise value movement (order,
  // session login) without any on-chain tx - same risk class as a real
  // transfer per its own tool description, so it belongs here rather than
  // in WRITE_IDEMPOTENT ("re-sign = same sig" is true but undersells the risk)
  "wallet_sign_message",
  // money movement (Robinhood Chain)
  "rh_mcp_swap",
  // money movement (Solana, local wallet)
  "sol_swap",
  "sol_send",
  "sol_launch_token",
  // money movement (Finch launchpad, local EVM wallet). A launch is irreversible and fixes the fee split forever.
  "launchpad_launch_token",
  "launchpad_buy",
  "launchpad_sell",
  "rh_dca_create", // arms recurring real buys
  "rh_bracket_create", // arms real TP/SL sells
  // a swap/send automation arms unattended, REPEATING real fund movement
  // (the backend's 1-minute cron evaluator fires it) - same risk class as
  // rh_dca_create/rh_bracket_create above, not a plain additive write. An
  // alert-only automation doesn't move funds, but the tool can't tell which
  // kind it's about to create until AFTER the backend parses rawInput, so
  // it's classified by its worst case, same reasoning as rh_orders_tick.
  "create_automation",
  "rh_orders_tick", // preview by default, but can execute:true and move funds
  // executors that run other (possibly fund-moving) tools
  "run_automation",
  "packet_run",
  // money movement (FINCH staking, custodial wallet) - stake locks real value
  // for a fixed period; unstake moves it (plus rewards) back
  "stake_finch",
  "unstake_finch",
  "claim_vested_rewards", // treasury -> custodial wallet USDG transfer
]);

export function annotationsFor(name: string): Ann {
  if (DESTRUCTIVE.has(name)) {
    return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  }
  if (WRITE_IDEMPOTENT.has(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  }
  if (WRITE.has(name)) {
    return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  }
  if (SENSITIVE_READ.has(name)) {
    // local or own-account vault, not an external system; still gated behind a user prompt.
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  }
  if (READ_ONLY_LOCAL.has(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (READ_ONLY_OPEN.has(name)) {
    return { readOnlyHint: true, openWorldHint: true };
  }
  // FAIL CLOSED: an unclassified tool is assumed to be destructive until someone classifies it.
  return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

// Decorate a tool list with MCP metadata: behavioural annotations
// (readOnly/destructive/etc) and, for tools registered in OUTPUT_SCHEMAS, a
// machine-readable `outputSchema`. A value already present on the tool is left
// untouched, so a module can always override either.
export function withAnnotations(tools: Tool[]): Tool[] {
  return tools.map((t) => {
    const patch: Partial<Tool> = {};
    if (!t.annotations) patch.annotations = annotationsFor(t.name);
    if (!t.outputSchema && OUTPUT_SCHEMAS[t.name]) {
      patch.outputSchema = OUTPUT_SCHEMAS[t.name] as Tool["outputSchema"];
    }
    return Object.keys(patch).length ? { ...t, ...patch } : t;
  });
}

// Exported for the test suite to assert the classification only references real
// tool names (catches typos / tools renamed out from under a set).
export function isExplicitlyClassified(name: string): boolean {
  return DESTRUCTIVE.has(name) || WRITE_IDEMPOTENT.has(name) || WRITE.has(name) || READ_ONLY_LOCAL.has(name) ||
    READ_ONLY_OPEN.has(name) || SENSITIVE_READ.has(name);
}

export const MUTATING_TOOL_NAMES: readonly string[] = [
  ...SENSITIVE_READ,
  ...WRITE_IDEMPOTENT,
  ...WRITE,
  ...DESTRUCTIVE,
  ...READ_ONLY_LOCAL,
];
