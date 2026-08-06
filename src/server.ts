import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PaymentRequiredError, buildPaymentHeader } from "./convex.js";
import { listVaultResources, readVaultResource } from "./resources.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { filterTools } from "./tool-filter.js";
import { withAnnotations } from "./annotations.js";

// Read version from package.json so the server announces the same version
// MCP clients see in the npm tarball. Falls back to "unknown" if the file
// can't be loaded - never blocks server startup.
const PKG_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
import { MARKET_TOOLS, handleMarketTool } from "./tools/market.js";
import { DEFI_TOOLS, handleDefiTool } from "./tools/defi.js";
import { AUTOMATION_TOOLS, handleAutomationTool } from "./tools/automation.js";
import { INSIGHT_TOOLS, handleInsightTool } from "./tools/insight.js";
// tools/framework.ts removed - list_playbooks, run_playbook and
// get_finch_ledger called /framework/playbooks, /framework/playbook/run and
// /swarm/ledger, none of which are registered in app/convex/http.ts (only
// dangling section-header comments) and none of which have a backing data
// model (no playbook table, no Sentinel ledger table in schema.ts). All 3
// tools always 404'd. Re-add only alongside building the Noel Framework
// playbook/Sentinel backend for real.
import { WALLET_TOOLS, handleWalletTool } from "./tools/wallet.js";
import { VAULT_TOOLS, handleVaultTool } from "./tools/vault.js";
import { MIROSHARK_TOOLS, handleMirosharkTool } from "./tools/miroshark.js";
import { AGENT_TOOLS, handleAgentTool } from "./tools/agents.js";
import { SCANNER_TOOLS, handleScannerTool } from "./tools/scanner.js";
import { CODER_TOOLS, handleCoderTool } from "./tools/coder.js";
import { EQUITY_TOOLS, handleEquityTool } from "./tools/equity.js";
import { INSIDER_TOOLS, handleInsiderTool } from "./tools/insider.js";
import { EVENT_TOOLS, handleEventTool } from "./tools/events.js";
import { BASE_TOOLS, handleBaseTool } from "./tools/base.js";
import { BASE_MCP_TOOLS, handleBaseMcpTool } from "./tools/base-mcp.js";
import { RH_MCP_TOOLS, handleRhMcpTool } from "./tools/rh-mcp.js";
import { RH_ORDER_TOOLS, handleRhOrderTool } from "./tools/rh-orders.js";
import { BRIDGE_TOOLS, handleBridgeTool } from "./tools/rh-bridge.js";
import { MEMORY_TOOLS, handleMemoryTool } from "./tools/memory.js";
import { OS_TOOLS, handleOsTool } from "./tools/os.js";
import { RESEARCH_TOOLS, handleResearchTool } from "./tools/research.js";
import { DEEP_RESEARCH_TOOLS, handleDeepResearch } from "./tools/deep-research.js";
import { RESEARCH_COMPARE_TOOLS, handleResearchCompare } from "./tools/research-compare.js";
import { RESEARCH_CHAIN_TOOLS, handleResearchChain } from "./tools/research-chain.js";
import { MONITOR_TOOLS, handleMonitorTool } from "./tools/monitor.js";
import { GITHUB_TOOLS, handleGithubTool } from "./tools/github.js";
import { CHRONICLE_TOOLS, handleChronicle } from "./tools/chronicle.js";
import { PACKET_TOOLS, handlePacket } from "./tools/packets.js";
import { STAKE_TOOLS, handleStakeTool } from "./tools/stake.js";
import { getTier, PREMIUM_TOOLS, tokenGateError } from "./token-gate.js";

const PRIVATE_KEY_RESPONSE = {
  content: [{
    type: "text" as const,
    text: "I don't have access to your private key. Your wallet is secured by Finch's encrypted vault. Only you can manage it at finchagentic.com",
  }],
};

function containsSensitiveRequest(args: unknown): boolean {
  const text = JSON.stringify(args ?? "").toLowerCase();
  return (
    text.includes("private key") ||
    text.includes("seed phrase") ||
    text.includes("mnemonic") ||
    text.includes("privatekey")
  );
}

export const ALL_TOOLS = [
  ...MARKET_TOOLS,       // 6 - get_market_data, get_token_data, compare_tokens, market_overview, token_history, get_base_token_data
  ...INSIGHT_TOOLS,      // 3 - ask_finch, market_thesis, trade_plan
  ...DEFI_TOOLS,         // 1 - get_defi_yields (swap/send/portfolio/estimate/analyze moved to base_mcp_* in v3.17.5)
  ...AUTOMATION_TOOLS,   // 6 - create, list, pause, delete, get_runs, run
  // SWARM_TOOLS removed v3.19 - multi-agent research is now built into
  // deep_research (depth=standard|deep). Handler fully removed v3.21.
  // FRAMEWORK_TOOLS removed - list_playbooks/run_playbook/get_finch_ledger backend routes never existed, see tools/ import comment above.
  ...VAULT_TOOLS,        // 17 - save, code_session_save, read, list, search, history, diff, export, pin, unpublish, tag, delete, link, related, store_credential, get_credential, list_projects
  ...WALLET_TOOLS,       // 3 - get_wallet_address, get_wallet_balance, wallet_sign_message
  ...MIROSHARK_TOOLS,    // 3 - simulate, status, stop
  ...AGENT_TOOLS,        // 4 - agent_spawn, agent_recall, agent_update, agent_ledger (vault-backed, all working). list_agents/hire_agent and the autonomous-schedule tools (agent_identity/agent_schedule/agent_unschedule/agent_pause/agent_resume/agent_runs) removed - their backend routes were never implemented, see tools/agents.ts
  ...SCANNER_TOOLS,      // 3 - score_token, check_token, scan_market (dips+momentum merged)
  ...EQUITY_TOOLS,       // 1 - stock_fundamentals (SEC EDGAR XBRL; no key)
  ...INSIDER_TOOLS,      // 1 - stock_insider (SEC Form 4; separates discretionary from automatic)
  ...EVENT_TOOLS,        // 1 - stock_events (SEC 8-K item codes decoded)
  ...CODER_TOOLS,        // 1 - audit_contract (static Solidity scan; the client model does the reasoning)
  ...BASE_TOOLS,         // 4 - base_mcp_yield_vaults, base_mcp_lending_rates, base_mcp_deposit_guide, base_mcp_network
  ...BASE_MCP_TOOLS,     // 7 - base_mcp_{status,balance,send,swap,estimate,lend,resolve} (analyze removed v3.17.5 - dead backend route)
  ...RH_MCP_TOOLS,       // 8 - rh_mcp_{status,list_stocks,balance,estimate,swap} + rh_token_resolve, rh_analyze, rh_safety_check (RH Chain 4663 Uni V4: stocks + arbitrary crypto via DexScreener/Blockscout)
  ...RH_ORDER_TOOLS,     // 5 - rh_dca_create, rh_bracket_create, rh_orders_list, rh_order_cancel, rh_orders_tick (RH automated DCA/TP/SL)
  ...BRIDGE_TOOLS,       // 1 - rh_stock_bridge (tokenized stock vs real equity)
  ...MEMORY_TOOLS,       // 9 - memory_add, memory_search, memory_context, memory_profile, memory_list, memory_delete, memory_insight, memory_extract, memory_consolidate. memory_publish removed - promised a "Memory Marketplace" that doesn't exist at any layer (no browse route, no query, no UI), see tools/memory.ts
  ...OS_TOOLS,           // 3 - finch_status, finch_diagnostics, finch_shell_chat
  ...RESEARCH_TOOLS,       // 2 - web_scrape, web_search
  ...DEEP_RESEARCH_TOOLS,    // 1 - deep_research (search → scrape → rank → cited evidence pack; caller synthesises)
  ...RESEARCH_COMPARE_TOOLS, // 1 - research_compare (diff two reports across time)
  ...RESEARCH_CHAIN_TOOLS,   // 1 - research_chain (walk continueFrom evolution timeline)
  ...MONITOR_TOOLS,        // 3 - schedule_research, list_monitors, cancel_monitor
  ...GITHUB_TOOLS,       // 8 - list_repos, list_prs, get_pr, list_issues, get_issue, get_file, get_commits, search_code
  ...CHRONICLE_TOOLS,    // 4 - chronicle_add, chronicle_list, chronicle_search, chronicle_stats
  ...PACKET_TOOLS,       // 4 - packet_create, packet_run, packet_list, packet_share
  ...STAKE_TOOLS,        // 5 - stake_finch_status, stake_finch, unstake_finch, claim_vested_rewards, stake_auto_restake (custodial wallet; requires `finch login`)
  // total: 116 tools as measured by ALL_TOOLS.length - do not hand-maintain a
  // count in this comment (drifted stale multiple times already: before
  // staking was added, after the P1 audit removed 9 dead framework/agent-
  // schedule tools, after memory_publish was removed for promising a
  // marketplace that doesn't exist, after stake_auto_restake was added,
  // after claim_vested_rewards was added to close the gap where the
  // stake-lifecycle notification told users to "run claimVestedRewards" but
  // no MCP tool by that name existed, after code_session_save was added so
  // coding sessions persist the same way deep_research already auto-saves
  // research, and after list_projects was added alongside `workspaceProject`
  // support on vault_save/agent_spawn - MCP tools can now file into the same
  // Projects the webapp Agents page organizes by, resolved/auto-created
  // server-side via POST /projects/resolve; ALL_TOOLS.length is the only
  // number that can't lie). Per-category counts above are best-effort
  // documentation, not load-bearing anywhere.
];

// Build O(1) dispatch map at startup - avoids sequential chained awaits per call
export type Handler = (name: string, args: unknown) => Promise<import("./types.js").ToolResult | null>;
export const HANDLER_MAP = new Map<string, Handler>([
  ...MARKET_TOOLS.map(t      => [t.name, handleMarketTool]      as [string, Handler]),
  ...DEFI_TOOLS.map(t        => [t.name, handleDefiTool]        as [string, Handler]),
  ...AUTOMATION_TOOLS.map(t  => [t.name, handleAutomationTool]  as [string, Handler]),
  ...VAULT_TOOLS.map(t       => [t.name, handleVaultTool]       as [string, Handler]),
  ...WALLET_TOOLS.map(t      => [t.name, handleWalletTool]      as [string, Handler]),
  ...INSIGHT_TOOLS.map(t     => [t.name, handleInsightTool]     as [string, Handler]),
  ...MIROSHARK_TOOLS.map(t   => [t.name, handleMirosharkTool]   as [string, Handler]),
  ...AGENT_TOOLS.map(t       => [t.name, handleAgentTool]       as [string, Handler]),
  ...SCANNER_TOOLS.map(t     => [t.name, handleScannerTool]     as [string, Handler]),
  ...CODER_TOOLS.map(t       => [t.name, handleCoderTool]       as [string, Handler]),
  ...EQUITY_TOOLS.map(t      => [t.name, handleEquityTool]      as [string, Handler]),
  ...INSIDER_TOOLS.map(t     => [t.name, handleInsiderTool]     as [string, Handler]),
  ...EVENT_TOOLS.map(t       => [t.name, handleEventTool]       as [string, Handler]),
  ...BASE_TOOLS.map(t        => [t.name, handleBaseTool]        as [string, Handler]),
  ...BASE_MCP_TOOLS.map(t    => [t.name, handleBaseMcpTool]    as [string, Handler]),
  ...RH_MCP_TOOLS.map(t      => [t.name, handleRhMcpTool]       as [string, Handler]),
  ...RH_ORDER_TOOLS.map(t    => [t.name, handleRhOrderTool]     as [string, Handler]),
  ...BRIDGE_TOOLS.map(t      => [t.name, handleBridgeTool]      as [string, Handler]),
  ...MEMORY_TOOLS.map(t      => [t.name, handleMemoryTool]      as [string, Handler]),
  ...OS_TOOLS.map(t          => [t.name, handleOsTool]           as [string, Handler]),
  ...RESEARCH_TOOLS.map(t      => [t.name, handleResearchTool]   as [string, Handler]),
  ...DEEP_RESEARCH_TOOLS.map(t   => [t.name, handleDeepResearch]    as [string, Handler]),
  ...RESEARCH_COMPARE_TOOLS.map(t => [t.name, handleResearchCompare] as [string, Handler]),
  ...RESEARCH_CHAIN_TOOLS.map(t   => [t.name, handleResearchChain]   as [string, Handler]),
  ...MONITOR_TOOLS.map(t       => [t.name, handleMonitorTool]    as [string, Handler]),
  ...GITHUB_TOOLS.map(t      => [t.name, handleGithubTool]       as [string, Handler]),
  ...CHRONICLE_TOOLS.map(t   => [t.name, (n: string, a: unknown) => handleChronicle(n, a as Record<string, unknown>)] as [string, Handler]),
  ...PACKET_TOOLS.map(t      => [t.name, (n: string, a: unknown) => handlePacket(n, a as Record<string, unknown>)] as [string, Handler]),
  ...STAKE_TOOLS.map(t       => [t.name, handleStakeTool]       as [string, Handler]),
]);

// `instructions` is returned in the initialize result - it tells the client
// (and, through it, the model) what this server is and how to reach for it.
// Kept short: clients surface it as system context, so it pays a token cost on
// every session.
const SERVER_INSTRUCTIONS = [
  "Finch is the runtime layer for agentic AI: persistent memory, autonomous",
  "agents, a versioned vault, scheduled workflows, live market data, deep",
  "research, DeFi on Base (base_mcp_*), and Robinhood Chain trading (rh_*).",
  "",
  "Tool annotations are set: read-only tools are safe to run without asking;",
  "tools with destructiveHint (deletes, cancels, packet_share, and anything",
  "that moves funds - base_mcp_swap/send, rh_mcp_swap, rh_dca_create,",
  "rh_bracket_create, run_automation, packet_run, stake_finch,",
  "unstake_finch) should be confirmed with the user before running.",
  "",
  "Vault entries are also exposed as resources (finch://vault/<key>); prefer",
  "reading those over a vault_read tool call when you only need the content.",
  "This server never has access to private keys or seed phrases - the wallet is",
  "custodial and secured server-side.",
].join("\n");

export const server = new Server(
  { name: "finch", version: PKG_VERSION },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// Tool listing respects FINCH_TOOLS for users who want a smaller surface.
// withAnnotations attaches MCP behavioural hints (readOnly/destructive/etc) so
// clients can auto-run reads and prompt before destructive/fund-moving calls.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: withAnnotations(filterTools(ALL_TOOLS)),
}));

// MCP Resources - vault entries surface as `finch://vault/<key>`.
// Clients can pull them via the standard resource flow instead of a Tool
// call, saving per-call schema cost. Listing is best-effort: it never
// throws to avoid breaking the initial handshake on transient backend
// errors.
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  // MCP cursor pagination - clients pass `cursor` from the previous response's
  // `nextCursor` to walk past the first 50 entries.
  const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
  return listVaultResources(cursor);
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return readVaultResource(request.params.uri);
});

// MCP Prompts - high-leverage workflows surface as slash commands in
// supporting clients (Claude Desktop, Cursor, Windsurf, Zed).
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listPrompts(),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, string>;
  return getPrompt(request.params.name, args);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (containsSensitiveRequest(args)) return PRIVATE_KEY_RESPONSE;

  if (PREMIUM_TOOLS.has(name)) {
    const tier = await getTier();
    if (tier === "basic") return tokenGateError(name);
  }

  // ─── MCP progress notifications ─────────────────────────────────────────
  // Clients can opt into live progress events by sending `_meta.progressToken`
  // on the call. For long-running tools like deep_research we route through
  // a streaming handler that emits per-stage notifications. Clients that
  // don't pass a token get the standard request/response (no behavior change).
  const progressToken = (request.params as any)._meta?.progressToken;
  if (progressToken && name === "deep_research") {
    let step = 0;
    const onProgress = async (message: string, totalSteps?: number) => {
      step += 1;
      try {
        await server.notification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: step,
            total: totalSteps,
            message,
          },
        });
      } catch {
        // notifications are best-effort - never block the tool
      }
    };
    try {
      const result = await handleDeepResearch(name, args, onProgress);
      if (result) return result;
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }

  const handler = HANDLER_MAP.get(name);
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const result = await handler(name, args);
    if (result) return result;
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err: any) {
    if (err instanceof PaymentRequiredError) {
      const d = (err.details as any)?.paymentDetails;
      const lines = [
        "⚠️ **Payment Required**", "",
        "This tool requires a USDC micropayment on Base mainnet.",
        ...(d ? [
          ``, `Amount: **${d.amount} USDC**`, `To: \`${d.address}\``, `Request ID: \`${d.requestId}\``, ``,
          "**To pay:**",
          `1. Send ${d.amount} USDC to \`${d.address}\` on Base mainnet`,
          `2. Copy the transaction hash`,
          `3. Set env var: \`FINCH_PAYMENT_HEADER=${buildPaymentHeader("<txHash>", d.requestId)}\``,
          `   (replace \`<txHash>\` with the actual transaction hash)`,
          `4. Retry the tool call`, ``,
          "**Or bypass with a session token:**",
          "Set `FINCH_SESSION_TOKEN` with your Finch session token from finchagentic.com",
        ] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
    }
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
