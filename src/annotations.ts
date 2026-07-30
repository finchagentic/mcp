import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";

// MCP tool annotations (spec 2025-06-18). These are behavioural HINTS, not
// guarantees - clients use them to decide auto-approval, confirmation prompts
// and how a tool is presented:
//   readOnlyHint    - the tool does not modify any state. A client may run it
//                     without asking. NEVER set this true for a tool that can
//                     write, delete, move funds or otherwise act.
//   destructiveHint - the tool may perform an irreversible/destructive update
//                     (delete, cancel, publish-forever, move money). Only
//                     meaningful when readOnlyHint is false.
//   idempotentHint  - calling again with the same args adds no further effect
//                     (a toggle/upsert). Only meaningful when readOnlyHint is
//                     false.
//   openWorldHint   - the tool interacts with external entities (our backend,
//                     a chain, an LLM, the web) rather than a closed local set.
//
// Design: the DEFAULT for any tool not named below is read-only + open-world,
// because the overwhelming majority of finch tools are reads that hit the
// backend / a chain / an LLM. Only mutating tools opt out. Deletes, cancels and
// anything that moves money or publishes irreversibly are flagged destructive
// so a client prompts before running them.
//
// A single injection point (withAnnotations, applied in the tools/list handler)
// keeps this classification in one reviewable file instead of scattered across
// 25 tool modules. Any tool that ships its own `annotations` is left untouched.

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
  "agent_schedule",
  "agent_pause",
  "agent_resume",
  "agent_unschedule",
  "pause_automation",
  "vault_link",
  "vault_pin",
  "vault_tag",
  "vault_unpublish",
]);

// readOnly=false, destructive=false.
// Additive writes / new resources: they create or append, they don't destroy.
// (hire_agent is deliberately NOT here: it only returns a specialist persona
// scoped to the caller's task - it reads, it does not write - so it stays in
// the read-only default.)
const WRITE = new Set<string>([
  "agent_spawn",
  "chronicle_add",
  "create_automation",
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
  "memory_publish", // "IRREVERSIBLE, PUBLIC" per its own description
  "packet_share", // "copies already taken remain" per its own description - same risk class as memory_publish
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
  "rh_orders_tick", // preview by default, but can execute:true and move funds
  // executors that run other (possibly fund-moving) tools
  "run_automation",
  "run_playbook",
  "packet_run",
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
