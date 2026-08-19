import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
import { ToolResult } from "../types.js";
import { parseOrError } from "../_zod-helpers.js";

const TRIGGER_BASE = "https://api.trigger.dev/api/v1";
const MONITOR_TASK_ID = "finch-monitor";

const MONITOR_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    topic:    { type: "string", description: "What to research - topic, keyword, or question" },
    schedule: {
      type: "string",
      description: "Cron expression or preset. Presets: 'daily-8am', 'daily-6pm', 'weekly-monday', 'hourly'. Or raw cron: '0 8 * * *'",
    },
    label:    { type: "string", description: "Short label to identify this schedule (e.g. 'morning brief', 'competitor watch')" },
  },
  required: ["topic", "schedule"],
};

export const MONITOR_TOOLS: Tool[] = [
  {
    name: "schedule_research",
    description:
      "Schedule recurring autonomous research on any topic - runs on a cron schedule, saves findings to vault. " +
      "The agent runs completely on its own with no prompting needed. " +
      "Requires TRIGGER_SECRET_KEY env var (trigger.dev). " +
      "Examples: daily morning briefing, weekly competitor analysis, hourly price alerts, monthly industry report.",
    inputSchema: MONITOR_INPUT_SCHEMA,
  },
  {
    name: "list_monitors",
    description: "List all active scheduled research monitors - shows topic, schedule, next run, and monitor ID.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_monitor",
    description:
      "PERMANENT. Cancel and delete a scheduled research monitor — the schedule is removed and " +
      "cannot be restored. Requires confirm: true. Run list_monitors first and show the user which " +
      "monitor (id + topic) you are about to delete.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Monitor ID (from list_monitors)" },
        confirm: { type: "boolean", description: "Must be true to delete. Guards against removing the wrong monitor." },
      },
      required: ["id", "confirm"],
    },
  },
];

const CRON_PRESETS: Record<string, string> = {
  "daily-8am":      "0 8 * * *",
  "daily-6pm":      "0 18 * * *",
  "weekly-monday":  "0 8 * * 1",
  "hourly":         "0 * * * *",
};

const CreateSchema = z.object({
  topic:    z.string().min(1).max(200),
  schedule: z.string().min(1),
  label:    z.string().max(80).optional(),
});

const CancelSchema = z.object({ id: z.string().min(1) });

function getKey(): string | null {
  return process.env.TRIGGER_SECRET_KEY ?? null;
}

function noKeyMsg(): ToolResult {
  return {
    content: [{
      type: "text",
      text: [
        `⚠️ **TRIGGER_SECRET_KEY not set.**`,
        ``,
        `To enable autonomous monitors:`,
        `1. Sign up at trigger.dev (free tier available)`,
        `2. Create a project, go to API Keys → copy your Secret Key`,
        `3. Add to your MCP config env block: \`"TRIGGER_SECRET_KEY": "tr_prod_..."\``,
        `4. In the finch worker directory, run: \`npx trigger.dev@latest deploy\``,
        ``,
        `Then monitors will run autonomously - no chat needed.`,
      ].join("\n"),
    }],
    isError: true,
  };
}

function resolveCron(input: string): string {
  return CRON_PRESETS[input] ?? input;
}

// Structured output builder for list_monitors (schema in output-schemas.ts).
export function buildMonitorList(
  schedules: any[],
  configs: Record<string, { topic?: string; label?: string }> = {},
): Record<string, unknown> {
  return {
    count: schedules.length,
    monitors: schedules.map((s) => {
      const cfg = s.externalId ? configs[s.externalId] : undefined;
      return {
        id: s.id ?? null,
        externalId: s.externalId ?? null,
        label: cfg?.label ?? s.externalId ?? s.id ?? null,
        topic: cfg?.topic ?? null,
        cron: s.cron ?? null,
        nextRun: s.nextRun ?? null,
      };
    }),
  };
}

export async function handleMonitorTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name === "schedule_research") {
    const parsed = parseOrError(CreateSchema, args);
    if (!parsed.ok) return parsed.error;
    const key = getKey();
    if (!key) return noKeyMsg();

    const { topic, schedule, label } = parsed.data;
    const cron = resolveCron(schedule);

    // Dedup gate - reject if the user already has a monitor with the exact
    // same topic + schedule combo. Stops "track AI news daily" from being
    // created 4× by an over-eager agent loop, which is what produced the
    // duplicate Telegram briefings users complained about.
    try {
      const existingMonitors = await callConvex(
        "/vault/list",
        "POST",
        { type: "workflow", tags: ["monitor-config"] },
        "vault_list",
      ) as { entries?: Array<{ key: string; content?: string }> } | null;

      const duplicates = (existingMonitors?.entries ?? []).filter((e) => {
        try {
          const cfg = JSON.parse(e.content ?? "{}");
          const sameTopic = (cfg.topic ?? "").toLowerCase().trim() === topic.toLowerCase().trim();
          const sameCron = (cfg.cron ?? "") === cron;
          return sameTopic && sameCron;
        } catch {
          return false;
        }
      });

      if (duplicates.length > 0) {
        const existingIds = duplicates
          .map((d) => {
            try { return JSON.parse(d.content ?? "{}").scheduleId; } catch { return null; }
          })
          .filter(Boolean);
        return {
          content: [{
            type: "text",
            text: [
              `⚠️ **Duplicate monitor blocked**`,
              ``,
              `You already have ${duplicates.length} active monitor${duplicates.length > 1 ? "s" : ""} for the exact topic + schedule:`,
              `  • Topic:    ${topic}`,
              `  • Schedule: ${schedule}`,
              ``,
              existingIds.length > 0
                ? `Existing schedule ID${existingIds.length > 1 ? "s" : ""}: ${existingIds.map((id) => `\`${id}\``).join(", ")}`
                : "",
              ``,
              `Cancel the old one first if you want to recreate:`,
              `  \`cancel_monitor id: "<schedule_id>"\``,
              ``,
              `Or use a more specific topic to make this a distinct monitor.`,
            ].filter(Boolean).join("\n"),
          }],
        };
      }
    } catch {
      // Dedup check failed (auth or network) - continue, better to allow than
      // block on infrastructure errors.
    }

    // Unique stable ID - worker reads config from vault using this as key
    const externalId = `monitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    try {
      const res = await fetch(`${TRIGGER_BASE}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({ task: MONITOR_TASK_ID, cron, externalId, deduplicationKey: externalId }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed to create monitor: ${err}` }], isError: true };
      }

      const data = await res.json() as any;
      const scheduleId: string = data.id ?? externalId;

      // Save config to vault so the worker can retrieve topic + metadata
      let configSaved = true;
      try {
        await callConvex("/vault/save", "POST", {
          type: "workflow",
          title: `Monitor: ${label ?? topic}`,
          content: JSON.stringify({ topic, label: label ?? topic, cron, scheduleId, externalId }),
          key: `monitor-config/${externalId}`,
          agentId: "os",
          tags: ["monitor-config"],
          commitMsg: "schedule_research config",
        }, "vault_save");
      } catch {
        configSaved = false;
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ **Monitor created**`,
            ``,
            `📌 Topic:    ${topic}`,
            `🕐 Schedule: ${cron}${CRON_PRESETS[schedule] ? ` (${schedule})` : ""}`,
            `🆔 ID:       ${scheduleId}`,
            data.nextRun ? `⏭️ Next run: ${new Date(data.nextRun).toUTCString()}` : "",
            ``,
            configSaved
              ? `The agent will research "${topic}" on schedule and save findings to vault.`
              : `⚠️ Monitor schedule created but config save failed - the agent may use a default topic on first run. Try \`cancel_monitor\` and recreate.`,
            `Use \`list_monitors\` to see all active monitors.`,
          ].filter(Boolean).join("\n"),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Monitor error: ${err.message}` }], isError: true };
    }
  }

  if (name === "list_monitors") {
    const key = getKey();
    if (!key) return noKeyMsg();

    try {
      const res = await fetch(`${TRIGGER_BASE}/schedules`, {
        headers: { "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed to list monitors: ${err}` }], isError: true };
      }

      const data = await res.json() as any;
      const schedules: any[] = (data.data ?? []).filter((s: any) => (s.task ?? s.taskIdentifier) === MONITOR_TASK_ID);

      if (!schedules.length) {
        return {
          content: [{
            type: "text",
            text: `No active monitors.\n\nUse \`schedule_research\` to set up an autonomous agent that runs on a schedule.`,
          }],
          structuredContent: buildMonitorList([]),
        };
      }

      // Load topic labels from vault for each schedule
      const configMap = new Map<string, { topic: string; label: string }>();
      await Promise.allSettled(
        schedules
          .filter(s => s.externalId)
          .map(async s => {
            try {
              // `/vault/entry`, not `/vault/read` — the latter 404s, which this
              // catch used to hide, leaving every monitor listed by raw id.
              const cfg = await callConvex(`/vault/entry?key=monitor-config/${s.externalId}`, "GET", undefined, "vault_read");
              if (cfg?.content) {
                const parsed = JSON.parse(cfg.content);
                configMap.set(s.externalId, { topic: parsed.topic, label: parsed.label ?? parsed.topic });
              }
            } catch { /* skip - show raw externalId */ }
          })
      );

      const lines = [`📋 **Active Monitors** - ${schedules.length} running\n`];
      for (const s of schedules) {
        const cfg = s.externalId ? configMap.get(s.externalId) : undefined;
        const label = cfg?.label ?? s.externalId ?? s.id;
        const topic = cfg?.topic ? ` - ${cfg.topic}` : "";
        const next = s.nextRun ? new Date(s.nextRun).toUTCString() : "unknown";
        lines.push(`**${label}**${topic}`);
        lines.push(`  ID: \`${s.id}\` · Cron: \`${s.cron}\` · Next: ${next}`);
        lines.push("");
      }
      lines.push(`Use \`cancel_monitor id: "<id>"\` to stop a monitor.`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: buildMonitorList(schedules, Object.fromEntries(configMap)),
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `List error: ${err.message}` }], isError: true };
    }
  }

  if (name === "cancel_monitor") {
    const parsed = parseOrError(CancelSchema, args);
    if (!parsed.ok) return parsed.error;
    if ((args as { confirm?: boolean })?.confirm !== true) {
      return {
        content: [{
          type: "text",
          text:
            "Refusing to cancel: this deletes the monitor's schedule permanently. Show the user " +
            "which monitor it is (run `list_monitors`), then pass `confirm: true`.",
        }],
        isError: true,
      };
    }
    const key = getKey();
    if (!key) return noKeyMsg();
    const { id } = parsed.data;

    try {
      const res = await fetch(`${TRIGGER_BASE}/schedules/${id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed to cancel monitor: ${err}` }], isError: true };
      }
      return { content: [{ type: "text", text: `✅ Monitor \`${id}\` cancelled.` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Cancel error: ${err.message}` }], isError: true };
    }
  }

  return null;
}
