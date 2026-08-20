#!/usr/bin/env node
// `finch` - interactive AI terminal + subcommands (install/login/doctor/
// setup/vault/orders/run). Each subcommand's flow lives in its own
// cli-*.ts sibling module; this file is the REPL loop (`main`) plus the
// argv dispatcher at the bottom.

import * as readline from "readline";
import { runAgent } from "./agent-loop.js";
import { ALL_TOOLS } from "./server.js";
import { isApiKey, readConfig, writeConfig } from "./config.js";
import type { ChatMessage } from "./llm.js";
import { warnIfNoPassphrase } from "./wallet.js";

import { TOTAL_TOOL_COUNT, CONVEX_SITE, PKG_VERSION, getLocalWalletAddress } from "./cli-env.js";
import { C, buildBanner, printHelp, spinner, checkForUpdate } from "./cli-ui.js";
import { loginFlow } from "./cli-login.js";
import { setupFlow } from "./cli-setup.js";
import { installFlow } from "./cli-install.js";
import { doctorFlow } from "./cli-doctor.js";
import { vaultFlow } from "./cli-vault.js";
import { ordersFlow } from "./cli-orders.js";

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Auto-login from env var if set and not already logged in
  const cfg = readConfig();
  const envKey = process.env.FINCH_API_KEY;
  if (!cfg.sessionToken && envKey && isApiKey(envKey)) {
    process.stdout.write(`  ${C.dim}Auto-login from FINCH_API_KEY...${C.reset} `);
    try {
      const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: envKey }),
      });
      const data = await res.json() as any;
      if (res.ok && data.token) {
        writeConfig({ sessionToken: data.token, email: data.email ?? "api-key-user", name: data.displayName ?? undefined, walletAddress: data.walletAddress });
        console.log(`${C.green}✓${C.reset} ${C.dim}Signed in as ${data.email}${C.reset}`);
      } else {
        console.log(`${C.red}✗${C.reset} ${C.dim}Invalid API key in env var${C.reset}`);
      }
    } catch (e) {
      console.log(`${C.red}✗${C.reset} ${C.dim}Login failed: ${(e as Error).message}${C.reset}`);
    }
  }

  process.stdout.write(buildBanner());
  // Once, here, so it doesn't interrupt the first tool reply mid-conversation.
  warnIfNoPassphrase();

  // Check for updates in background - shows after banner, doesn't block prompt
  checkForUpdate().catch(() => {});

  const history: ChatMessage[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}>${C.reset} `,
  });

  rl.prompt();

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }

    // Built-in commands
    if (line === "/quit" || line === "/exit") {
      console.log(`\n  ${C.dim}Goodbye.${C.reset}\n`);
      process.exit(0);
    }

    if (line === "/clear") {
      history.length = 0;
      console.log(`  ${C.dim}History cleared.${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (line === "/help") {
      printHelp();
      rl.prompt();
      return;
    }

    if (line === "/login") {
      rl.pause();
      // Create fresh readline for login — reusing rl causes input conflicts
      const loginRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await loginFlow(loginRl);
      loginRl.close();
      rl.resume();
      rl.prompt();
      return;
    }

    if (line === "/logout") {
      writeConfig({ sessionToken: undefined, email: undefined });
      console.log(`  ${C.dim}Logged out. Token cleared from ~/.finch/config.json${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (line === "/tools") {
      console.log(`\n  ${C.cyan}${ALL_TOOLS.length} tools:${C.reset}`);
      for (const t of ALL_TOOLS) {
        console.log(`  ${C.dim}·${C.reset} ${t.name}  ${C.dim}${(t.description as string ?? "").slice(0, 60)}${C.reset}`);
      }
      console.log();
      rl.prompt();
      return;
    }

    // Agent call
    const stop = spinner("thinking");

    try {
      const result = await runAgent(line, history, (toolName) => {
        stop();
        process.stdout.write(`  ${C.dim}✦ ${toolName}${C.reset}\n`);
      });

      stop();

      // Update conversation history (keep last 20 turns)
      history.push({ role: "user", content: line });
      history.push({ role: "assistant", content: result.text });
      while (history.length > 20) history.splice(0, 2);

      // Output
      console.log();
      const lines = result.text.split("\n");
      for (const l of lines) {
        console.log(`  ${l}`);
      }
      console.log();
    } catch (err: any) {
      stop();
      console.log(`\n  ${C.red}✗${C.reset} ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n  ${C.dim}Goodbye.${C.reset}\n`);
    process.exit(0);
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
const cmd = process.argv[2];

if (cmd === "install") {
  installFlow().catch((err) => {
    console.error(`  ${C.red}✗ install error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "login") {
  // loginFlow() already checks FINCH_API_KEY first and falls back to the
  // interactive prompt - no need to duplicate that check here.
  loginFlow().catch((err) => {
    console.error(`  ${C.red}✗ login error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "doctor") {
  doctorFlow().catch((err) => {
    console.error(`  ${C.red}✗ doctor error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "setup") {
  setupFlow().catch((err) => {
    console.error(`  ${C.red}✗ setup error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "vault") {
  vaultFlow();
} else if (cmd === "orders") {
  ordersFlow().catch((err) => {
    console.error(`  ${C.red}✗ orders error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "logout") {
  const cfg = readConfig();
  if (!cfg.sessionToken) {
    console.log(`\n  ${C.dim}Already signed out.${C.reset}\n`);
  } else {
    writeConfig({ sessionToken: undefined, email: undefined });
    console.log(`\n  ${C.green}✓${C.reset} Signed out${cfg.email ? ` (${cfg.email})` : ""}. Token cleared from ~/.finch/config.json\n`);
  }
} else if (cmd === "status") {
  const cfg = readConfig();
  // Every base_mcp_*/rh_mcp_* tool signs locally on BOTH chains - the
  // account's custodial webapp wallet is a separate address this CLI never
  // touches, so always show the local one to match what tools report.
  const walletAddr = getLocalWalletAddress();
  const provider = process.env.BANKR_API_KEY ? "Bankr"
    : process.env.ANTHROPIC_API_KEY ? "Anthropic"
    : process.env.OPENAI_API_KEY ? "OpenAI"
    : "Finch proxy";
  const SEP_S = `  ${"─".repeat(52)}`;
  console.log(`\n${SEP_S}`);
  if (cfg.sessionToken) {
    const displayName = cfg.name ? `${C.white}${C.bold}${cfg.name}${C.reset}  ` : "";
    const displayEmail = cfg.email ? `${C.dim}${cfg.email}${C.reset}` : "";
    console.log(`  ${C.green}●${C.reset}  ${displayName}${displayEmail}`);
    if (walletAddr) {
      const note = "Base + Robinhood Chain · local device wallet";
      console.log(`     ${C.dim}Wallet  ${C.reset}${C.cyan}${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}${C.reset}  ${C.dim}· ${note}${C.reset}`);
    } else {
      console.log(`     ${C.dim}Wallet  not created yet${C.reset}`);
    }
    console.log(`     ${C.dim}LLM     ${C.reset}${C.green}${provider}${C.reset}  ${C.dim}· ${TOTAL_TOOL_COUNT} tools · v${PKG_VERSION}${C.reset}`);
  } else {
    console.log(`  ${C.yellow}○${C.reset}  ${C.yellow}Not signed in${C.reset}`);
    console.log(`     ${C.dim}→ run \`finch login\` to unlock all ${TOTAL_TOOL_COUNT} tools${C.reset}`);
    console.log(`     ${C.dim}LLM  ${provider}  · v${PKG_VERSION}${C.reset}`);
  }
  console.log(`${SEP_S}\n`);
} else if (cmd === "run") {
  const prompt = process.argv.slice(3).join(" ");
  if (!prompt) {
    console.error(`  ${C.red}✗ usage: finch run "your prompt"${C.reset}\n`);
    process.exit(1);
  }
  warnIfNoPassphrase();
  (async () => {
    const history: ChatMessage[] = [];
    const stop = spinner("thinking");
    try {
      const result = await runAgent(prompt, history, (toolName) => {
        stop();
        process.stdout.write(`  ${C.dim}✦ ${toolName}${C.reset}\n`);
      });
      stop();
      console.log(`\n${result.text}\n`);
    } catch (err: any) {
      stop();
      console.error(`  ${C.red}✗ run error: ${err.message || err}${C.reset}\n`);
      process.exit(1);
    }
  })();
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`
  ${C.cyan}${C.bold}finch${C.reset}  ${C.dim}runtime layer for Agentic AI · terminal CLI${C.reset}

  ${C.cyan}Commands:${C.reset}
    finch              Start interactive AI terminal
    finch run "..."    Run a single prompt and exit (scripting/CI-friendly)
    finch install      Auto-configure all detected MCP clients
    finch login        Sign in to unlock all tools
    finch logout       Sign out and clear saved token
    finch status       Show auth state and version (quick check)
    finch doctor       Run a full health check + suggest fixes
    finch setup        Configure your own LLM key and/or local memory + vault
    finch vault        Show your local vault (location, contents, backup)
    finch orders       Run/schedule Robinhood Chain DCA & TP-SL order ticks
    finch help         Show this help

  ${C.dim}Claude Code / Cursor / Windsurf / Codex / Aeon / Antigravity / Zed — anywhere MCP runs.${C.reset}
`);
} else {
  main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
