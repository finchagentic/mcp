// Tool definition + input schema for deep_research. Pure data/validation,
// no execution logic.

import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const DEEP_RESEARCH_TOOLS: Tool[] = [
  {
    name: "deep_research",
    description:
      "Web research engine: searches, scrapes, ranks and de-duplicates sources, then returns them " +
      "as a numbered, citable evidence pack for YOU to synthesise. This is the default (mode='sources') " +
      "and needs no API key. " +
      "You are the analyst: pass your own sub-queries via `queries` for full control over the angles " +
      "covered — otherwise they are derived from the topic. " +
      "Set mode='report' only if you want the server to write the prose itself (requires an LLM key, " +
      "and you cannot steer the result). " +
      "Profile-aware, auto-saves to vault, auto-links to related past reports.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Research question. Be specific: 'state of Base chain TVL Q2 2026' beats 'Base chain'.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "YOUR sub-queries to search (recommended). You know the topic and the user's intent, so plan " +
            "the angles yourself — 3-6 specific queries beat a generic decomposition. Omit to derive them.",
        },
        mode: {
          type: "string",
          enum: ["sources", "report"],
          description:
            "'sources' (default) returns the ranked evidence pack for you to synthesise — no API key needed. " +
            "'report' makes the server write the prose (needs an LLM key; you cannot steer it).",
        },
        depth: {
          type: "string",
          enum: ["fast", "standard", "deep"],
          description: "fast=flat planner, 3 sub-Qs, ~10 sources (~45s). standard=3 specialist angles, ~14 sources, reflection round (~90s). deep=5 angles + adversarial critic + reflection, ~20 sources (~180s). Default standard.",
        },
        focus: {
          type: "string",
          description: "Optional angle hint - 'technical', 'investment', 'news', 'comparison'. Steers planning.",
        },
        continueFrom: {
          type: "string",
          description: "Vault key of a previous deep_research report to build on. When provided, the planner focuses on UPDATES, GAPS, and NEW developments since that report - not re-treading covered ground. The new report explicitly references and extends the prior findings. Format: 'research/...' (use vault_list type:research to find candidates). This is the multi-session research feature - Perplexity / ChatGPT Deep Research don't have an equivalent.",
        },
        freshMode: {
          type: "boolean",
          description: "Force time-sensitive research mode: planner appends recency hints to sub-queries, source ranking boosts news domains (Reuters, AP, Bloomberg, etc.), and the synthesizer is told to prioritize current/recent claims. Auto-enabled when the query contains time-sensitive keywords (today, latest, breaking, this week, etc.).",
        },
        freshDays: {
          type: "number",
          description: "When freshMode is on, restrict to results from the last N days. Default 14 days. Capped at 90.",
        },
        liveSearch: {
          type: "boolean",
          description: "Enable Grok Live Search - pulls real-time results from X (Twitter), news, web, RSS during synthesis. Only works when Grok is the active LLM provider. Adds ~5-15s per Grok call. Default: auto (on when Grok is active).",
        },
        liveSearchSources: {
          type: "array",
          items: { type: "string", enum: ["web", "x", "news", "rss"] },
          description: "Which Live Search sources to pull from. Default: ['web', 'x', 'news']. Only respected when liveSearch is true and Grok is active.",
        },
        liveSearchDays: {
          type: "number",
          description: "Restrict Live Search to results from the last N days (max 365). Useful for time-sensitive queries. Default: no date filter.",
        },
        saveToVault: { type: "boolean", description: "Auto-save report to vault (default true)" },
      },
      required: ["query"],
    },
  },
];

export const InputSchema = z.object({
  query: z.string().min(3).max(500),
  queries: z.array(z.string().min(3).max(300)).max(12).optional(),
  mode: z.enum(["sources", "report"]).optional(),
  depth: z.enum(["fast", "standard", "deep"]).optional(),
  focus: z.string().max(80).optional(),
  continueFrom: z.string().max(200).optional(),
  freshMode: z.boolean().optional(),
  freshDays: z.number().int().min(1).max(90).optional(),
  liveSearch: z.boolean().optional(),
  liveSearchSources: z.array(z.enum(["web", "x", "news", "rss"])).optional(),
  liveSearchDays: z.number().int().min(1).max(365).optional(),
  saveToVault: z.boolean().optional(),
});
