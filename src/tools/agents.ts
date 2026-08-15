import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
import { callLLM } from "../llm.js";
import { ToolResult } from "../types.js";
import { getLocalVaultConfig, localVaultSave, localVaultRead, localVaultHistory } from "../local-vault.js";
import { hybridMemorySearch } from "./memory.js";
import { resolveProjectId } from "../project.js";

// ─── Agent Learning Memory (v3.25) ──────────────────────────────────────────
// After every agent_update, an LLM reviews the new progress in context of the
// agent's goal + prior learnings to extract a single repeatable insight. The
// insight is appended to the agent's `learnings[]` array (capped to last 30
// to keep the state file from bloating). On agent_recall and at the start of
// any agent run, learnings are surfaced so subsequent work compounds.
//
// Failure mode: extraction is best-effort. If the LLM is unavailable, slow,
// or returns NONE, the update still succeeds - we just don't append. Learning
// is a quality bonus, not a hard requirement of the update path.

const MAX_LEARNINGS = 30;

const LEARNING_SYSTEM_PROMPT = [
  "You are an expert at extracting one reusable insight from an agent's progress update.",
  "",
  "You will see: the agent's goal, the agent's recent updates (chronological), and the latest update.",
  "",
  "TASK: Decide if the latest update reveals a NEW repeatable pattern, heuristic, or framework that would",
  "improve this agent's future runs. Be strict - most updates are routine and do NOT contain a new insight.",
  "",
  "Output rules:",
  "- If a genuine new insight emerged, output ONE sentence under 180 chars starting with an imperative verb.",
  "  Examples: \"Prefer Morpho vaults over Aave when USDC supply exceeds $10M.\"",
  "             \"Always check on-chain holder count before claiming a token has organic demand.\"",
  "             \"Skip schedule_research for time-sensitive queries - use deep_research with freshMode.\"",
  "- If the update is routine (status report, progress without insight, repeat of prior learning),",
  "  output exactly: NONE",
  "- Do not output explanations, prefixes, or quotation marks. Just the sentence or NONE.",
].join("\n");

async function extractLearning(
  goal: string,
  priorUpdates: Array<{ progress: string; findings?: string; status?: string }>,
  priorLearnings: string[],
  latest: { progress: string; findings?: string; status?: string },
): Promise<string | null> {
  // Fast skip when no LLM key is configured - callLLM() now throws
  // immediately rather than proxying through Finch (BYOK is required), and
  // the catch below swallows that into a silent skip. This early return just
  // avoids building the prompt for a call we already know will fail.
  const hasLLM = !!(process.env.BANKR_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GROK_API_KEY);
  if (!hasLLM) {
    return null;
  }

  // Build the user prompt with all the context the model needs.
  const lines: string[] = [];
  lines.push(`Agent goal: ${goal}`);
  if (priorLearnings.length) {
    lines.push(``);
    lines.push(`Existing learnings (do not repeat any of these):`);
    priorLearnings.slice(-10).forEach((l, i) => lines.push(`  ${i + 1}. ${l}`));
  }
  if (priorUpdates.length) {
    lines.push(``);
    lines.push(`Recent updates (oldest first):`);
    priorUpdates.slice(-5).forEach((u, i) => {
      const finding = u.findings ? ` | findings: ${u.findings}` : "";
      lines.push(`  ${i + 1}. [${u.status ?? "active"}] ${u.progress}${finding}`);
    });
  }
  lines.push(``);
  lines.push(`Latest update:`);
  lines.push(`  [${latest.status ?? "active"}] ${latest.progress}${latest.findings ? ` | findings: ${latest.findings}` : ""}`);
  lines.push(``);
  lines.push(`What new repeatable insight (if any) emerged from this latest update?`);

  try {
    // Short max_tokens - the answer should be one sentence. 8s timeout keeps
    // agent_update responsive even when the LLM is slow; mutex still serializes
    // updates so we don't pile up.
    const out = await callLLM(LEARNING_SYSTEM_PROMPT, lines.join("\n"), 120, [], 8000);
    const trimmed = out.trim().replace(/^["']|["']$/g, "");
    if (!trimmed || trimmed.toUpperCase() === "NONE") return null;
    // Guard against the model accidentally repeating a recent learning.
    const lowered = trimmed.toLowerCase();
    if (priorLearnings.some((p) => p.toLowerCase() === lowered)) return null;
    // Hard cap on length to keep state file bounded.
    return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
  } catch {
    return null;
  }
}

// Per-agent mutex for the read-modify-write cycle in agent_update / agent_spawn.
// Without this, two parallel calls on the same agent would both read the same
// state, both append their own update, and the second save would silently lose
// the first update. The mutex chains all writes for a given agent name through
// a single Promise so they execute serially.
const agentLocks = new Map<string, Promise<unknown>>();

function withAgentLock<T>(agentName: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(agentName) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  agentLocks.set(agentName, next);
  // Clean up the map entry once this op completes - otherwise long-lived
  // server processes accumulate dead entries.
  next.finally(() => {
    if (agentLocks.get(agentName) === next) agentLocks.delete(agentName);
  });
  return next;
}

// list_agents/hire_agent were removed (not disabled - deleted) because their
// backend routes, /agents/list and /agents/hire, were never actually
// registered in app/convex/http.ts - only dangling section-header comments
// exist there, no matching http.route(...) call. Every call to either tool
// always 404'd. Re-add them (and the matching handler blocks below) only
// alongside building those two routes for real.
//
// Same story, same fix, applied again here: agent_identity, agent_schedule,
// agent_unschedule, agent_pause, agent_resume and agent_runs called
// /agents/identity, /agents/schedule, /agents/unschedule, /agents/pause and
// /agents/runs - none of which exist in http.ts, and none of which have any
// backing data model in schema.ts (no agent-identity table, no scheduler,
// no run-history table; there isn't even a cron for it in crons.ts). This
// isn't a missing route, it's an unbuilt subsystem, so the tools were
// removed rather than stubbed. Re-add only alongside building that
// autonomous-scheduling backend for real: identity/schedule storage, a cron
// that actually wakes agents up, and run-history writes.
export const AGENT_TOOLS: Tool[] = [
  {
    name: "agent_spawn",
    description:
      "Create a persistent NAMED agent with a goal - survives across sessions, state saved to vault under `agent/<name>` key. " +
      "Use this when a task is ONGOING and will span multiple sessions: research you'll return to, a project you're tracking, " +
      "a workflow you're iterating on. Track progress with agent_update, resume with agent_recall, audit with agent_ledger. " +
      "Do NOT spawn an agent for one-shot tasks (single research query, single trade) - just call the relevant tool directly. " +
      "Do NOT use this for ephemeral background data - use memory_add for that instead.",
    inputSchema: {
      type: "object",
      properties: {
        name:    { type: "string", description: "Unique agent name (e.g. 'market-researcher', 'onboarding-helper')" },
        goal:    { type: "string", description: "What this agent is trying to accomplish" },
        context: { type: "string", description: "Optional starting context, data, or notes for the agent" },
        workspaceProject: {
          type: "string",
          description:
            "Optional: file this agent into a named Finch workspace project (visible on the Agents page's " +
            "project switcher). Matched case-insensitively by name; created automatically if it doesn't exist " +
            "yet. Hosted vault only (no effect in local-vault mode).",
        },
      },
      required: ["name", "goal"],
    },
  },
  {
    name: "agent_recall",
    description:
      "Recall a persistent agent by name - loads its goal, current progress, findings, full history, and accumulated learnings (patterns the agent extracted from past runs). " +
      "Also pulls related context from memory/vault (code_session_save entries, deep_research reports, notes) matching the agent's goal, " +
      "so recall reflects everything relevant to the goal - not just what agent_update explicitly logged. " +
      "Use this to resume a long-running task, check what an agent last did, or hand context to a fresh LLM session. " +
      "Learnings compound over time - the more an agent runs, the smarter recall becomes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name as used in agent_spawn" },
      },
      required: ["name"],
    },
  },
  {
    name: "agent_update",
    description:
      "Update a persistent agent's progress and findings. Creates a new vault version automatically - full history preserved. " +
      "After each update an LLM extracts a single repeatable insight (if any) and appends it to the agent's accumulated learnings - the agent gets smarter every run. " +
      "Status options: active | blocked | complete.",
    inputSchema: {
      type: "object",
      properties: {
        name:     { type: "string", description: "Agent name" },
        progress: { type: "string", description: "What was accomplished in this update" },
        findings: { type: "string", description: "Key findings, data, or outputs from this step" },
        status:   { type: "string", enum: ["active", "blocked", "complete"], description: "Current agent status (default: active)" },
        nextStep: { type: "string", description: "What should happen next (optional - helps on recall)" },
      },
      required: ["name", "progress"],
    },
  },
  {
    name: "agent_ledger",
    description:
      "View the full activity ledger for a persistent agent - every update, status change, and finding logged in order. " +
      "Each entry is a vault version created by agent_update. Use this to audit what an agent has done, " +
      "trace its reasoning, or review progress since spawn.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Agent name as used in agent_spawn",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default 20, max 50)",
        },
      },
      required: ["name"],
    },
  },
];

const SpawnAgentSchema = z.object({
  name:    z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, "name must be lowercase alphanumeric with hyphens"),
  goal:    z.string().min(1),
  context: z.string().optional(),
  workspaceProject: z.string().optional(),
});
const RecallAgentSchema = z.object({ name: z.string().min(1) });
const UpdateAgentSchema = z.object({
  name:     z.string().min(1),
  progress: z.string().min(1),
  findings: z.string().optional(),
  status:   z.enum(["active", "blocked", "complete"]).optional(),
  nextStep: z.string().optional(),
});

// ── Structured output builders (schemas in output-schemas.ts) ───────────────
export function buildAgentLedger(name: string, versions: any[]): Record<string, unknown> {
  return {
    name,
    count: versions.length,
    versions: versions.map((v) => ({
      version: v.version,
      commitMsg: v.commitMsg ?? null,
      createdAt: v.createdAt ?? null,
    })),
  };
}

export async function handleAgentTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name === "agent_spawn") {
    const parsed = SpawnAgentSchema.safeParse(args);
    if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
    const { name: agentName, goal, context, workspaceProject } = parsed.data;

    const content = JSON.stringify({
      goal,
      status: "active",
      spawnedAt: new Date().toISOString(),
      context: context ?? null,
      updates: [],
    }, null, 2);

    const savePayload: Record<string, unknown> = {
      type:    "memory",
      key:     `agent/${agentName}`,
      title:   `Agent: ${agentName}`,
      content,
      contentType: "json",
      agentId: agentName,
      tags:    ["persistent-agent"],
      commitMsg: "spawned",
    };
    const localVault = getLocalVaultConfig();

    // Resolve the project name -> id server-side (auto-creates on first use).
    // No-op in local-vault mode - there is no project concept there.
    let resolvedProjectName: string | null = null;
    if (workspaceProject && !localVault) {
      const resolved = await resolveProjectId(workspaceProject);
      if (resolved) {
        savePayload.projectId = resolved.projectId;
        resolvedProjectName = resolved.name;
      }
    }

    const data = localVault
      ? localVaultSave(localVault, savePayload as any)
      : await callConvex("/vault/save", "POST", savePayload, "vault_save") as { key?: string; version?: number; error?: string };

    if ((data as any).error) return { content: [{ type: "text", text: `Error: ${(data as any).error}` }], isError: true };
    const projectLine = resolvedProjectName ? `\n**Project:** ${resolvedProjectName}` : "";
    return {
      content: [{ type: "text", text: `🤖 Agent **${agentName}** spawned${localVault ? " locally" : ""}.\n\n**Goal:** ${goal}${projectLine}\n\nRecall with \`agent_recall\` · Update progress with \`agent_update\`` }],
    };
  }

  if (name === "agent_recall") {
    const parsed = RecallAgentSchema.safeParse(args);
    if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };

    const localVault = getLocalVaultConfig();
    let data: { key?: string; content?: string; version?: number; updatedAt?: number; error?: string };
    try {
      data = localVault
        ? localVaultRead(localVault, `agent/${parsed.data.name}`)
        : await callConvex(`/vault/entry?key=agent/${parsed.data.name}`, "GET", undefined, "vault_read") as typeof data;
    } catch {
      data = { error: "not found" };
    }

    if (data.error || !data.content) {
      return { content: [{ type: "text", text: `Agent \`${parsed.data.name}\` not found. Spawn it first with \`agent_spawn\`.` }], isError: true };
    }

    let state: any = {};
    try { state = JSON.parse(data.content); } catch { /* non-JSON content */ }

    const updates: string[] = (state.updates ?? []).slice(-3).map((u: any, i: number) =>
      `  ${i + 1}. [${u.status ?? "active"}] ${u.progress}${u.nextStep ? ` → next: ${u.nextStep}` : ""}`
    );

    // Learnings - the agent's accumulated expertise across all prior updates.
    // Surfaced prominently so the caller (or downstream LLM) can apply them.
    const learningEntries: string[] = Array.isArray(state.learnings)
      ? state.learnings.map((l: any) => (typeof l === "string" ? l : l?.learned)).filter(Boolean)
      : [];

    const lines = [
      `## Agent: ${parsed.data.name}`,
      `**Goal:** ${state.goal ?? "-"}`,
      `**Status:** ${state.status ?? "active"}`,
      `**Version:** ${data.version ?? 1} · Updated: ${data.updatedAt ? new Date(data.updatedAt).toUTCString() : "-"}`,
    ];
    if (state.context) lines.push(`**Context:** ${state.context}`);

    if (learningEntries.length) {
      lines.push(`\n**🧠 Learned patterns (${learningEntries.length}):**`);
      // Show the most recent 8 - these are the most refined and relevant.
      learningEntries.slice(-8).forEach((l, i) => lines.push(`  ${i + 1}. ${l}`));
    }

    if (updates.length) lines.push(`\n**Recent updates:**\n${updates.join("\n")}`);
    if (state.nextStep) lines.push(`\n**Next step:** ${state.nextStep}`);

    // Related context - best-effort pull of relevant memory/vault knowledge
    // (code_session_save entries, deep_research reports, manual notes) so the
    // agent isn't blind to work done on its goal outside its own update log.
    // This is what makes recall "continuously have context" rather than only
    // ever knowing what agent_update explicitly logged.
    if (state.goal) {
      try {
        const related = await hybridMemorySearch(state.goal, 4);
        if (related.length) {
          lines.push(`\n**📎 Related context (${related.length}):**`);
          related.forEach((r) => {
            const title = r.metadata?.title ?? r.content.slice(0, 70).replace(/\n/g, " ");
            lines.push(`  • ${title}`);
          });
        }
      } catch { /* best-effort - recall must never fail because of this */ }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "agent_update") {
    const parsed = UpdateAgentSchema.safeParse(args);
    if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
    const { name: agentName, progress, findings, status = "active", nextStep } = parsed.data;

    return withAgentLock(agentName, async () => {
      const localVault = getLocalVaultConfig();
      // Load current state - inside the lock so two parallel updates can't
      // both read v=N and both write v=N+1 (the second silently loses).
      let current: { content?: string; error?: string };
      try {
        current = localVault
          ? localVaultRead(localVault, `agent/${agentName}`)
          : await callConvex(`/vault/entry?key=agent/${agentName}`, "GET", undefined, "vault_read") as typeof current;
      } catch {
        current = { error: "not found" };
      }
      if (current.error || !current.content) {
        return { content: [{ type: "text", text: `Agent \`${agentName}\` not found. Spawn it first.` }], isError: true };
      }

      let state: any = {};
      try { state = JSON.parse(current.content); } catch { /* start fresh */ }

      const update: any = { progress, status, timestamp: new Date().toISOString() };
      if (findings) update.findings = findings;
      if (nextStep) update.nextStep = nextStep;

      state.status  = status;
      state.nextStep = nextStep ?? state.nextStep;
      state.updates  = [...(state.updates ?? []), update].slice(-20);

      // ─── Learning extraction (v3.25) ────────────────────────────────────
      // Ask an LLM whether this update revealed a new repeatable insight.
      // Best-effort: if it returns NONE or fails, we save without appending.
      // The call sits inside the mutex so concurrent updates don't race on
      // the learnings array - same protection that already covers updates[].
      const priorLearnings: string[] = Array.isArray(state.learnings)
        ? state.learnings.map((l: any) => (typeof l === "string" ? l : l?.learned)).filter(Boolean)
        : [];
      const newLearning = await extractLearning(
        state.goal ?? "",
        (state.updates ?? []).slice(0, -1) as Array<{ progress: string; findings?: string; status?: string }>,
        priorLearnings,
        update,
      );
      if (newLearning) {
        const entry = { learned: newLearning, ts: Date.now(), fromUpdate: state.updates.length - 1 };
        state.learnings = [...(state.learnings ?? []), entry].slice(-MAX_LEARNINGS);
      }

      const savePayload = {
        type:    "memory",
        key:     `agent/${agentName}`,
        title:   `Agent: ${agentName}`,
        content: JSON.stringify(state, null, 2),
        contentType: "json",
        agentId: agentName,
        commitMsg: `[${status}] ${progress.slice(0, 60)}${newLearning ? " · +learning" : ""}`,
      };
      const data = localVault
        ? localVaultSave(localVault, savePayload)
        : await callConvex("/vault/save", "POST", savePayload, "vault_save") as { key?: string; version?: number; error?: string };

      if ((data as any).error) return { content: [{ type: "text", text: `Error: ${(data as any).error}` }], isError: true };

      const statusEmoji = status === "complete" ? "✅" : status === "blocked" ? "🚫" : "🔄";
      const learningLine = newLearning
        ? `\n\n🧠 **Learned:** ${newLearning}`
        : "";
      return {
        content: [{ type: "text", text: `${statusEmoji} Agent **${agentName}** updated (v${data.version}).\n\n**Progress:** ${progress}${findings ? `\n**Findings:** ${findings}` : ""}${nextStep ? `\n**Next:** ${nextStep}` : ""}${learningLine}` }],
      };
    });
  }

  if (name === "agent_ledger") {
    const { name: agentName, limit = 20 } = args as { name: string; limit?: number };
    if (!agentName) return { content: [{ type: "text", text: "name is required" }], isError: true };

    const cap = Math.min(Math.max(1, limit), 50);
    const localVault = getLocalVaultConfig();
    let data: { history?: Array<{ version: number; commitMsg?: string; createdAt?: number }>; error?: string };
    try {
      data = localVault
        ? localVaultHistory(localVault, `agent/${agentName}`)
        : await callConvex(
            `/vault/history?key=agent/${encodeURIComponent(agentName)}&limit=${cap}`,
            "GET", undefined, "vault_history",
          ) as typeof data;
    } catch {
      data = { history: [] };
    }

    if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

    const versions = (data.history ?? []).slice(0, cap);
    if (!versions.length) {
      return { content: [{ type: "text", text: `No ledger entries found for agent \`${agentName}\`. Spawn it first with \`agent_spawn\`.` }], structuredContent: buildAgentLedger(agentName, []) };
    }

    const rows = versions.map((v) => {
      const ts = v.createdAt ? new Date(v.createdAt).toUTCString() : "-";
      const msg = v.commitMsg ?? "(no message)";
      return `  v${v.version}  ${ts}\n         ${msg}`;
    });

    return {
      content: [{
        type: "text",
        text: `## Agent Ledger: ${agentName} (${versions.length} entries)\n\n${rows.join("\n\n")}`,
      }],
      structuredContent: buildAgentLedger(agentName, versions),
    };
  }

  return null;
}
