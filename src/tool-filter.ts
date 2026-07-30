import { Tool } from "@modelcontextprotocol/sdk/types.js";

// Tool-subset filter. Each user keeps the full handler map (so any tool
// can still be invoked by name if explicitly referenced), but the LIST
// response sent to MCP clients is trimmed based on FINCH_TOOLS.
//
// Default = "core" - runtime essentials only (memory, vault, agents,
// chronicle, status). Opt-in presets let token-conscious users cut LLM
// context cost while keeping the full surface accessible by name:
//
//   FINCH_TOOLS=core         runtime essentials (memory, vault, agents)
//   FINCH_TOOLS=defi         Base + market + DeFi execution
//   FINCH_TOOLS=research     research + memory + vault
//   FINCH_TOOLS=memory       memory + vault + agents only
//   FINCH_TOOLS=memory,defi  comma-separated combination
//   FINCH_TOOLS=all          every registered tool
//
// Unknown presets fall back to all to avoid silently hiding tools.

// Each preset's regex is checked against every tool name in ALL_TOOLS by
// tools-registration.test.ts (see "every tool matches at least one preset")
// - a tool that matches no preset's regex is invisible under every FINCH_TOOLS
// setting except "all", which happened silently to 33/121 tools before that
// test existed (rh_* order-management tools, all *_automation tools, packets,
// playbooks, wallet balance/sign, miroshark, stock_* - a user on
// FINCH_TOOLS=defi couldn't even see rh_order_cancel for an order placed
// through that same preset). New tools MUST match a preset or the test fails
// the build, instead of quietly vanishing like these did.
const PRESETS: Record<string, RegExp> = {
  core: /^(memory_|vault_|agent_|list_agents|hire_agent|ask_finch|finch_status|finch_diagnostics|finch_shell_chat|get_wallet_address|get_wallet_balance|wallet_sign_message|chronicle_|packet_)/,
  defi: /^(get_market_data|get_token_data|compare_tokens|market_overview|token_history|get_base_token_data|stock_fundamentals|stock_insider|stock_events|market_thesis|trade_plan|base_mcp_|rh_|base_|get_defi_yields|score_token|check_token|scan_market|analyze_wallet|get_wallet_balance|wallet_sign_message|create_automation|list_automations|pause_automation|delete_automation|get_automation_runs|run_automation|list_playbooks|run_playbook|get_finch_ledger|miroshark_)/,
  research: /^(memory_|vault_|deep_research|research_compare|research_chain|web_search|web_scrape|schedule_research|list_monitors|cancel_monitor|ask_finch|stock_fundamentals|stock_insider|stock_events)/,
  memory: /^(memory_|vault_|agent_|list_agents|hire_agent|chronicle_)/,
  coder: /^(audit_contract|github_)/,
};

export function filterTools(allTools: Tool[]): Tool[] {
  // Default is "core" - keeps LLM context cost low while everything
  // is still callable by name. Power users opt back in via
  // FINCH_TOOLS=all. Explicit empty env still means "all" for back-compat.
  const raw = (process.env.FINCH_TOOLS ?? "core").trim().toLowerCase();
  const env = raw === "" ? "core" : raw;
  if (env === "all") return allTools;

  const presetKeys = env.split(",").map((s) => s.trim()).filter(Boolean);
  const patterns = presetKeys
    .map((k) => PRESETS[k])
    .filter((p): p is RegExp => !!p);

  if (patterns.length === 0) {
    // Unknown preset(s) - surface full tool set rather than silently hide.
    return allTools;
  }

  return allTools.filter((t) => patterns.some((p) => p.test(t.name)));
}
