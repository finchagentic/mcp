import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "crypto";
import { callConvex } from "../convex.js";
import { ToolResult } from "../types.js";
import { assertPublicUrl, refuseUrlText } from "../public-url.js";
import { getLocalVaultConfig, localVaultSearch } from "../local-vault.js";
import {
  getLocalMemoryConfig,
  localMemoryAdd,
  localMemorySearch,
  localMemoryList,
  localMemoryDelete,
  localMemoryProfile,
} from "../local-memory.js";
import { meaningfulTerms } from "../_text-search.js";
import { parseOrError } from "../_zod-helpers.js";

// memory_extract and memory_consolidate used to run their own LLM calls here
// (and a matching pair of Convex routes did the same server-side). Both are now
// two-pass: the tool fetches and stores, the caller decides what the facts are
// and how they merge. Local mode no longer needs a provider key at all.

// ─── Helpers (proxied through Convex - server-side Supermemory key) ──────────

// Normalize content for dedup: lowercase + collapse whitespace + trim. This
// catches accidental duplicates from agents that re-emit the same fact with
// different leading/trailing whitespace or casing.
function contentHash(content: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// In-process LRU cache of content hashes added in this session. Supermemory
// is eventually consistent - calling memory_add twice rapidly with the same
// content would otherwise both succeed because /memory/list doesn't see
// the just-inserted entry yet. The cache closes that race so same-session
// duplicates are caught even before the index sees them.
const RECENT_HASH_TTL_MS = 60 * 60 * 1000; // 1 hour
const RECENT_HASH_MAX = 500;
const recentHashCache = new Map<string, { id: string; title?: string; addedAt: number }>();

function rememberRecentHash(hash: string, id: string, title?: string): void {
  // Re-insert moves it to the end of the Map (most-recently-used).
  recentHashCache.delete(hash);
  recentHashCache.set(hash, { id, title, addedAt: Date.now() });
  while (recentHashCache.size > RECENT_HASH_MAX) {
    const oldest = recentHashCache.keys().next().value;
    if (oldest === undefined) break;
    recentHashCache.delete(oldest);
  }
}

function lookupRecentHash(hash: string): { id: string; title?: string; addedAt: number } | null {
  const hit = recentHashCache.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.addedAt > RECENT_HASH_TTL_MS) {
    recentHashCache.delete(hash);
    return null;
  }
  return hit;
}

// memory_delete must purge this too - otherwise a deleted memory's hash stays
// cached (up to an hour) and re-adding the exact same content within that
// window gets silently skipped as a "duplicate" of an id that no longer
// exists, when there is no longer any real duplicate to skip.
function forgetRecentHashById(id: string): void {
  for (const [hash, entry] of recentHashCache) {
    if (entry.id === id) { recentHashCache.delete(hash); break; }
  }
}

// Two-tier dedup lookup: in-process cache first (catches same-session
// dupes during eventual-consistency window), then a list call (catches
// cross-session dupes once they've been indexed). Returns null on any
// failure - dedup must never block legitimate writes.
async function findDuplicateMemory(hash: string): Promise<{ id: string; title?: string; addedAt?: number } | null> {
  const cached = lookupRecentHash(hash);
  if (cached) return cached;
  try {
    const local = getLocalMemoryConfig();
    const results: any[] = local
      ? await localMemoryList(local, 50)
      : ((await callConvex("/memory/list", "POST", { n: 50 }, "memory_list"))?.results ?? []);
    const match = results.find((r) => r.metadata?.contentHash === hash);
    if (!match) return null;
    return { id: match.id, title: match.metadata?.title, addedAt: match.metadata?.addedAt };
  } catch {
    return null;
  }
}

const SYNC_RETRY_DELAYS_MS = [500, 2000, 5000];

export async function syncToSupermemory(
  content: string,
  metadata: Record<string, unknown>,
  sourceUrl?: string,
): Promise<void> {
  const local = getLocalMemoryConfig();
  let lastError: unknown = null;

  if (local) {
    // Same retry shape as the Convex path below - a transient local-server
    // hiccup (e.g. mid-restart) shouldn't silently drop a vault_save-driven
    // memory sync with only a console.error nobody sees.
    for (let attempt = 0; attempt <= SYNC_RETRY_DELAYS_MS.length; attempt++) {
      try {
        await localMemoryAdd(local, content, metadata, sourceUrl);
        return;
      } catch (err) {
        lastError = err;
        const delay = SYNC_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
    const preview = content.slice(0, 120).replace(/\s+/g, " ");
    console.error(`[memory] local sync_failed after ${SYNC_RETRY_DELAYS_MS.length + 1} attempts: ${errMsg} | preview: "${preview}"`);
    // Chronicle has no local equivalent yet, so the failure is still logged
    // centrally (best-effort) even in local-memory mode - this is audit
    // trail, not memory content, so it doesn't defeat the local-mode intent.
    await callConvex("/chronicle/add", "POST", {
      type: "system",
      title: `Local memory sync failed after ${SYNC_RETRY_DELAYS_MS.length + 1} attempts`,
      detail: `Error: ${errMsg}\nPreview: ${preview}`,
      metadata: { ...metadata, sourceUrl, attempts: SYNC_RETRY_DELAYS_MS.length + 1, kind: "memory_sync_failed", backend: "local" },
      source: "mcp",
    }).catch(() => {});
    return;
  }

  const payload = {
    content,
    metadata,
    ...(sourceUrl ? { sourceUrl } : {}),
  };

  for (let attempt = 0; attempt <= SYNC_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await callConvex("/memory/add", "POST", payload, "memory_add");
      return;
    } catch (err) {
      lastError = err;
      const delay = SYNC_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  const preview = content.slice(0, 120).replace(/\s+/g, " ");
  await callConvex("/chronicle/add", "POST", {
    type: "system",
    title: `Supermemory sync failed after ${SYNC_RETRY_DELAYS_MS.length + 1} attempts`,
    detail: `Error: ${errMsg}\nPreview: ${preview}`,
    metadata: { ...metadata, sourceUrl, attempts: SYNC_RETRY_DELAYS_MS.length + 1, kind: "memory_sync_failed" },
    source: "mcp",
  }).catch(() => {
    // Chronicle write itself failed - last-resort console; supermemory is best-effort.
    console.error(`[memory] sync_failed: ${errMsg} | preview: "${preview}"`);
  });
}

// A real auth failure must never be reported as "0 results found" - that
// reads as "your account genuinely has nothing saved" when the actual
// problem is the token/key was rejected. Only genuinely transient errors
// (network hiccup, the other RRF side still succeeding) degrade silently
// to an empty contribution - an auth failure is rethrown so it reaches the
// user instead of being swallowed. Found live: memory_search/memory_context/
// memory_insight/memory_consolidate all share this retrieval path, so a
// single fix here closes the same bug across all four tools.
function isAuthFailure(err: unknown): boolean {
  return err instanceof Error && /Authentication required/i.test(err.message);
}

export async function searchSupermemory(
  query: string,
  limit = 10,
): Promise<Array<{ id: string; content: string; metadata: any; score?: number }>> {
  try {
    const local = getLocalMemoryConfig();
    if (local) return await localMemorySearch(local, query, limit);
    const data = await callConvex("/memory/search", "POST", { q: query, n: limit }, "memory_search");
    return data?.results ?? [];
  } catch (err) {
    if (isAuthFailure(err)) throw err;
    return [];
  }
}

// Lexical (full-text / BM25-style) search over the Convex memories mirror.
// Returns rows in relevance-rank order so the fusion step can use rank
// directly without re-normalizing raw scores.
async function lexicalSearch(
  query: string,
  limit = 30,
): Promise<Array<{ id: string; content: string; metadata: any; rank: number }>> {
  try {
    const data = await callConvex("/memory/lexical", "POST", { q: query, n: limit }, "memory_search");
    const rows = (data?.results ?? []) as any[];
    return rows.map((r, idx) => ({
      id:       r.id,
      content:  r.content ?? "",
      metadata: r.metadata ?? {},
      rank:     typeof r.rank === "number" ? r.rank : idx,
    }));
  } catch (err) {
    if (isAuthFailure(err)) throw err;
    return [];
  }
}

// Reciprocal Rank Fusion - combines two ranked lists into one without needing
// to normalize raw scores. Each list contributes 1/(k + rank) to a doc's
// final score; docs that appear in both lists rank above docs in only one.
// k=60 is the canonical TREC/Lucene default; ours can be tuned via the eval
// suite. See: "Reciprocal Rank Fusion outperforms Condorcet and individual
// Rank Learning Methods" (Cormack et al., SIGIR 2009).
const RRF_K = 60;

export interface HybridResult {
  id: string;
  content: string;
  metadata: any;
  fusedScore: number;
  semanticRank: number | null;
  lexicalRank: number | null;
  // Final score post-decay weighting - what we rank the user-facing list by.
  finalScore?: number;
  // Internal - preserved for callers (memory_search prints these).
  score?: number;
}

export function fuseRRF(
  semantic: Array<{ id: string; content: string; metadata: any; score?: number }>,
  lexical: Array<{ id: string; content: string; metadata: any; rank: number }>,
  k = RRF_K,
): HybridResult[] {
  const merged = new Map<string, HybridResult>();

  semantic.forEach((doc, rank) => {
    merged.set(doc.id, {
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      fusedScore: 1 / (k + rank),
      semanticRank: rank,
      lexicalRank: null,
      score: doc.score,
    });
  });

  lexical.forEach((doc) => {
    const existing = merged.get(doc.id);
    const lexContrib = 1 / (k + doc.rank);
    if (existing) {
      existing.fusedScore += lexContrib;
      existing.lexicalRank = doc.rank;
    } else {
      merged.set(doc.id, {
        id: doc.id,
        content: doc.content,
        metadata: doc.metadata,
        fusedScore: lexContrib,
        semanticRank: null,
        lexicalRank: doc.rank,
      });
    }
  });

  return [...merged.values()].sort((a, b) => b.fusedScore - a.fusedScore);
}

// Hybrid retrieval: fan out semantic + lexical in parallel, fuse via RRF.
// Returns the unified candidate list - callers (memory_search) layer their
// own decay + reranking on top.
//
// Local mode skips the separate lexical fusion entirely: the self-hosted
// supermemory server already does hybrid semantic+lexical search server-side
// (that's the whole point of the RRF layer here - fusing cloud Supermemory's
// semantic-only results with Convex's own BM25 mirror table), so re-fusing
// on top of an already-hybrid result set would be redundant.
export async function hybridMemorySearch(query: string, limit = 30): Promise<HybridResult[]> {
  const local = getLocalMemoryConfig();
  if (local) {
    const results = await searchSupermemory(query, limit); // routes to localMemorySearch
    return results.map((r, rank) => ({
      id: r.id,
      content: r.content,
      metadata: r.metadata,
      fusedScore: r.score ?? 1 / (RRF_K + rank),
      semanticRank: rank,
      lexicalRank: null,
      score: r.score,
    }));
  }

  // Over-fetch from each side so the fusion has enough overlap to find
  // co-ranked docs. Each side returns up to `limit` items; the union is
  // capped to keep response size bounded.
  const [semantic, lexical] = await Promise.all([
    searchSupermemory(query, limit),
    lexicalSearch(query, limit),
  ]);
  return fuseRRF(semantic, lexical);
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "memory_add",
    description:
      "Add content to your Finch memory - no setup needed, no extra API keys. " +
      "Unlike vault_save, memory_add is instant: no versioning, no type required. " +
      "Use for notes, decisions, preferences, or anything you want to find later. " +
      "Pass sourceUrl to fetch and index any web page, GitHub repo, or Notion page automatically - " +
      "searchable in ~30s. Retrieval is full-text (keyword) search, not embeddings - " +
      "'what did I say about ETH yield?' finds notes containing those words or close variants, " +
      "not unrelated phrasing with the same meaning. " +
      "Auto-deduplicates: identical content in your recent 50 memories is skipped (override with force:true). " +
      "Also surfaces up to 3 existing memories that share real keyword overlap with what you just saved (a " +
      "possible-conflict HINT, not a verdict - Finch doesn't call an LLM to judge this). When that shows up, " +
      "read them and decide yourself whether the new one supersedes an old preference/fact; if so, say so in a " +
      "follow-up memory_add, or fold both into one with memory_consolidate.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to remember - text, markdown, or a note. Use a short title if providing sourceUrl." },
        title: { type: "string", description: "Optional title for this memory" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for grouping" },
        sourceUrl: { type: "string", description: "URL to fetch and index automatically (GitHub, Notion, web page, etc.). Content becomes searchable in ~30s." },
        force: { type: "boolean", description: "Bypass duplicate detection. Set true to allow a second copy of identical content." },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_search",
    description:
      "Full-text (keyword) search over your stored memories, with 90-day time-decay weighting so " +
      "recent notes outrank stale ones with similar wording. Good for exact-token lookups (env var " +
      "names, contract addresses, IDs, specific phrases) - it does not understand meaning, so " +
      "'low risk crypto yield' will not match a note phrased as 'conservative DeFi strategies' " +
      "unless the words themselves overlap.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_context",
    description:
      "Retrieve the most relevant memories for a topic, formatted as AI-ready context. " +
      "Use at the start of research tasks to prime with everything stored about a topic. " +
      "Uses full-text (keyword) search, not embeddings - phrase your topic with the words " +
      "you expect were actually used when the memory was saved.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic to load context for, e.g. 'ETH liquid staking' or 'user DeFi preferences'" },
        limit: { type: "number", description: "Max entries to include (default 8)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "memory_profile",
    description:
      "Show your memory stats - total memories stored, your memory space, and connected sources. " +
      "Useful for auditing what Finch knows about you.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "memory_list",
    description:
      "List your most recent Finch memories without a search query. " +
      "Useful to browse what's stored or audit before clearing. " +
      "Sorted by most recently added.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max memories to return (default 20)" },
        tag: { type: "string", description: "Optional: filter by tag" },
      },
      required: [],
    },
  },
  {
    name: "memory_delete",
    description:
      "PERMANENT. Delete a specific memory by its ID — it cannot be recovered. " +
      "Get IDs from memory_search or memory_list. Requires confirm: true. " +
      "Show the user which memory you are about to delete (title/content) and get their " +
      "agreement first — IDs come from search results and are easy to mix up.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to delete (from memory_search or memory_list results)" },
        confirm: { type: "boolean", description: "Must be true to delete. Guards against irreversible loss." },
      },
      required: ["id", "confirm"],
    },
  },
  {
    name: "memory_insight",
    description:
      "Get a full intelligence report on any topic - combines memory AND vault entries, " +
      "then identifies knowledge gaps and suggests next actions. " +
      "Use this before starting any research or trade decision to see everything Finch already knows. " +
      "Returns: confidence level, what you know, coverage timeline, gaps, and recommended next steps.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic to analyze - token, protocol, strategy, or any concept" },
        depth: { type: "string", enum: ["quick", "standard", "deep"], description: "How many sources to pull (default: standard)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "memory_extract",
    description:
      "Save discrete facts, preferences and decisions to memory as individually searchable atoms " +
      "instead of one wall of text. Two-pass, no API key needed. " +
      "PASS 1 — call with `text`: returns the text with the extraction rubric. " +
      "PASS 2 — call with `facts: [...]`: stores each fact separately, deduped. " +
      "YOU decide what the facts are; this tool stores them. Best for chat logs, research notes, meeting summaries.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "PASS 1. Unstructured content to pull facts out of - notes, research, chat logs." },
        facts: {
          type: "array",
          items: { type: "string" },
          description: "PASS 2. The atomic facts you extracted. Each is stored as its own searchable memory. Supplying this skips pass 1 entirely.",
        },
        source: { type: "string", description: "Optional label for where this came from (e.g. 'telegram', 'research', 'meeting')" },
      },
      required: [],
    },
  },
  {
    name: "memory_consolidate",
    description:
      "Clean up fragmented knowledge after heavy research sessions. Two-pass, no API key needed. " +
      "PASS 1 — call with `topic`: fetches every memory on that topic and returns them numbered, with the " +
      "merge rubric. " +
      "PASS 2 — call with `topic` + `summary`: saves your merged version as a new consolidated memory. " +
      "Originals always remain intact.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic to consolidate memories for (e.g. 'ETH liquid staking', 'Base DeFi')" },
        limit: { type: "number", description: "Max source memories to fetch (default 12)" },
        summary: {
          type: "string",
          description: "PASS 2 only. Your merged summary. Supplying it switches this tool from 'return the memories' to 'save the result'.",
        },
      },
      required: ["topic"],
    },
  },
];

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const AddSchema = z.object({
  content: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sourceUrl: z.string().url().optional(),
  force: z.boolean().optional(),
});

const SearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().optional(),
});

const ContextSchema = z.object({
  topic: z.string().min(1),
  limit: z.number().optional(),
});

const ListSchema = z.object({
  limit: z.number().optional(),
  tag: z.string().optional(),
});

const DeleteMemSchema = z.object({ id: z.string().min(1) });
const InsightSchema = z.object({
  topic: z.string().min(1),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
});
const ExtractSchema = z.object({
  text: z.string().min(1).optional(),
  facts: z.array(z.string().min(1)).min(1).max(50).optional(),
  source: z.string().optional(),
}).refine((v) => !!v.text || !!v.facts, { message: "pass `text` (pass 1) or `facts` (pass 2)" });

const ConsolidateSchema = z.object({
  topic: z.string().min(1),
  limit: z.number().optional(),
  summary: z.string().min(1).optional(),
});

// ─── Handler ─────────────────────────────────────────────────────────────────

// ── Structured output builders (schemas in output-schemas.ts) ───────────────
export function buildMemorySearch(query: string, decayed: any[]): Record<string, unknown> {
  return {
    query,
    count: decayed.length,
    memories: decayed.map((r) => ({
      id: r.id,
      title: r.metadata?.title ?? null,
      content: r.content,
      score: r._decayedScore ?? r.fusedScore ?? null,
      ageDays: r._ageDays != null ? Math.round(r._ageDays) : null,
      pinned: !!r._pinned,
      semanticRank: r.semanticRank ?? null,
      lexicalRank: r.lexicalRank ?? null,
    })),
  };
}

export function buildMemoryContext(topic: string, results: any[]): Record<string, unknown> {
  return {
    topic,
    count: results.length,
    memories: results.map((r) => ({ title: r.metadata?.title ?? null, content: r.content })),
  };
}

export function buildMemoryProfile(data: any): Record<string, unknown> {
  return { space: data?.space ?? null, total: data?.total ?? 0, status: data?.status ?? "unknown" };
}

export function buildMemoryList(tag: string | undefined, results: any[]): Record<string, unknown> {
  return {
    tag: tag ?? null,
    count: results.length,
    memories: results.map((r) => ({ id: r.id, title: r.metadata?.title ?? null, content: r.content })),
  };
}

export async function handleMemoryTool(name: string, args: unknown): Promise<ToolResult | null> {
  switch (name) {
    case "memory_add": {
      const parsed = parseOrError(AddSchema, args);
      if (!parsed.ok) return parsed.error;

      const { content, title, tags, sourceUrl, force } = parsed.data;

      // `sourceUrl` is not stored, it is fetched and indexed — by the local
      // memory server on the user's own machine when local mode is on. An
      // unrestricted URL therefore pulls LAN and loopback content into memory,
      // where memory_search reads it straight back out.
      if (sourceUrl) {
        const unsafe = await assertPublicUrl(sourceUrl);
        if (unsafe) {
          return { content: [{ type: "text", text: refuseUrlText(sourceUrl, unsafe) }], isError: true };
        }
      }

      const hash = contentHash(content);

      // Dedup: skip if an identical-content memory exists in recent history,
      // unless caller passed `force: true`. URL-sourced memories skip dedup -
      // the same URL may legitimately be re-indexed after content changes.
      if (!force && !sourceUrl) {
        const existing = await findDuplicateMemory(hash);
        if (existing) {
          const age = existing.addedAt ? Math.max(0, Math.round((Date.now() - existing.addedAt) / 60_000)) : null;
          return {
            content: [{
              type: "text",
              text: [
                `↩️ **Duplicate skipped** - identical content already stored.`,
                `Existing ID: \`${existing.id}\`${existing.title ? ` · ${existing.title}` : ""}${age !== null ? ` · added ${age}m ago` : ""}`,
                ``,
                `Override with \`memory_add content: "…" force: true\` if you really want a second copy.`,
              ].join("\n"),
            }],
          };
        }
      }

      const addMetadata = { title, tags, source: "memory_add", addedAt: Date.now(), contentHash: hash };
      const localAdd = getLocalMemoryConfig();
      const data = localAdd
        ? await localMemoryAdd(localAdd, content, addMetadata, sourceUrl).catch((err: any) => ({ error: err.message }))
        : await callConvex("/memory/add", "POST", { content, metadata: addMetadata, ...(sourceUrl ? { sourceUrl } : {}) }, "memory_add").catch((err: any) => ({ error: err.message }));

      if (data?.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

      // Cache the hash so an immediate second call with identical content
      // dedupes even before supermemory has indexed the first one.
      if (!sourceUrl) rememberRecentHash(hash, data?.id ?? "saved", title);

      // Conflict hint, not a proof - no LLM call server-side (two-pass, no
      // API key). Resurfaces related existing memories so the calling
      // model decides. Best-effort, must never block the save above.
      let conflictNote = "";
      try {
        const related = await hybridMemorySearch(content, 8);
        // hybridMemorySearch's score is rank-based and normalized per-call -
        // a single weak match (one common word) can still come back as
        // "top result, 100%" purely for lack of competition. Found live:
        // "the user's favorite pizza topping" registered as "related" to a
        // completely unrelated units-preference memory, because both
        // happened to say "user". Counting actual shared meaningful terms
        // (>=2 distinct, not stop words) is a real, absolute bar instead of
        // trusting a relative score - "user" alone no longer qualifies,
        // "user"+"prefers"+"units"+"metric"/"imperial" does.
        const newTerms = new Set(meaningfulTerms(content));
        const candidates = related
          .filter((r) => r.id !== data?.id && contentHash(r.content) !== hash)
          .map((r) => ({ r, overlap: new Set(meaningfulTerms(r.content).filter((t) => newTerms.has(t))).size }))
          .filter((x) => x.overlap >= 2)
          .sort((a, b) => b.overlap - a.overlap)
          .slice(0, 3)
          .map((x) => x.r);
        if (candidates.length) {
          conflictNote = "\n\n⚠️ **Possibly related existing memories** - skim these for a conflict with what you just saved (e.g. an old preference this replaces):\n" +
            candidates.map((r) => `- \`${r.id}\`: ${r.content.slice(0, 100)}${r.content.length > 100 ? "…" : ""}`).join("\n");
        }
      } catch {
        // best-effort only
      }

      return {
        content: [{
          type: "text",
          text: [
            `🧠 **Memory added** - ID: \`${data?.id ?? "saved"}\``,
            title ? `Title: ${title}` : "",
            sourceUrl ? `Source: ${sourceUrl} (indexing in background…)` : "",
            tags?.length ? `Tags: ${tags.join(", ")}` : "",
            ``,
            `Find it with: \`memory_search query: "${(title ?? content).slice(0, 40)}"\``,
          ].filter(Boolean).join("\n") + conflictNote,
        }],
      };
    }

    case "memory_search": {
      const parsed = parseOrError(SearchSchema, args);
      if (!parsed.ok) return parsed.error;

      const { query, limit = 10 } = parsed.data;
      // Over-fetch so post-decay ranking still has enough material.
      const overfetch = Math.min(50, Math.max(limit * 2, 20));

      // ─── Retrieval ───────────────────────────────────────────────────
      // Fan out two full-text queries (searchSupermemory and lexicalSearch -
      // both call Convex full-text search under different names, there is no
      // embedding step despite the "semantic"/"Supermemory" naming) in
      // parallel, fuse via Reciprocal Rank Fusion so results present in both
      // rank highest.
      const fused = await hybridMemorySearch(query, overfetch);
      const raw = fused as Array<{
        id: string; content: string; metadata: any; fusedScore: number;
        semanticRank: number | null; lexicalRank: number | null; score?: number;
      }>;

      if (!raw.length) return { content: [{ type: "text", text: `No memories found for: "${query}"\nTry adding content with \`memory_add\` or \`vault_save\`.` }], structuredContent: buildMemorySearch(query, []) };

      // ─── Time-decay weighting ─────────────────────────────────────────
      // Apply an age-aware multiplier to the fused RRF score so a relevant
      // old casual note doesn't outrank a recent precise one. Half-life of
      // 90 days - a memory loses ~30% relevance over a quarter.
      // Pinned memories (metadata.pinned) bypass decay.
      const HALF_LIFE_DAYS = 90;
      const decayed = raw.map((r) => {
        const ageMs = Date.now() - (r.metadata?.addedAt ?? 0);
        const ageDays = ageMs > 0 ? ageMs / 86_400_000 : 0;
        const pinned = r.metadata?.pinned === true;
        const decayMul = pinned ? 1 : Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
        return {
          ...r,
          _decayedScore: r.fusedScore * decayMul,
          _ageDays:      ageDays,
          _pinned:       pinned,
        };
      })
        .sort((a, b) => b._decayedScore - a._decayedScore)
        .slice(0, limit);

      // Hybrid mode is on if any result was lexically ranked too.
      const hybridHits = decayed.filter((r) => r.lexicalRank !== null).length;
      const modeLabel = hybridHits > 0
        ? `Hybrid (semantic + lexical), ${hybridHits} dual-ranked`
        : `Semantic only (lexical empty for this query)`;
      const header = `🔍 **Memory Search**: "${query}" - ${decayed.length} result(s) · ${modeLabel} · time-decay 90d half-life`;
      const rows = decayed.map((r, i) => {
        // Per-result rank annotation: shows whether each hit came from
        // semantic, lexical, or both. Cheap signal of retrieval quality.
        const tags: string[] = [];
        if (r.semanticRank !== null) tags.push(`sem#${r.semanticRank + 1}`);
        if (r.lexicalRank !== null)  tags.push(`lex#${r.lexicalRank + 1}`);
        const tagStr = tags.length ? ` (${tags.join(", ")})` : "";
        const score = ` [${(r._decayedScore * 1000).toFixed(0)}]`;
        const title = r.metadata?.title ?? "";
        const ageNote = r._ageDays > 0 ? ` · ${Math.round(r._ageDays)}d` : "";
        const pinBadge = r._pinned ? " 📌" : "";
        const preview = r.content.slice(0, 200).replace(/\n/g, " ");
        return [
          `${i + 1}.${score}${pinBadge}${title ? ` **${title}**` : ""}${ageNote}${tagStr} \`${r.id}\``,
          `   ${preview}${r.content.length > 200 ? "…" : ""}`,
        ].join("\n");
      });

      // ─── Promotion hint when N+ memories cluster on a topic ───────────
      // If 4+ memories surface for one query they're collectively load-
      // bearing - suggest the user promote them to a single versioned vault
      // entry so the knowledge becomes structured and citable.
      let promotionHint = "";
      if (decayed.length >= 4) {
        const topic = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
        promotionHint = [
          ``,
          `💡 **${decayed.length} memories on this topic.** Consider promoting to a vault entry for cleaner versioning + linking:`,
          ``,
          `\`\`\``,
          `memory_consolidate topic="${query}" n=${Math.min(decayed.length, 8)}`,
          `# Then: copy the summary and:`,
          `vault_save type=research key=memory-cluster/${topic} content="<the consolidation>"`,
          `\`\`\``,
        ].join("\n");
      }

      return { content: [{ type: "text", text: [header, "", ...rows, promotionHint].filter(Boolean).join("\n") }], structuredContent: buildMemorySearch(query, decayed) };
    }

    case "memory_context": {
      const parsed = parseOrError(ContextSchema, args);
      if (!parsed.ok) return parsed.error;

      const { topic, limit = 8 } = parsed.data;
      // v3.25.1: use hybrid retrieval so context loading picks up exact-token
      // matches (env var names, model IDs, contract addresses) that semantic-
      // only would miss. Same fusion as memory_search.
      const results = await hybridMemorySearch(topic, limit);

      if (!results.length) return { content: [{ type: "text", text: `No context found for: "${topic}"\nBuild your memory base with vault_save or memory_add.` }], structuredContent: buildMemoryContext(topic, []) };

      const contextParts = results.map((r, i) => {
        const title = r.metadata?.title ? `### ${r.metadata.title}` : `### Memory ${i + 1}`;
        return `${title}\n${r.content}`;
      });
      const summary = results.map(r => r.metadata?.title ?? r.content.slice(0, 50)).join(", ");

      return {
        content: [{
          type: "text",
          text: [
            `🧠 **Context** for: "${topic}" (hybrid retrieval)`,
            `Loaded ${results.length} relevant memories: ${summary}`,
            ``,
            `---`,
            ``,
            contextParts.join("\n\n---\n\n"),
          ].join("\n"),
        }],
        structuredContent: buildMemoryContext(topic, results),
      };
    }

    case "memory_profile": {
      const localProfileCfg = getLocalMemoryConfig();
      const data = localProfileCfg
        ? await localMemoryProfile(localProfileCfg).catch(() => null)
        : await callConvex("/memory/profile", "GET", undefined, "memory_profile").catch(() => null);
      const total = data?.total ?? 0;
      const status = data?.status ?? "unknown";
      const space = data?.space ?? "-";

      return {
        content: [{
          type: "text",
          text: [
            `🧠 **Finch Memory**`,
            ``,
            `Space: \`${space}\``,
            `Total memories: **${total}**`,
            `Status: ${status === "ok" ? "✅ Active" : status === "not_configured" ? "⏳ Setting up" : "⚠️ " + status}`,
            ``,
            `**Auto-synced sources:**`,
            `• vault_save - ✅`,
            `• memory_add (URL indexing) - ✅`,
            `• Google Drive / Gmail / Notion - connect at finchagentic.com`,
            ``,
            `**Capabilities:** Full-text (keyword) search with 90-day time-decay ranking - not embeddings, no vector search.`,
          ].join("\n"),
        }],
        structuredContent: buildMemoryProfile(data),
      };
    }

    case "memory_list": {
      const parsed = parseOrError(ListSchema, args ?? {});
      if (!parsed.ok) return parsed.error;
      const { limit = 20, tag } = parsed.data;
      const localList = getLocalMemoryConfig();
      let results: any[];
      if (localList) {
        try {
          results = await localMemoryList(localList, limit, tag);
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      } else {
        const data = await callConvex("/memory/list", "POST", { n: limit, tag }, "memory_list").catch((err: any) => ({ error: err.message })) as any;
        if (data?.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
        results = data?.results ?? [];
      }
      if (!results.length) return { content: [{ type: "text", text: `No memories stored yet. Use \`memory_add\` to start building your knowledge base.` }], structuredContent: buildMemoryList(tag, []) };
      const header = `🧠 **Memories** (${results.length} shown${tag ? `, tag: ${tag}` : ""})`;
      const rows = results.map((r: any, i: number) => {
        const title = r.metadata?.title ?? "";
        const preview = r.content.slice(0, 100).replace(/\n/g, " ");
        return `${i + 1}. \`${r.id}\`${title ? ` **${title}**` : ""}\n   ${preview}${r.content.length > 100 ? "…" : ""}`;
      });
      return { content: [{ type: "text", text: [header, "", ...rows].join("\n") }], structuredContent: buildMemoryList(tag, results) };
    }

    case "memory_delete": {
      const parsed = parseOrError(DeleteMemSchema, args);
      if (!parsed.ok) return parsed.error;
      if ((args as { confirm?: boolean })?.confirm !== true) {
        return {
          content: [{
            type: "text",
            text:
              "Refusing to delete: this permanently removes the memory and cannot be undone. " +
              "Show the user the memory you intend to delete, then pass `confirm: true`.",
          }],
          isError: true,
        };
      }
      const localDel = getLocalMemoryConfig();
      if (localDel) {
        try {
          await localMemoryDelete(localDel, parsed.data.id);
        } catch (err: any) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
      } else {
        const data = await callConvex("/memory/delete", "POST", { id: parsed.data.id }, "memory_delete").catch((err: any) => ({ error: err.message }));
        if (data?.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      }
      forgetRecentHashById(parsed.data.id);
      return { content: [{ type: "text", text: `🗑️ Memory deleted: \`${parsed.data.id}\`` }] };
    }

    case "memory_insight": {
      const parsed = parseOrError(InsightSchema, args);
      if (!parsed.ok) return parsed.error;

      const { topic, depth = "standard" } = parsed.data;
      const memLimit = depth === "deep" ? 15 : depth === "quick" ? 5 : 8;

      // v3.25.1: hybrid retrieval for memory side (was semantic-only) so the
      // intelligence report surfaces exact-token matches alongside meaning
      // matches. Vault side runs in parallel as before - but only against
      // Convex when the vault isn't local; a local vault's topic string must
      // never leave the machine, and this never checked that before.
      const localVault = getLocalVaultConfig();
      const [memResults, vaultData] = await Promise.all([
        hybridMemorySearch(topic, memLimit),
        localVault
          ? Promise.resolve(localVaultSearch(localVault, topic, { limit: 6 }))
          : callConvex(`/vault/search?q=${encodeURIComponent(topic)}&limit=6`, "GET", undefined, "vault_search").catch(() => ({ results: [] })),
      ]);

      const vaultResults: any[] = vaultData.results ?? [];
      const total = memResults.length + vaultResults.length;

      if (!total) {
        return {
          content: [{
            type: "text",
            text: [
              `🔮 **Intelligence Report: "${topic}"**`,
              ``,
              `No knowledge found yet.`,
              ``,
              `**Start building:**`,
              `• \`deep_research query: "${topic}" depth: "standard"\` - multi-agent research now`,
              `• \`memory_add content: "..." \` - add a manual note`,
              `• \`schedule_research topic: "${topic}"\` - recurring monitor that saves to vault`,
            ].join("\n"),
          }],
        };
      }

      // Confidence tier
      const confidence = total >= 10 ? "🟢 High" : total >= 4 ? "🟡 Medium" : "🔴 Low";

      // Timeline from metadata timestamps
      const timestamps = memResults.map(r => r.metadata?.addedAt as number).filter(Boolean);
      const oldest = timestamps.length ? Math.min(...timestamps) : null;
      const newest = timestamps.length ? Math.max(...timestamps) : null;
      const daysSinceUpdate = newest ? Math.round((Date.now() - newest) / 86_400_000) : null;

      // Knowledge summary lines
      const memLines = memResults.slice(0, 6).map(r => {
        const title = r.metadata?.title ?? r.content.slice(0, 70).replace(/\n/g, " ");
        const score = r.score != null ? ` [${(r.score * 100).toFixed(0)}%]` : "";
        return `  •${score} ${title}`;
      });
      const vaultLines = vaultResults.slice(0, 4).map((r: any) =>
        `  • [vault/${r.type}] ${r.title} - v${r.version}`
      );

      // Gap analysis
      const gaps: string[] = [];
      if (daysSinceUpdate !== null && daysSinceUpdate > 7) {
        gaps.push(`Stale data - last update ${daysSinceUpdate} day${daysSinceUpdate !== 1 ? "s" : ""} ago`);
      }
      if (!vaultResults.some((r: any) => r.type === "research")) {
        gaps.push("No formal research saved - only informal notes exist");
      }
      if (memResults.length < 3) {
        gaps.push("Thin coverage - fewer than 3 semantic memories on this topic");
      }
      if (!vaultResults.some((r: any) => r.type === "execution")) {
        gaps.push("No execution history - no trades or actions logged");
      }

      const lines = [
        `🔮 **Intelligence Report: "${topic}"**`,
        `Confidence: ${confidence} · ${memResults.length} semantic memories · ${vaultResults.length} vault entries`,
        oldest ? `Coverage: ${new Date(oldest).toLocaleDateString("en-US")} – ${daysSinceUpdate === 0 ? "today" : daysSinceUpdate !== null ? `${daysSinceUpdate}d ago` : "unknown"}` : "",
        ``,
        `**What you know:**`,
        ...memLines,
        ...(vaultLines.length ? ["", "**Vault entries:**", ...vaultLines] : []),
        ``,
      ];

      if (gaps.length) {
        lines.push(`**⚠️ Knowledge gaps:**`);
        gaps.forEach(g => lines.push(`  • ${g}`));
        lines.push("");
      }

      lines.push(`**Suggested actions:**`);
      if (gaps.some(g => g.includes("research") || g.includes("Stale"))) {
        lines.push(`• \`deep_research query: "${topic}" depth: "standard"\` - refresh with multi-agent research`);
      }
      lines.push(`• \`memory_context topic: "${topic}"\` - inject full context into your next prompt`);
      lines.push(`• \`schedule_research topic: "${topic}"\` - monitor this topic continuously`);

      return { content: [{ type: "text", text: lines.filter(l => l !== undefined).join("\n") }] };
    }

    case "memory_extract": {
      const parsed = parseOrError(ExtractSchema, args);
      if (!parsed.ok) return parsed.error;
      const { text, facts, source = "extract" } = parsed.data;

      // ── PASS 1: hand the text back with the extraction rubric ───────────
      // Deciding what counts as a fact is judgement about *this user's*
      // content - the caller has the conversation, the tool doesn't.
      if (!facts) {
        return {
          content: [{
            type: "text",
            text: [
              `📄 **Extract facts from this** (${text!.length.toLocaleString()} chars)`,
              ``,
              `---`,
              text!.slice(0, 20_000) + (text!.length > 20_000 ? `\n\n…[truncated ${text!.length - 20_000} chars]` : ""),
              `---`,
              ``,
              `## Rules`,
              ``,
              `- One **atomic** fact per entry — independently true and independently searchable.`,
              `- Self-contained: "prefers Aerodrome over Uniswap on Base for stable pairs", not "prefers it".`,
              `- Keep facts, preferences and decisions. Drop pleasantries, restated questions and anything`,
              `  already obvious from the user's other memories.`,
              `- Preserve numbers, dates, addresses and names exactly. Never round or paraphrase them.`,
              `- Do not infer beyond the text. If it wasn't stated, it isn't a fact.`,
              `- 3-10 facts is typical. Fewer is fine — do not pad to hit a count.`,
              ``,
              `Then call \`memory_extract\` again with \`facts: ["…", "…"]\`${source !== "extract" ? ` and \`source: "${source}"\`` : ""} to store them.`,
            ].join("\n"),
          }],
        };
      }

      // ── PASS 2: store each fact as its own memory ───────────────────────
      const localExtractCfg = getLocalMemoryConfig();
      const metaFor = () => ({ source, addedAt: Date.now() });
      const results = await Promise.allSettled(
        facts.map((fact) =>
          localExtractCfg
            ? localMemoryAdd(localExtractCfg, fact, metaFor())
            : callConvex("/memory/add", "POST", { content: fact, metadata: metaFor() }, "memory_add"),
        ),
      );
      const saved = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - saved;

      return {
        content: [{
          type: "text",
          text: [
            `🧠 **Stored ${saved} of ${facts.length} facts**${failed ? ` — ${failed} failed` : ""}`,
            ``,
            ...facts.map((f: string, i: number) => `${results[i].status === "fulfilled" ? "✓" : "✗"} ${i + 1}. ${f}`),
            ``,
            failed
              ? `Failed writes are usually auth (\`finch login\`) or an unreachable local memory server.`
              : `All facts are now searchable via \`memory_search\`.`,
          ].join("\n"),
        }],
      };
    }

    case "memory_consolidate": {
      const parsed = parseOrError(ConsolidateSchema, args);
      if (!parsed.ok) return parsed.error;
      const { topic, limit = 12, summary } = parsed.data;
      const localConsolidateCfg = getLocalMemoryConfig();

      // ── PASS 2: save the caller's merged version ────────────────────────
      if (summary) {
        const meta = { title: `Consolidated: ${topic}`, source: "memory_consolidate", addedAt: Date.now() };
        const saved = localConsolidateCfg
          ? await localMemoryAdd(localConsolidateCfg, summary, meta).catch((err: any) => ({ error: err.message }))
          : await callConvex("/memory/add", "POST", { content: summary, metadata: meta }, "memory_add").catch((err: any) => ({ error: err.message }));
        if ((saved as any)?.error) {
          return { content: [{ type: "text", text: `Error saving consolidated memory: ${(saved as any).error}` }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: [
              `🧠 **Consolidated "${topic}" saved** — ID: \`${(saved as any)?.id ?? "saved"}\``,
              `The source memories were left intact.`,
              ``,
              `Find it with \`memory_search query: "${topic}"\`.`,
            ].join("\n"),
          }],
        };
      }

      // ── PASS 1: fetch every memory on the topic, numbered ───────────────
      // Uses the same RRF-fused semantic+lexical retrieval as memory_search/
      // memory_context - a plain single-source searchSupermemory() call here
      // used to mean consolidation could miss memories only the lexical/BM25
      // side would surface, while still claiming an exhaustive "N memories".
      const rows = await hybridMemorySearch(topic, limit);
      if (rows.length === 0) {
        return { content: [{ type: "text", text: `No memories found for "${topic}" to consolidate.` }], isError: true };
      }

      const numbered = rows.map((r, i) => {
        const title = r.metadata?.title ? `**${r.metadata.title}** — ` : "";
        const when = r.metadata?.addedAt ? ` _(${new Date(r.metadata.addedAt).toISOString().slice(0, 10)})_` : "";
        return `${i + 1}. ${title}${r.content.trim()}${when}`;
      });

      return {
        content: [{
          type: "text",
          text: [
            `🧠 **${rows.length} memories on "${topic}"**`,
            ``,
            ...numbered,
            ``,
            `---`,
            ``,
            `## Merge them`,
            ``,
            `- Fold overlapping facts into one statement; drop verbatim duplicates.`,
            `- **Where two memories conflict, keep both and say which is newer** — dates are shown above.`,
            `  Silently dropping the older one destroys the record of a changed mind.`,
            `- Preserve every number, date, address and name exactly as written.`,
            `- Group by sub-theme if that makes the result easier to search later.`,
            `- Add nothing that isn't in the list above.`,
            ``,
            `Then call \`memory_consolidate\` again with \`topic: "${topic}"\` and \`summary: "<your merged text>"\` ` +
              `to save it. The ${rows.length} originals stay where they are.`,
          ].join("\n"),
        }],
      };
    }

    // memory_publish removed - broken (silently dropped isPublic/authorName,
    // never actually set `published`) AND pointless even if fixed - no
    // Memory Marketplace page/query ever reads that field. vault_unpublish
    // stays, it's a harmless no-op. Re-add only alongside building discovery.

    default:
      return null;
  }
}
