// Shared terminal UI: ANSI palette, the startup banner, post-login success
// block, spinner, in-REPL help text, and the npm update check.

import { readConfig } from "./config.js";
import { TOTAL_TOOL_COUNT, PKG_VERSION, getLocalWalletAddress } from "./cli-env.js";

// ── ANSI ─────────────────────────────────────────────────────────────────────
export const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  violet: "\x1b[35m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  white:  "\x1b[97m",
  bg:     "\x1b[48;5;17m",
};

// ── Banner ────────────────────────────────────────────────────────────────────
//
//   ███╗   ██╗ ██████╗ ███████╗██╗      ██████╗██╗      █████╗ ██╗    ██╗
//   ████╗  ██║██╔═══██╗██╔════╝██║     ██╔════╝██║     ██╔══██╗██║    ██║
//   ██╔██╗ ██║██║   ██║█████╗  ██║     ██║     ██║     ███████║██║ █╗ ██║
//   ██║╚██╗██║██║   ██║██╔══╝  ██║     ██║     ██║     ██╔══██║██║███╗██║
//   ██║ ╚████║╚██████╔╝███████╗███████╗╚██████╗███████╗██║  ██║╚███╔███╔╝
//   ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝

const LOGO_LINES = [
  `  ███████╗ ██╗ ███╗   ██╗  ██████╗ ██╗  ██╗`,
  `  ██╔════╝ ██║ ████╗  ██║ ██╔════╝ ██║  ██║`,
  `  █████╗   ██║ ██╔██╗ ██║ ██║      ███████║`,
  `  ██╔══╝   ██║ ██║╚██╗██║ ██║      ██╔══██║`,
  `  ██║      ██║ ██║ ╚████║ ╚██████╗ ██║  ██║`,
  `  ╚═╝      ╚═╝ ╚═╝  ╚═══╝  ╚═════╝ ╚═╝  ╚═╝`,
];

export const SEP = `  ${"─".repeat(70)}`;

export function buildBanner(): string {
  const cfg = readConfig();
  // Every base_mcp_*/rh_mcp_* tool signs locally via getOrCreateWallet()
  // (~/.finch/wallet.json) on BOTH Base and Robinhood Chain (RH reuses the
  // same local address) - this CLI never touches the account's custodial
  // webapp wallet. Showing that other address here would mismatch what
  // every tool call actually reports and operates on.
  const walletAddr = getLocalWalletAddress();
  const provider = process.env.BANKR_API_KEY ? "Bankr"
    : process.env.ANTHROPIC_API_KEY ? "Anthropic"
    : process.env.OPENAI_API_KEY ? "OpenAI"
    : "Finch proxy";

  const logo = LOGO_LINES.map(l => `${C.cyan}${C.bold}${l}${C.reset}`).join("\n");

  // ── meta row ──
  const meta = `\n${SEP}\n  ${C.dim}v${PKG_VERSION}  ·  ${TOTAL_TOOL_COUNT} tools  ·  finchagentic.com${C.reset}\n${SEP}`;

  // ── auth block ──
  let authBlock: string;
  if (cfg.sessionToken) {
    const displayName = cfg.name ? `${C.white}${C.bold}${cfg.name}${C.reset}` : "";
    const displayEmail = cfg.email ? `${C.dim}${cfg.email}${C.reset}` : "";
    const nameLine = displayName
      ? `  ${C.green}●${C.reset}  ${displayName}  ${displayEmail}`
      : `  ${C.green}●${C.reset}  ${displayEmail || `${C.green}Signed in${C.reset}`}`;
    const walletNote = "Base + Robinhood Chain · local device wallet · keys never leave your machine";
    const walletLine = walletAddr
      ? `     ${C.dim}Wallet${C.reset}  ${C.cyan}${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}${C.reset}  ${C.dim}· ${walletNote}${C.reset}`
      : `     ${C.dim}Wallet  not created yet · auto-creates on first DeFi call${C.reset}`;
    const llmLine = `     ${C.dim}LLM     ${C.reset}${C.green}${provider}${C.reset}  ${C.dim}· ${TOTAL_TOOL_COUNT} tools active${C.reset}`;
    authBlock = `\n${nameLine}\n${walletLine}\n${llmLine}`;
  } else {
    authBlock = [
      ``,
      `  ${C.yellow}○${C.reset}  ${C.yellow}Not signed in${C.reset}  ${C.dim}- tools that need your account will fail${C.reset}`,
      `     ${C.dim}Run ${C.reset}${C.cyan}/login${C.reset}${C.dim} to unlock all ${TOTAL_TOOL_COUNT} tools${C.reset}`,
      `     ${C.dim}LLM  ${provider}  · basic tools still work${C.reset}`,
    ].join("\n");
  }

  const hint = `\n${SEP}\n  ${C.dim}Type anything to chat · /help · Ctrl+C to exit${C.reset}\n`;

  return `\n${logo}\n${meta}\n${authBlock}\n${hint}`;
}

// ── Post-login success block ──────────────────────────────────────────────────
export function printLoginSuccess({ email, name }: { email: string; name?: string; walletAddress?: string }): void {
  // Always show the local per-device wallet: every base_mcp_*/rh_mcp_* tool
  // signs with it on BOTH chains. The account's custodial webapp wallet is a
  // separate address this CLI never touches - showing it here would mismatch
  // what every subsequent tool call actually reports.
  const walletAddr = getLocalWalletAddress();
  const displayName = name ?? "";

  console.log(`\n${SEP}`);
  if (displayName) {
    console.log(`  ${C.green}✓${C.reset}  ${C.white}${C.bold}${displayName}${C.reset}  ${C.dim}${email}${C.reset}`);
  } else {
    console.log(`  ${C.green}✓${C.reset}  ${C.green}${C.bold}Signed in${C.reset}  ${C.dim}as ${email}${C.reset}`);
  }
  if (walletAddr) {
    const note = "Base + Robinhood Chain · local device wallet";
    console.log(`     ${C.dim}Wallet${C.reset}  ${C.cyan}${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}${C.reset}  ${C.dim}· ${note}${C.reset}`);
  } else {
    console.log(`     ${C.dim}Wallet  auto-creates on first DeFi tool call${C.reset}`);
  }
  console.log(`     ${C.dim}Token saved to ~/.finch/config.json${C.reset}`);
  console.log(`     ${C.dim}All ${TOTAL_TOOL_COUNT} tools unlocked${C.reset}`);
  console.log(`${SEP}\n`);
}

// ── Spinner ───────────────────────────────────────────────────────────────────
export function spinner(label: string): () => void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(`\r  ${C.dim}${frames[i % frames.length]} ${label}${C.reset}  `);
    i++;
  }, 80);
  return () => {
    clearInterval(iv);
    process.stdout.write("\r" + " ".repeat(label.length + 12) + "\r");
  };
}

// ── Help ─────────────────────────────────────────────────────────────────────
export function printHelp() {
  const cfg = readConfig();
  const authLine = cfg.email
    ? `  ${C.dim}Signed in as ${C.reset}${C.green}${cfg.email}${C.reset}`
    : `  ${C.yellow}⚠${C.reset}  ${C.dim}Not signed in - run /login to unlock all tools${C.reset}`;

  console.log(`
  ${C.cyan}Commands:${C.reset}
    /login     Sign in to unlock all ${TOTAL_TOOL_COUNT} tools
    /logout    Sign out and clear saved token
    /clear     Clear conversation history
    /tools     List all available tools
    /quit      Exit

${authLine}

  ${C.dim}Examples:
    remember that I prefer concise answers
    search the web for recent AI news
    save a note to my vault
    research "top AI agent frameworks in 2025"
    spawn an agent to monitor competitor releases weekly${C.reset}
`);
}

// ── Version check ─────────────────────────────────────────────────────────────
export async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch("https://registry.npmjs.org/@finchagentic/mcp/latest", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;
    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === PKG_VERSION) return;
    const sep = `  ${"─".repeat(58)}`;
    console.log(`\n${sep}`);
    console.log(`  ${C.yellow}⚠${C.reset}  Update available: ${C.yellow}v${PKG_VERSION}${C.reset} → ${C.cyan}v${latest}${C.reset}`);
    console.log(`     ${C.dim}npm install -g @finchagentic/mcp@${latest}${C.reset}  ${C.dim}or restart your MCP client${C.reset}`);
    console.log(`${sep}\n`);
  } catch {
    // silently ignore
  }
}
