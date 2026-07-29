import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
import type { ToolResult } from "../types.js";

const CHRONICLE_TYPES = ["vault", "memory", "agent", "tool", "automation", "monitor", "system", "custom"] as const;

export const CHRONICLE_TOOLS: Tool[] = [
  {
    name: "chronicle_add",
    description:
      "Log an event to Finch Chronicle - the system-wide audit log for your AI runtime. " +
      "Records anything meaningful: vault saves, agent updates, automation triggers, " +
      "custom milestones, research completions. Chronicle is your permanent timeline of what happened. " +
      "Types: vault | memory | agent | tool | automation | monitor | system | custom.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [...CHRONICLE_TYPES],
          description: "Event category",
        },
        title: {
          type: "string",
          description: "Short event title, e.g. 'Saved ETH research to vault'",
        },
        detail: {
          type: "string",
          description: "Optional longer description or result summary",
        },
        metadata: {
          type: "object",
          description: "Optional extra data (key, agentId, topic, etc.)",
        },
      },
      required: ["type", "title"],
    },
  },
  {
    name: "chronicle_list",
    description:
      "Read the Finch Chronicle event log - your AI runtime timeline. Returns recent events in reverse chronological order. " +
      "Filter by type to see only vault saves, agent activity, automations, etc.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max events to return (default 20, max 100)",
        },
        type: {
          type: "string",
          enum: [...CHRONICLE_TYPES],
          description: "Filter by event type (optional)",
        },
      },
    },
  },
  {
    name: "chronicle_search",
    description:
      "Search the Finch Chronicle by keyword. Matches against event titles and details. " +
      "Useful for finding when something specific happened: 'when did I last research ETH?' or 'find all vault saves for Base'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword or phrase to search for in event titles and details",
        },
        type: {
          type: "string",
          enum: [...CHRONICLE_TYPES],
          description: "Optional: filter by event type before searching",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "chronicle_stats",
    description:
      "Activity stats for your AI runtime - breakdown by event type, daily activity heatmap, " +
      "busiest days, and most active categories. Use to understand how heavily you're using the runtime.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "How many days back to analyze (default 30, max 90)",
        },
      },
    },
  },
];

// Keep "swarm" emoji for backward compatibility - legacy chronicle entries
// may still have this type even though it's no longer accepted on new writes.
const TYPE_EMOJI: Record<string, string> = {
  vault:       "🗄️",
  memory:      "🧠",
  agent:       "🤖",
  tool:        "🔧",
  automation:  "⚡",
  monitor:     "👁️",
  system:      "⚙️",
  custom:      "📌",
  swarm:       "🐝",
};

function formatEntry(e: any): string {
  const emoji = TYPE_EMOJI[e.type] ?? "📌";
  const date = new Date(e.ts).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  const lines = [`${emoji} **${e.title}** · \`${e.type}\` · ${date}`];
  if (e.detail) lines.push(`   ${e.detail}`);
  return lines.join("\n");
}

// ── Structured output builders (schemas in output-schemas.ts) ───────────────
function chronicleEntry(e: any) {
  return { title: e.title ?? null, detail: e.detail ?? null, type: e.type ?? null, ts: e.ts ?? null };
}

export function buildChronicleList(type: string | undefined, entries: any[]): Record<string, unknown> {
  return { type: type ?? null, count: entries.length, entries: entries.map(chronicleEntry) };
}

export function buildChronicleSearch(query: string, type: string | undefined, matched: any[]): Record<string, unknown> {
  return { query, type: type ?? null, count: matched.length, entries: matched.map(chronicleEntry) };
}

export function buildChronicleStats(days: number, entries: any[]): Record<string, unknown> {
  const byType: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }
  const busiestDays = Object.entries(byDay).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([day, count]) => ({ day, count }));
  return {
    days,
    totalEvents: entries.length,
    activeDays: Object.keys(byDay).length,
    avgPerDay: entries.length / days,
    byType: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    busiestDays,
  };
}

export async function handleChronicle(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {

  if (name === "chronicle_add") {
    const { type = "custom", title, detail, metadata } = args as {
      type?: string; title: string; detail?: string; metadata?: unknown;
    };

    await callConvex("/chronicle/add", "POST", {
      type,
      title,
      detail,
      metadata,
      source: "mcp",
    }, "chronicle_add");

    const emoji = TYPE_EMOJI[type] ?? "📌";
    return {
      content: [{
        type: "text",
        text: [
          `${emoji} **Logged to Chronicle**`,
          ``,
          `**${title}**${detail ? `\n${detail}` : ""}`,
          ``,
          `Type: \`${type}\` · Use \`chronicle_list\` to view your timeline.`,
        ].join("\n"),
      }],
    };
  }

  if (name === "chronicle_list") {
    const limit = Math.min(Number(args.limit ?? 20), 100);
    const type = args.type as string | undefined;

    const data = await callConvex(
      `/chronicle/list?limit=${limit}${type ? `&type=${type}` : ""}`,
      "GET",
      undefined,
      "chronicle_list",
    );

    const entries: any[] = data.entries ?? [];

    if (entries.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No chronicle entries yet. Use `chronicle_add` to start logging events.",
        }],
        structuredContent: buildChronicleList(type, []),
      };
    }

    const lines: string[] = [
      `## 📜 Finch Chronicle${type ? ` · ${type}` : ""}`,
      `*${entries.length} event${entries.length !== 1 ? "s" : ""}*`,
      "",
    ];

    for (const e of entries) lines.push(formatEntry(e));

    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: buildChronicleList(type, entries) };
  }

  if (name === "chronicle_search") {
    const { query, type, limit = 10 } = args as { query: string; type?: string; limit?: number };
    if (!query) return { content: [{ type: "text", text: "query is required" }], isError: true };

    const data = await callConvex(
      `/chronicle/list?limit=100${type ? `&type=${type}` : ""}`,
      "GET",
      undefined,
      "chronicle_list",
    );

    const allEntries: any[] = data.entries ?? [];
    const q = query.toLowerCase();
    const matched = allEntries.filter((e: any) =>
      (e.title ?? "").toLowerCase().includes(q) ||
      (e.detail ?? "").toLowerCase().includes(q)
    ).slice(0, Math.min(Number(limit), 50));

    if (matched.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No chronicle events matching "${query}"${type ? ` (type: ${type})` : ""}. (searched most recent 100 entries)`,
        }],
        structuredContent: buildChronicleSearch(query, type, []),
      };
    }

    const lines = [
      `## 🔍 Chronicle Search: "${query}"`,
      `*${matched.length} match${matched.length !== 1 ? "es" : ""}${type ? ` · type: ${type}` : ""} · searched most recent 100 entries*`,
      "",
    ];
    for (const e of matched) lines.push(formatEntry(e));

    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: buildChronicleSearch(query, type, matched) };
  }

  if (name === "chronicle_stats") {
    const days = Math.min(Number(args.days ?? 30), 90);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const data = await callConvex(
      `/chronicle/list?limit=100`,
      "GET",
      undefined,
      "chronicle_list",
    );

    const allEntries: any[] = (data.entries ?? []).filter((e: any) => (e.ts ?? 0) >= cutoff);

    if (allEntries.length === 0) {
      return {
        content: [{ type: "text", text: `No chronicle events in the past ${days} days.` }],
        structuredContent: buildChronicleStats(days, []),
      };
    }

    // Count by type
    const byType: Record<string, number> = {};
    const byDay: Record<string, number> = {};

    for (const e of allEntries) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      const day = new Date(e.ts).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    const sortedTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    const sortedDays  = Object.entries(byDay).sort((a, b) => b[1] - a[1]);
    const activeDays  = Object.keys(byDay).length;
    const avgPerDay   = (allEntries.length / days).toFixed(1);

    const lines = [
      `## 📊 Chronicle Stats — last ${days} days`,
      ``,
      `**Total events:** ${allEntries.length} across ${activeDays} active day${activeDays !== 1 ? "s" : ""} (avg ${avgPerDay}/day)`,
      ``,
      `**By type:**`,
      ...sortedTypes.map(([t, n]) => {
        const bar = "█".repeat(Math.round((n / allEntries.length) * 20));
        const emoji = TYPE_EMOJI[t] ?? "📌";
        return `  ${emoji} ${t.padEnd(12)} ${String(n).padStart(3)}  ${bar}`;
      }),
      ``,
      `**Busiest days:**`,
      ...sortedDays.slice(0, 5).map(([d, n]) => `  ${d}  ${n} event${n !== 1 ? "s" : ""}`),
      ``,
      `*Note: stats based on most recent 100 entries*`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: buildChronicleStats(days, allEntries) };
  }

  return { content: [{ type: "text", text: `Unknown chronicle tool: ${name}` }], isError: true };
}
