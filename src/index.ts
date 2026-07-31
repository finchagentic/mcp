#!/usr/bin/env node
import { startServer, ALL_TOOLS } from "./server.js";
import { filterTools } from "./tool-filter.js";
import { getOrCreateWallet } from "./wallet.js";
import { getSavedToken, hydrateEnvFromConfig, isApiKey, writeConfig } from "./config.js";
import { dedupClinkInput } from "./clink-input.js";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

// Always read the version from package.json so banner + boot strings stay in
// sync after every npm publish - no more hand-edits in three places.
const PKG_VERSION: string = (() => {
  try {
    // dist/index.js -> ../package.json (CJS so __dirname is available)
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const CONVEX_SITE = process.env.FINCH_CONVEX_URL ?? "https://befitting-porcupine-276.convex.site";

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  cyan:   "\x1b[36m",
  dim:    "\x1b[90m",
  white:  "\x1b[97m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
};

const BANNER = `
${C.cyan}
  ███╗   ██╗ ██████╗ ███████╗██╗      ██████╗██╗      █████╗ ██╗    ██╗
  ████╗  ██║██╔═══██╗██╔════╝██║     ██╔════╝██║     ██╔══██╗██║    ██║
  ██╔██╗ ██║██║   ██║█████╗  ██║     ██║     ██║     ███████║██║ █╗ ██║
  ██║╚██╗██║██║   ██║██╔══╝  ██║     ██║     ██║     ██╔══██║██║███╗██║
  ██║ ╚████║╚██████╔╝███████╗███████╗╚██████╗███████╗██║  ██║╚███╔███╔╝
  ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
${C.reset}`;

function line(label: string, value: string, color = C.cyan) {
  const pad = " ".repeat(Math.max(0, 12 - label.length));
  process.stderr.write(`  ${color}▸ ${label}${C.reset}${pad}${value}\n`);
}

function divider() {
  process.stderr.write(`  ${C.dim}${"─".repeat(58)}${C.reset}\n`);
}

async function checkForUpdate(current: string): Promise<void> {
  try {
    const res = await fetch("https://registry.npmjs.org/@finchagentic/mcp/latest", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;
    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === current) return;
    // Show update notice to stderr - visible in Claude Desktop logs and terminal.
    const sep = `  ${"─".repeat(58)}`;
    process.stderr.write(
      `\n${sep}\n` +
      `  ${C.yellow}⚠${C.reset}  Update available: ${C.yellow}v${current}${C.reset} → ${C.cyan}v${latest}${C.reset}\n` +
      `     ${C.dim}npm install -g @finchagentic/mcp@${latest}${C.reset}  ${C.dim}or restart your MCP client${C.reset}\n` +
      `${sep}\n\n`
    );
  } catch {
    // Non-blocking - silently ignore network errors
  }
}

async function main() {
  hydrateEnvFromConfig();
  process.stderr.write(BANNER);

  // ── Tool category groups derived from ALL_TOOLS ────────────────────────────
  // Categories are matched by prefix/name pattern against the actual tool
  // registry. Counts and "tools" strings are computed live, so adding or
  // removing a tool can never desync the banner from reality.
  type CatRule = { label: string; match: (name: string) => boolean };
  const CAT_RULES: CatRule[] = [
    { label: "Market",     match: n => /^(get_market_data|get_token_data|compare_tokens|market_overview|token_history|get_base_token_data|stock_fundamentals|stock_insider|stock_events)$/.test(n) },
    { label: "Insight",    match: n => /^(ask_finch|market_thesis|trade_plan)$/.test(n) },
    { label: "DeFi",       match: n => n === "get_defi_yields" },
    { label: "Base MCP",   match: n => n.startsWith("base_mcp_") },
    { label: "RH MCP",     match: n => n.startsWith("rh_") },
    { label: "Automation", match: n => /^(create_automation|list_automations|pause_automation|delete_automation|get_automation_runs|run_automation)$/.test(n) },
    { label: "Framework",  match: n => /^(list_playbooks|run_playbook|get_finch_ledger)$/.test(n) },
    { label: "Vault",      match: n => n.startsWith("vault_") },
    { label: "Wallet",     match: n => /^(get_wallet_address|get_wallet_balance|wallet_sign_message)$/.test(n) },
    { label: "MiroShark",  match: n => n.startsWith("miroshark_") },
    { label: "Scanner",    match: n => /^(scan_market|score_token|check_token)$/.test(n) },
    { label: "Agents",     match: n => n.startsWith("agent_") },
    { label: "Coder",      match: n => n === "audit_contract" },
    { label: "Memory",     match: n => n.startsWith("memory_") },
    { label: "OS",         match: n => /^(finch_status|finch_diagnostics|finch_shell_chat)$/.test(n) },
    { label: "Research",   match: n => /^(web_scrape|web_search|deep_research|research_compare|research_chain)$/.test(n) },
    { label: "Monitor",    match: n => /^(schedule_research|list_monitors|cancel_monitor)$/.test(n) },
    { label: "GitHub",     match: n => n.startsWith("github_") },
    { label: "Chronicle",  match: n => n.startsWith("chronicle_") },
    { label: "Packets",    match: n => n.startsWith("packet_") },
  ];

  const categories = CAT_RULES
    .map(rule => {
      const names = ALL_TOOLS.map(t => t.name).filter(rule.match);
      return { label: rule.label, count: names.length, tools: names.join(" · ") };
    })
    .filter(c => c.count > 0);

  const total = ALL_TOOLS.length;
  // What the connected client actually sees - the LIST response is filtered by
  // FINCH_TOOLS (default "core"). Showing this next to the registered total
  // stops the banner from claiming 121 while the client only sees the core set.
  const exposed = filterTools(ALL_TOOLS).length;
  const toolMode = process.env.FINCH_TOOLS ?? "core";

  divider();
  process.stderr.write(`\n`);

  // Tools don't run inference - the connected client's model does. A provider
  // is shown only because the CLI agent loop and scheduled agents use one; its
  // absence is the normal, fully-working state for an MCP client.
  const model   = process.env.FINCH_MODEL ?? "claude-haiku-4-5-20251001";
  const aiMode  = process.env.BANKR_API_KEY
    ? `Bankr  ${C.dim}${model}${C.reset}`
    : process.env.ANTHROPIC_API_KEY
    ? `Anthropic  ${C.dim}${model}${C.reset}`
    : process.env.OPENAI_API_KEY
    ? `OpenAI  ${C.dim}${model}${C.reset}`
    : `your client's model  ${C.dim}no key needed${C.reset}`;

  line("version", `v${PKG_VERSION}`);
  line("ai",       aiMode);
  const toolDetail = exposed === total
    ? `${C.white}${C.bold}${total} tools exposed${C.reset}  ${C.dim}across ${categories.length} categories${C.reset}`
    : `${C.white}${C.bold}${exposed} tools exposed${C.reset}  ${C.dim}(${toolMode} of ${total} registered · set FINCH_TOOLS=all for every tool)${C.reset}`;
  line("tools", toolDetail);

  process.stderr.write(`\n`);
  divider();
  process.stderr.write(`\n`);

  // ── Categories grid ────────────────────────────────────────────────────────
  for (const cat of categories) {
    const countStr = `${cat.count}`.padStart(2);
    process.stderr.write(
      `  ${C.dim}│${C.reset} ${C.cyan}${cat.label.padEnd(11)}${C.reset} ${C.dim}${countStr}x${C.reset}  ${C.dim}${cat.tools}${C.reset}\n`
    );
  }

  process.stderr.write(`\n`);
  divider();

  // ── Wallet + start ─────────────────────────────────────────────────────────
  await startServer();

  const hasAuth = !!getSavedToken();

  try {
    const wallet = await getOrCreateWallet();
    process.stderr.write(`\n`);
    line("wallet",  wallet.address);
    if (hasAuth) {
      line("auth",   `${C.green}signed in${C.reset}  ${C.dim}all ${ALL_TOOLS.length} tools unlocked${C.reset}`, C.green);
    } else {
      line("auth",   `${C.yellow}not signed in${C.reset}  ${C.dim}run 'finch login' to unlock premium tools${C.reset}`, C.yellow);
    }
    line("status",  `${C.green}ready${C.reset}  ${C.dim}waiting for MCP client...${C.reset}`, C.green);
    process.stderr.write(`\n`);
  } catch {
    process.stderr.write(`\n`);
    line("wallet",  `${C.yellow}not configured${C.reset}  ${C.dim}run 'finch login' to set up${C.reset}`, C.yellow);
    line("status",  `${C.green}ready${C.reset}  ${C.dim}wallet tools require setup${C.reset}`, C.green);
    process.stderr.write(`\n`);
  }

  // Check for updates async - fires 3s after startup so it doesn't delay boot
  setTimeout(() => { checkForUpdate(PKG_VERSION).catch(() => {}); }, 3_000);
}

// Interactive sign-in for the `finch-mcp login` path. Kept identical to the
// canonical `finch login` (cli.ts): both accept a Finch API key
// (finch_sk_...) and exchange it for a session token at /auth/apikey/login.
// Earlier this asked for a raw "session token" against /auth/me - a different
// credential users never actually generate, so the two bins disagreed on what
// "login" meant.
async function loginFlow() {
  process.stderr.write(`\n  ${C.cyan}▸ finch login${C.reset}\n\n`);
  process.stderr.write(`  Generate an API key at ${C.cyan}app.finchagentic.com${C.reset} → Settings → API Keys\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  let apiKey = await new Promise<string>((resolve) => {
    rl.question(`  API key (finch_sk_... / noel_sk_...): `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  // Deduplicate doubled input from a known Clink terminal bug + strip non-ASCII.
  apiKey = dedupClinkInput(apiKey).replace(/[^\x20-\x7E]/g, "").trim();

  if (!isApiKey(apiKey)) {
    process.stderr.write(`\n  ${C.yellow}✗ Invalid key — should start with finch_sk_ or noel_sk_${C.reset}\n\n`);
    process.exit(1);
  }

  try {
    const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as any;
    if (!res.ok || !data.token) {
      process.stderr.write(`\n  ${C.yellow}✗ ${data.error ?? "Invalid API key"} — check it at app.finchagentic.com${C.reset}\n\n`);
      process.exit(1);
    }
    writeConfig({ sessionToken: data.token, email: data.email, name: data.displayName ?? undefined });
    process.stderr.write(`\n  ${C.green}✓ Signed in as ${data.email ?? data.displayName ?? "user"}${C.reset}\n`);
    process.stderr.write(`  ${C.dim}Token saved to ~/.finch/config.json${C.reset}\n`);
    process.stderr.write(`  ${C.dim}All ${ALL_TOOLS.length} tools now unlocked.${C.reset}\n\n`);
  } catch (err: any) {
    process.stderr.write(`\n  ${C.red}✗ Login failed: ${err.message}${C.reset}\n\n`);
    process.exit(1);
  }

  process.exit(0);
}

const cmd = process.argv[2];
if (cmd === "login") {
  loginFlow().catch((err) => {
    process.stderr.write(`[finch] login error: ${err}\n`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    process.stderr.write(`[finch] fatal: ${err}\n`);
    process.exit(1);
  });
}
