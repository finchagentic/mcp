import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { getLocalMemoryConfig, isLocalMemoryReachable } from "../local-memory.js";
import { getSavedToken } from "../config.js";

const CONVEX_SITE = process.env.FINCH_CONVEX_URL ?? "https://valuable-fish-533.convex.site";

// finch_status moved to ../finch-status.ts (Sep 2026) - the old version here
// made 6 Promise.allSettled backend calls and silently defaulted every field
// to zero/basic on ANY failure (including a 401), which read as "empty but
// healthy" instead of surfacing a real auth problem. The new one makes one
// cheap authed call and reports the real state. Kept out of OS_TOOLS/this
// switch entirely (not just filtered at list time) so there's exactly one
// place this tool is defined - server.ts wires it in directly.
export const OS_TOOLS: Tool[] = [
  {
    name: "finch_diagnostics",
    description:
      "Health check for all Finch services - Convex backend, Firecrawl, Supermemory, and configured API keys. " +
      "Run this when something is broken or before starting a long research session to confirm everything is live. " +
      "Shows which env vars are set and which services are reachable.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "finch_shell_chat",
    description:
      "Chat with Finch Terminal — AI terminal with tool calling. Can spawn agents, save to vault, search memory, create automations, estimate swaps, list agents, and get wallet balance — all from a single prompt.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Your message or instruction to Finch Terminal." },
        agent_id: { type: "string", description: "Optional: specific agent ID to chat with (default: noel-default)." },
      },
      required: ["message"],
    },
  },
];

export async function handleOsTool(name: string, args: unknown): Promise<ToolResult | null> {
  switch (name) {
    case "finch_diagnostics": {
      const CONVEX_URL = process.env.FINCH_CONVEX_URL ?? "https://valuable-fish-533.convex.site";
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
        "FINCH_SESSION_TOKEN": !!process.env.FINCH_SESSION_TOKEN,
        "FINCH_API_KEY":       !!process.env.FINCH_API_KEY,
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
      // A missing LLM key is not a fault. Tools return evidence and structure
      // for the calling model to reason over; they don't run inference. The
      // key only matters when Finch itself has to *be* the model - the CLI
      // agent loop and scheduled agents, which have no client attached.
      if (!llmConfigured) {
        hints.push(`→ No LLM key — that's fine. Every tool works without one; your client's model does the reasoning.`);
        hints.push(`   A key is only needed for \`finch run\` (CLI agent loop), scheduled agents, and \`deep_research mode:"report"\`.`);
      }
      if (!envKeys["FIRECRAWL_API_KEY"]) hints.push(`→ No FIRECRAWL_API_KEY — deep_research falls back to Finch proxy (requires session token).`);
      if (!localMemCfg) hints.push(`→ Memory tools use the Finch-hosted proxy. Run \`finch setup\` for free, self-hosted local memory.`);
      else if (localMemCfg.kind === "supermemory" && localSmStatus !== "ok") hints.push(`→ Local memory configured but ${localMemCfg.url} isn't reachable — memory tools will fail. Run \`npx -y supermemory local\`.`);

      const localMemLabel = !localMemCfg
        ? "not configured — run `finch setup`"
        : localMemCfg.kind === "file"
        ? "file-based at ~/.finch/memory"
        : localSmStatus === "ok" ? `reachable at ${localMemCfg.url}` : `configured but unreachable at ${localMemCfg.url}`;

      const lines = [
        `## 🩺 Finch Diagnostics`,
        ``,
        `**Services:**`,
        `  ${statusIcon(convexStatus)}  Convex backend       ${convexStatus === "ok" ? "reachable" : "unreachable — check FINCH_CONVEX_URL"}`,
        `  ${statusIcon(fcStatus)}  Firecrawl            ${fcStatus === "ok" ? "reachable" : fcStatus === "unconfigured" ? "no FIRECRAWL_API_KEY — deep_research will use proxy" : "unreachable"}`,
        `  ${statusIcon(smStatus)}  Supermemory (cloud)  ${localMemCfg ? "not used — local memory active" : smStatus === "ok" ? "reachable" : "unreachable — memory tools may fail"}`,
        `  ${statusIcon(localSmStatus)}  Local memory         ${localMemLabel}`,
        ``,
        `**API Keys configured:** _(none of the LLM keys are required — see below)_`,
        ...Object.entries(envKeys).map(([k, v]) => `  ${v ? "✅" : "⚪"}  ${k}`),
        ``,
        `**LLM:** ${llmConfigured ? "✅ configured — used for the CLI agent loop and scheduled agents" : "⚪ none set — optional, tools don't need one"}`,
        ...(hints.length ? [``, ...hints] : []),
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "finch_shell_chat": {
      const { message, agent_id } = args as { message: string; agent_id?: string };
      if (!message) return { content: [{ type: "text", text: "Error: message is required" }] };
      try {
        // Bug fix: this used to read only process.env.FINCH_SESSION_TOKEN/
        // FINCH_API_KEY directly, bypassing getSavedToken()'s fallback to
        // ~/.finch/config.json - a user authenticated via `finch login`
        // (not an env var) silently sent an empty Authorization header here
        // while every other tool (which goes through callConvex) worked.
        const res = await fetch(`${CONVEX_SITE}/finch/shell/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${getSavedToken() ?? process.env.FINCH_API_KEY ?? ""}`,
          },
          body: JSON.stringify({ message, agentId: agent_id ?? "finch-default" }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          return { content: [{ type: "text", text: `Shell chat error: ${res.status} ${res.statusText}` }] };
        }
        const data = await res.json() as { response?: string; actions?: unknown[] };
        let text = data.response ?? "No response from Finch Terminal.";
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
