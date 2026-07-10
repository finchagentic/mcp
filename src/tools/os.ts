import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
import { ToolResult } from "../types.js";
import { getTier } from "../token-gate.js";
import { getOrCreateWallet } from "../wallet.js";
import { getLocalMemoryConfig, isLocalMemoryReachable, localMemoryProfile } from "../local-memory.js";

const CONVEX_SITE = process.env.NOELCLAW_CONVEX_URL ?? "https://befitting-porcupine-276.convex.site";

export const OS_TOOLS: Tool[] = [
  {
    name: "noel_status",
    description:
      "Full runtime dashboard - memory size, persistent agents, active automations, recent vault research, " +
      "execution scores, and your tier. Like `htop` for your AI runtime. " +
      "Run this to see what's running and what state your runtime is currently holding.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "noel_diagnostics",
    description:
      "Health check for all Noelclaw services - Convex backend, Firecrawl, Supermemory, and configured API keys. " +
      "Run this when something is broken or before starting a long research session to confirm everything is live. " +
      "Shows which env vars are set and which services are reachable.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "noel_shell_chat",
    description:
      "Chat with Noel Shell — AI terminal with tool calling. Can spawn agents, save to vault, search memory, create automations, estimate swaps, list agents, and get wallet balance — all from a single prompt.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Your message or instruction to Noel Shell." },
        agent_id: { type: "string", description: "Optional: specific agent ID to chat with (default: noel-default)." },
      },
      required: ["message"],
    },
  },
];

export async function handleOsTool(name: string, args: unknown): Promise<ToolResult | null> {
  switch (name) {
    case "noel_status": {
      // Respect local memory mode here too - querying Convex's /memory/profile
      // when writes have been going to a local supermemory server instead
      // would report a stale/zero count (the exact bug memory_profile's own
      // handler was fixed to avoid).
      const localStatusCfg = getLocalMemoryConfig();
      const memoryProfileCall = localStatusCfg
        ? localMemoryProfile(localStatusCfg)
        : callConvex("/memory/profile", "GET");

      const [tierResult, walletResult, memRes, autoRes, vaultRes, agentsRes] = await Promise.allSettled([
        getTier(),
        getOrCreateWallet(),
        memoryProfileCall,
        callConvex("/automations/list", "GET", undefined, "list_automations"),
        callConvex("/vault/list?type=research&limit=5", "GET", undefined, "noel_status"),
        callConvex("/vault/list?type=memory&limit=20", "GET", undefined, "noel_status"),
      ]);

      const tier   = tierResult.status   === "fulfilled" ? tierResult.value   : "basic";
      const wallet = walletResult.status === "fulfilled" ? walletResult.value : null;
      const mem    = memRes.status    === "fulfilled" ? memRes.value    : null;
      const autos  = autoRes.status   === "fulfilled" ? autoRes.value   : null;
      const vault  = vaultRes.status  === "fulfilled" ? vaultRes.value  : null;
      const agents = agentsRes.status === "fulfilled" ? agentsRes.value : null;

      const automations: any[] = autos?.automations ?? [];
      const activeAutos = automations.filter((a: any) => a.status === "active");
      const vaultEntries: any[] = vault?.entries ?? [];
      // Persistent agents live in vault as type=memory with key prefix "agent/"
      const persistentAgents: any[] = (agents?.entries ?? []).filter((e: any) => typeof e.key === "string" && e.key.startsWith("agent/"));
      const memTotal = mem?.total ?? 0;
      const memStatus = mem?.status ?? "unknown";

      const tierLabel = tier === "holder"
        ? "\u{1F7E2} **Holder**  - premium tools unlocked"
        : "⚪ **Basic**   - hold NOELCLAW on Base to unlock premium tools";
      const walletShort = wallet
        ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
        : "not configured";

      const lines = [
        `**Noelclaw Runtime - System Status**`,
        `────────────────────────────────`,
        ``,
        `🔑 **Tier**         ${tierLabel}`,
        `👛 **Wallet**       ${walletShort}`,
        ``,
        `🧠 **Memory**       ${memStatus === "ok" ? "✅" : "⚠️"} ${memTotal} entries · Space: ${mem?.space ?? "-"}`,
        `🤖 **Agents**       ${persistentAgents.length} persistent agent${persistentAgents.length === 1 ? "" : "s"} in vault`,
        `⚡ **Automations**  ${activeAutos.length} active of ${automations.length} total`,
        `📚 **Vault**        ${vaultEntries.length} recent research entries`,
        ``,
      ];

      if (activeAutos.length > 0) {
        lines.push(`**Active Automations:**`);
        for (const a of activeAutos.slice(0, 5)) {
          const next = a.nextRunAt ? ` · next ${new Date(a.nextRunAt).toUTCString()}` : "";
          lines.push(`  • ${a.name} - ${a.triggerType}${next}`);
        }
        lines.push("");
      }

      if (persistentAgents.length > 0) {
        lines.push(`**Persistent Agents:**`);
        for (const a of persistentAgents.slice(0, 5)) {
          const name = a.key.replace(/^agent\//, "");
          lines.push(`  • ${name} - v${a.version ?? 1}`);
        }
        lines.push("");
      }

      if (vaultEntries.length > 0) {
        lines.push(`**Recent Research:**`);
        for (const e of vaultEntries) {
          lines.push(`  • [${e.agentId ?? "vault"}] ${e.title}`);
        }
        lines.push("");
      }

      lines.push(`💡 Run \`deep_research query: "..."\` to launch multi-agent research · \`agent_spawn\` to start a persistent agent`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "noel_diagnostics": {
      const CONVEX_URL = process.env.NOELCLAW_CONVEX_URL ?? "https://befitting-porcupine-276.convex.site";
      // Ping root of each service — any non-5xx means the host is up
      const FC_URL = "https://api.firecrawl.dev";
      const SM_URL = "https://api.supermemory.ai";

      const ping = async (url: string, timeoutMs = 5000): Promise<"ok" | "error" | "unconfigured"> => {
        try {
          const res = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(timeoutMs),
          });
          // 4xx = reachable but needs auth or wrong path — still means service is up
          return (res.status < 500) ? "ok" : "error";
        } catch {
          return "error";
        }
      };

      const envKeys = {
        "BANKR_API_KEY":          !!process.env.BANKR_API_KEY,
        "ANTHROPIC_API_KEY":      !!process.env.ANTHROPIC_API_KEY,
        "OPENAI_API_KEY":         !!process.env.OPENAI_API_KEY,
        "GROK_API_KEY":           !!process.env.GROK_API_KEY,
        "FIRECRAWL_API_KEY":      !!process.env.FIRECRAWL_API_KEY,
        "NOELCLAW_SESSION_TOKEN": !!process.env.NOELCLAW_SESSION_TOKEN,
        "NOELCLAW_API_KEY":       !!process.env.NOELCLAW_API_KEY,
        "TELEGRAM_BOT_TOKEN":     !!process.env.TELEGRAM_BOT_TOKEN,
      };

      const localMemCfg = getLocalMemoryConfig();

      const pingLocalMemory = async (): Promise<"ok" | "error" | "unconfigured"> => {
        if (!localMemCfg) return "unconfigured";
        return (await isLocalMemoryReachable(localMemCfg)) ? "ok" : "error";
      };

      const [convexStatus, fcStatus, smStatus, localSmStatus] = await Promise.all([
        // Ping the public platform stats route — runs a real DB query, so a 200
        // confirms Convex is actually serving, not just that the HTTP router is up.
        ping(`${CONVEX_URL}/stats/platform`),
        process.env.FIRECRAWL_API_KEY ? ping(FC_URL) : Promise.resolve("unconfigured" as const),
        // Cloud Supermemory is only relevant when NOT running local memory -
        // that's the legacy path memory tools fall back to via Convex.
        localMemCfg ? Promise.resolve("unconfigured" as const) : ping(SM_URL),
        pingLocalMemory(),
      ]);

      const statusIcon = (s: "ok" | "error" | "unconfigured") =>
        s === "ok" ? "✅" : s === "unconfigured" ? "⚪" : "❌";

      const llmConfigured = envKeys["BANKR_API_KEY"] || envKeys["ANTHROPIC_API_KEY"] || envKeys["OPENAI_API_KEY"] || envKeys["GROK_API_KEY"];

      const hints: string[] = [];
      if (!llmConfigured) hints.push(`→ No LLM key set — deep_research, ask_noel, market_thesis, and agent tools won't work.`);
      if (!envKeys["FIRECRAWL_API_KEY"]) hints.push(`→ No FIRECRAWL_API_KEY — deep_research falls back to Noelclaw proxy (requires session token).`);
      if (!localMemCfg) hints.push(`→ Memory tools use the Noelclaw-hosted proxy. Run \`noelclaw setup\` for free, self-hosted local memory.`);
      else if (localSmStatus !== "ok") hints.push(`→ Local memory configured but ${localMemCfg.url} isn't reachable — memory tools will fail. Run \`npx -y supermemory local\`.`);

      const lines = [
        `## 🩺 Noelclaw Diagnostics`,
        ``,
        `**Services:**`,
        `  ${statusIcon(convexStatus)}  Convex backend       ${convexStatus === "ok" ? "reachable" : "unreachable — check NOELCLAW_CONVEX_URL"}`,
        `  ${statusIcon(fcStatus)}  Firecrawl            ${fcStatus === "ok" ? "reachable" : fcStatus === "unconfigured" ? "no FIRECRAWL_API_KEY — deep_research will use proxy" : "unreachable"}`,
        `  ${statusIcon(smStatus)}  Supermemory (cloud)  ${localMemCfg ? "not used — local memory active" : smStatus === "ok" ? "reachable" : "unreachable — memory tools may fail"}`,
        `  ${statusIcon(localSmStatus)}  Supermemory (local)  ${localMemCfg ? (localSmStatus === "ok" ? `reachable at ${localMemCfg.url}` : `configured but unreachable at ${localMemCfg.url}`) : "not configured — run `noelclaw setup`"}`,
        ``,
        `**API Keys configured:**`,
        ...Object.entries(envKeys).map(([k, v]) => `  ${v ? "✅" : "⚪"}  ${k}`),
        ``,
        `**LLM:** ${llmConfigured ? "✅ configured" : "⚠️  no LLM key — set BANKR_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROK_API_KEY"}`,
        ...(hints.length ? [``, ...hints] : []),
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "noel_shell_chat": {
      const { message, agent_id } = args as { message: string; agent_id?: string };
      if (!message) return { content: [{ type: "text", text: "Error: message is required" }] };
      try {
        const res = await fetch(`${CONVEX_SITE}/noel/shell/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.NOELCLAW_SESSION_TOKEN ?? process.env.NOELCLAW_API_KEY ?? ""}`,
          },
          body: JSON.stringify({ message, agentId: agent_id ?? "noel-default" }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          return { content: [{ type: "text", text: `Shell chat error: ${res.status} ${res.statusText}` }] };
        }
        const data = await res.json() as { response?: string; actions?: unknown[] };
        let text = data.response ?? "No response from Noel Shell.";
        if (data.actions && Array.isArray(data.actions) && data.actions.length > 0) {
          text += "\n\n**Actions taken:**\n" + (data.actions as Array<{ tool?: string; result?: string }>)
            .map(a => `• \`${a.tool ?? "unknown"}\` → ${a.result ?? "done"}`)
            .join("\n");
        }
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Shell chat failed: ${(err as Error).message}` }] };
      }
    }

    default:
      return null;
  }
}
