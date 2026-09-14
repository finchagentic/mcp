// `finch doctor` - comprehensive health check. Detects broken installs and
// missing config in <5s; output is concise and tells the user exactly what
// to fix next. Designed to be the first command a new user runs after install.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readConfig } from "./config.js";
import { getLocalMemoryConfig, isLocalMemoryReachable } from "./local-memory.js";
import { C } from "./cli-ui.js";
import { CONVEX_SITE, TOTAL_TOOL_COUNT, CORE_TOOL_COUNT, PKG_VERSION } from "./cli-env.js";

type DoctorCheck = { name: string; status: "✓" | "✗" | "⚠"; detail: string; fix?: string };

export async function doctorFlow(): Promise<void> {
  console.log(`\n  ${C.cyan}${C.bold}finch doctor${C.reset}  ${C.dim}v${PKG_VERSION}${C.reset}\n`);
  console.log(`  ${C.dim}Running diagnostic - this takes ~5 seconds.${C.reset}\n`);

  const checks: DoctorCheck[] = [];
  const cfg = readConfig();
  const authHeader = cfg.sessionToken ? { Authorization: `Bearer ${cfg.sessionToken}` } : {};

  // 1. LLM provider
  const provider = process.env.BANKR_API_KEY ? "bankr"
    : process.env.ANTHROPIC_API_KEY ? "anthropic"
    : process.env.OPENAI_API_KEY ? "openai"
    : "finch-proxy";
  // Tools never call an LLM of their own - they return data and structure for
  // the calling model. A key is what makes *finch itself* a host: the CLI
  // agent loop and scheduled agents, which have no client model to borrow.
  checks.push({
    name: "LLM provider",
    status: "✓",
    detail: provider === "finch-proxy"
      ? `none set · all ${TOTAL_TOOL_COUNT} tools work without one`
      : `${provider} (direct) · used by \`finch run\` and scheduled agents`,
    fix: provider === "finch-proxy"
      ? `Only needed for \`finch run\` and scheduled agents — \`finch setup\` adds one`
      : undefined,
  });

  // 2. Backend reachable
  try {
    const t0 = Date.now();
    const res = await fetch(`${CONVEX_SITE}/memory/profile`, {
      headers: authHeader as any,
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - t0;
    if (res.status === 401) {
      checks.push({
        name: "Backend reachable", status: "⚠",
        detail: `${CONVEX_SITE} → 401 (not signed in)`,
        fix: `Run \`finch login\` to authenticate.`,
      });
    } else if (res.ok) {
      checks.push({
        name: "Backend reachable", status: "✓",
        detail: `${CONVEX_SITE} → ${res.status} (${latency}ms)`,
      });
    } else {
      checks.push({
        name: "Backend reachable", status: "✗",
        detail: `${CONVEX_SITE} → ${res.status}`,
        fix: `Check FINCH_CONVEX_URL env var, or wait if the service is down.`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "Backend reachable", status: "✗",
      detail: `${CONVEX_SITE} → ${err.message}`,
      fix: `Network issue or wrong URL. Default: https://valuable-fish-533.convex.site`,
    });
  }

  // 3. Auth state
  if (cfg.sessionToken) {
    checks.push({
      name: "Authentication",
      status: "✓",
      detail: cfg.email
        ? `Signed in as ${cfg.email}`
        : `Session token present`,
    });
  } else {
    checks.push({
      name: "Authentication",
      status: "⚠",
      detail: `No session token - running with local wallet signature only`,
      fix: `Run \`finch login\` for persistent identity across MCP clients.`,
    });
  }

  // 4. Local wallet
  const walletPath = path.join(os.homedir(), ".finch", "wallet.json");
  if (fs.existsSync(walletPath)) {
    try {
      const wallet = JSON.parse(fs.readFileSync(walletPath, "utf8"));
      const addr = wallet.address ? (wallet.address.startsWith("0x") ? wallet.address : `0x${wallet.address}`) : "unknown";
      checks.push({
        name: "Local wallet", status: "✓",
        detail: `${addr.slice(0, 6)}...${addr.slice(-4)} at ~/.finch/wallet.json`,
      });
    } catch {
      checks.push({
        name: "Local wallet", status: "⚠",
        detail: `wallet.json present but unreadable`,
        fix: `Delete ~/.finch/wallet.json and re-run finch - new wallet auto-creates.`,
      });
    }
  } else {
    checks.push({
      name: "Local wallet", status: "⚠",
      detail: `Not created yet`,
      fix: `Auto-creates on first DeFi tool call (base_mcp_balance, etc).`,
    });
  }

  // 5. Profile entries
  if (cfg.sessionToken) {
    try {
      const res = await fetch(`${CONVEX_SITE}/vault/profile-context?maxChars=100`, {
        headers: authHeader as any,
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json() as any;
      if (data?.hasProfile) {
        checks.push({
          name: "Profile context", status: "✓",
          detail: `Profile entries found - Claude auto-loads your context across sessions`,
        });
      } else {
        checks.push({
          name: "Profile context", status: "⚠",
          detail: `No profile entries yet`,
          fix: `Run: vault_save type=memory key=profile/business content="<who you are, what you build>"`,
        });
      }
    } catch {
      checks.push({
        name: "Profile context", status: "⚠",
        detail: `Could not fetch (backend issue)`,
      });
    }
  }

  // 6. Tool palette mode
  const toolMode = process.env.FINCH_TOOLS ?? "core";
  checks.push({
    name: "Tool palette",
    status: "✓",
    detail: `Mode: ${toolMode}${toolMode === "core" ? ` (default - ${CORE_TOOL_COUNT} essential tools)` : toolMode === "all" ? ` (power user - ${TOTAL_TOOL_COUNT} tools)` : ` (custom subset)`}`,
    fix: toolMode === "core"
      ? `Set FINCH_TOOLS=all to expose all ${TOTAL_TOOL_COUNT} tools (raises LLM context cost).`
      : undefined,
  });

  // 7. MEV-protect broadcast (optional belt-and-suspenders for swaps)
  if (process.env.FINCH_BROADCAST_RPC) {
    const host = (() => {
      try { return new URL(process.env.FINCH_BROADCAST_RPC!).host; } catch { return "custom"; }
    })();
    checks.push({
      name: "MEV-protect", status: "✓",
      detail: `Broadcasts routed through ${host} (private/MEV-protected)`,
    });
  } else {
    checks.push({
      name: "MEV-protect", status: "⚠",
      detail: `Standard Base RPC (sequencer is centralized, MEV is naturally low)`,
      fix: `Optional: set FINCH_BROADCAST_RPC=<private-relay-url> for belt-and-suspenders routing.`,
    });
  }

  // 8. GITHUB_TOKEN (optional but affects github_search_code)
  if (process.env.GITHUB_TOKEN) {
    checks.push({
      name: "GitHub token", status: "✓",
      detail: `GITHUB_TOKEN set - github_search_code + private repos work`,
    });
  } else {
    checks.push({
      name: "GitHub token", status: "⚠",
      detail: `No GITHUB_TOKEN - github_search_code disabled, other tools rate-limited to 60/hr`,
      fix: `Optional. Create at https://github.com/settings/tokens (scopes: public_repo) and add to MCP env.`,
    });
  }

  // 9. Local memory (self-hosted) - optional, zero-cost alternative to the
  // Convex-proxied cloud memory backend. Two flavors: zero-dependency file
  // store, or a separately-run supermemory server.
  const localMemCfg = getLocalMemoryConfig();
  if (localMemCfg?.kind === "file") {
    checks.push({
      name: "Local memory", status: "✓",
      detail: `file-based at ~/.finch/memory - memory tools run fully local, zero cost, no server`,
    });
  } else if (localMemCfg?.kind === "supermemory") {
    const reachable = await isLocalMemoryReachable(localMemCfg);
    checks.push(reachable ? {
      name: "Local memory", status: "✓",
      detail: `supermemory reachable at ${localMemCfg.url} - memory tools run fully local, zero cost`,
    } : {
      name: "Local memory", status: "⚠",
      detail: `memoryBackend is "local" but ${localMemCfg.url} isn't reachable`,
      fix: `Start the local server (see \`npx supermemory local\`), or run \`finch setup\` again.`,
    });
  } else {
    checks.push({
      name: "Local memory", status: "⚠",
      detail: `Not configured - memory tools use the Finch-hosted proxy`,
      fix: `Run \`finch setup\` to switch to a free, self-hosted local memory backend.`,
    });
  }

  // 10. Local vault (user-owned, on-disk) - the account-free alternative to the
  // Convex-hosted vault.
  if (cfg.vaultBackend === "local") {
    const vaultDir = path.join(os.homedir(), ".finch", "vault");
    let entryCount = 0;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(vaultDir, "index.json"), "utf8"));
      entryCount = Object.keys(idx.entries ?? {}).length;
    } catch { /* no index yet */ }
    checks.push({
      name: "Local vault", status: "✓",
      detail: `on-disk at ~/.finch/vault (${entryCount} entr${entryCount === 1 ? "y" : "ies"}) - you own the data, no account needed`,
    });
  } else {
    checks.push({
      name: "Local vault", status: "⚠",
      detail: `Not configured - vault tools use the Finch-hosted store (needs login)`,
      fix: `Run \`finch setup\` to store vault artifacts locally, no account required.`,
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const colorFor = (s: DoctorCheck["status"]) => s === "✓" ? C.green : s === "⚠" ? C.yellow : C.red;
  const widest = Math.max(...checks.map((c) => c.name.length));

  for (const c of checks) {
    const pad = c.name.padEnd(widest);
    console.log(`  ${colorFor(c.status)}${c.status}${C.reset}  ${C.cyan}${pad}${C.reset}  ${c.detail}`);
    if (c.fix) console.log(`     ${" ".repeat(widest)}  ${C.dim}→ ${c.fix}${C.reset}`);
  }

  const counts = { "✓": 0, "⚠": 0, "✗": 0 };
  checks.forEach((c) => counts[c.status]++);
  console.log("");
  console.log(`  ${C.dim}Summary:${C.reset} ${C.green}${counts["✓"]} ok${C.reset} · ${C.yellow}${counts["⚠"]} warning${C.reset} · ${C.red}${counts["✗"]} critical${C.reset}`);
  console.log("");

  if (counts["✗"] > 0) {
    console.log(`  ${C.red}Critical issues found - fix the lines above before relying on finch.${C.reset}\n`);
    process.exit(1);
  } else if (counts["⚠"] > 0) {
    console.log(`  ${C.dim}Warnings are non-blocking - finch works but could be smoother.${C.reset}\n`);
  } else {
    console.log(`  ${C.green}All systems healthy.${C.reset}\n`);
  }
}
