import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";

// MCP tool annotation hints (spec 2025-06-18): readOnlyHint (no state
// change), destructiveHint (irreversible - delete/cancel/move funds),
// idempotentHint (safe to re-run with same args), openWorldHint (touches an
// external system). Default here is read-only + open-world; mutating tools
// opt out below. Single injection point (withAnnotations) instead of
// scattering this across 25 tool files.

type Ann = NonNullable<Tool["annotations"]>;

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
  if (READ_ONLY_LOCAL.has(name)) {
    return { readOnlyHint: true, openWorldHint: false };
  }
  return { readOnlyHint: true, openWorldHint: true };
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
export const MUTATING_TOOL_NAMES: readonly string[] = [
  ...WRITE_IDEMPOTENT,
  ...WRITE,
  ...DESTRUCTIVE,
  ...READ_ONLY_LOCAL,
];
