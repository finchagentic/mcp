import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex, callConvexRaw } from "../convex.js";
import { ToolResult } from "../types.js";
import { syncToSupermemory, searchSupermemory } from "./memory.js";
import {
  getLocalVaultConfig,
  localVaultSave, localVaultRead, localVaultList, localVaultSearch,
  localVaultHistory, localVaultDiff, localVaultExport, localVaultPin,
  localVaultDelete, localVaultTag, localVaultLink, localVaultRelated,
  localVaultStoreCredential, localVaultGetCredential,
} from "../local-vault.js";
import { getLocalMemoryConfig, localMemoryDeleteByVaultKey } from "../local-memory.js";

const VAULT_TYPES = ["research", "execution", "workflow", "prompt", "file", "memory", "credential"] as const;

export const VAULT_TOOLS: Tool[] = [
  {
    name: "vault_save",
    description:
      "Save or update a versioned artifact in Finch Vault. Same key = update (git-style: prior version snapshotted, patched to v+1). " +
      "Types: research | execution | workflow | prompt | file | memory. " +
      "Entries up to 10MB - content over 600KB auto-offloads to blob storage. " +
      "For quick unstructured notes, use memory_add instead.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...VAULT_TYPES], description: "Entry type" },
        title: { type: "string", description: "Human-readable title (auto-generated from content if omitted)" },
        content: { type: "string", description: "Main content - markdown, JSON, code, or plain text" },
        key: { type: "string", description: "Optional slug key e.g. 'research/btc-dominance-analysis'. Auto-generated if omitted." },
        contentType: { type: "string", enum: ["markdown", "json", "text", "code"], description: "Content format hint" },
        agentId: { type: "string", description: "Agent ID writing this entry" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for filtering and search" },
        commitMsg: { type: "string", description: "Commit message for this version, e.g. 'initial research', 'refined with on-chain data'" },
        metadata: { type: "string", description: "Optional JSON string for extra structured fields" },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "vault_read",
    description:
      "Read a Finch Vault entry by its key. Returns full content, version, tags, and any linked entries.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key e.g. 'research/btc-dominance-analysis'" },
      },
      required: ["key"],
    },
  },
  {
    name: "vault_list",
    description:
      "List Finch Vault entries. Filter by type, agent, or pinned status. Returns previews, not full content.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...VAULT_TYPES], description: "Filter by type" },
        agentId: { type: "string", description: "Filter by agent that wrote the entries" },
        pinned: { type: "boolean", description: "Show only pinned entries" },
        limit: { type: "number", description: "Max entries to return (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "vault_search",
    description:
      "Search Finch Vault using full-text (keyword) search over titles, content, and tags. " +
      "This is lexical matching, not embeddings - exact and near words in your query rank " +
      "highest, so short specific phrases work better than long abstract descriptions. " +
      "Optionally filter by type. Returns ranked results with previews.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query - specific keywords work better than abstract phrasing (this is full-text search, not semantic)" },
        type: { type: "string", enum: [...VAULT_TYPES], description: "Narrow search to a specific type" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_history",
    description:
      "Get the full version history of a Finch Vault entry - like git log. " +
      "Shows each version with its commit message, author agent, size, and timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key" },
      },
      required: ["key"],
    },
  },
  {
    name: "vault_diff",
    description:
      "Compare two versions of a Finch Vault entry - like git diff. " +
      "Shows lines added (+) and removed (-) between fromVersion and toVersion.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key" },
        fromVersion: { type: "number", description: "Older version number" },
        toVersion: { type: "number", description: "Newer version number" },
      },
      required: ["key", "fromVersion", "toVersion"],
    },
  },
  {
    name: "vault_export",
    description:
      "Export your entire Finch Vault or a specific type as a structured bundle. " +
      "Useful for archiving, syncing to GitHub, or passing context to another agent.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...VAULT_TYPES], description: "Export only this type (omit for full export)" },
      },
      required: [],
    },
  },
  {
    name: "vault_store_credential",
    description:
      "Securely store an API key, token, or secret in your vault. " +
      "Credentials are stored under type=credential and are excluded from normal search and export. " +
      "Use this to keep API keys organized and accessible across agent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Credential name, e.g. 'ALCHEMY_API_KEY', 'TELEGRAM_BOT_TOKEN'" },
        value: { type: "string", description: "The secret value to store" },
        description: { type: "string", description: "Optional note about this credential - what it's for, expiry, etc." },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "vault_get_credential",
    description:
      "Retrieve a stored credential from the vault by name. " +
      "Only returns credentials owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Credential name as used in vault_store_credential" },
      },
      required: ["name"],
    },
  },
  {
    name: "vault_pin",
    description:
      "Pin or unpin a Finch Vault entry. Pinned entries always appear first in vault_list and are " +
      "prioritized in memory_context and search results. Use for your most important research, key prompts, or canonical references.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key to pin or unpin" },
        pinned: { type: "boolean", description: "true to pin, false to unpin (default: true)" },
      },
      required: ["key"],
    },
  },
  {
    name: "vault_unpublish",
    description:
      "Make a previously shared Finch Vault entry private again, removing it from the public community " +
      "listing. Use this to reverse vault publishing or packet_share. Note that anyone who already " +
      "copied the content while it was public still has it — unpublishing stops future discovery, " +
      "it does not retract what was taken.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key to make private again, e.g. 'packets/daily-research'" },
      },
      required: ["key"],
    },
  },
  {
    name: "vault_delete",
    description:
      "PERMANENT. Delete a Finch Vault entry and ALL of its version history — this cannot be undone. " +
      "Requires confirm: true. Use vault_list to browse first, and show the user the exact entry " +
      "(key + title) you are about to destroy before confirming.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key to delete permanently" },
        confirm: { type: "boolean", description: "Must be true to delete. Guards against irreversible loss." },
      },
      required: ["key", "confirm"],
    },
  },
  {
    name: "vault_tag",
    description:
      "Add or replace tags on an existing Finch Vault entry without modifying its content. " +
      "Useful for organizing entries retroactively. Set replace=true to overwrite all existing tags.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Entry key to update tags on" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add (or replace if replace=true)" },
        replace: { type: "boolean", description: "If true, replaces all existing tags. If false (default), merges with existing." },
      },
      required: ["key", "tags"],
    },
  },
  {
    name: "vault_link",
    description:
      "Create a semantic relationship between two Finch Vault entries - building a knowledge graph. " +
      "Relations: references | derived_from | supersedes | related | continues. " +
      "Example: link a synthesis entry as 'derived_from' several research entries, or mark a newer analysis as 'supersedes' an older one. " +
      "Duplicate links are updated in-place.",
    inputSchema: {
      type: "object",
      properties: {
        fromKey: { type: "string", description: "Source entry key" },
        toKey:   { type: "string", description: "Target entry key" },
        relation: {
          type: "string",
          enum: ["references", "derived_from", "supersedes", "related", "continues"],
          description: "How fromKey relates to toKey",
        },
      },
      required: ["fromKey", "toKey", "relation"],
    },
  },
  {
    name: "vault_related",
    description:
      "Traverse the Finch Vault knowledge graph - get all entries linked to a given entry. " +
      "Returns both outbound links (entries this entry references) and inbound links (entries that reference this one). " +
      "Filter by relation type to find only derived entries, superseded versions, continuations, etc.",
    inputSchema: {
      type: "object",
      properties: {
        key:      { type: "string", description: "Entry key to find related entries for" },
        relation: {
          type: "string",
          enum: ["references", "derived_from", "supersedes", "related", "continues"],
          description: "Filter to only this relation type (omit for all relations)",
        },
      },
      required: ["key"],
    },
  },
];

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const SaveSchema = z.object({
  type: z.enum(VAULT_TYPES),
  title: z.string().optional(),
  content: z.string().min(1),
  key: z.string().optional(),
  contentType: z.enum(["markdown", "json", "text", "code"]).optional(),
  agentId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  commitMsg: z.string().optional(),
  metadata: z.string().optional(),
});

const ReadSchema = z.object({ key: z.string().min(1) });
const ListSchema = z.object({
  type: z.enum(VAULT_TYPES).optional(),
  agentId: z.string().optional(),
  pinned: z.boolean().optional(),
  limit: z.number().optional(),
});
const SearchSchema = z.object({
  query: z.string().min(1),
  type: z.enum(VAULT_TYPES).optional(),
  limit: z.number().optional(),
});
const HistorySchema = z.object({ key: z.string().min(1) });
const DiffSchema = z.object({ key: z.string().min(1), fromVersion: z.number(), toVersion: z.number() });
const ExportSchema = z.object({ type: z.enum(VAULT_TYPES).optional() });
const StoreCredentialSchema = z.object({ name: z.string().min(1), value: z.string().min(1), description: z.string().optional() });
const GetCredentialSchema = z.object({ name: z.string().min(1) });
const PinSchema = z.object({ key: z.string().min(1), pinned: z.boolean().optional() });
const DeleteSchema = z.object({ key: z.string().min(1) });
const UnpublishSchema = z.object({ key: z.string().min(1) });
const TagSchema = z.object({ key: z.string().min(1), tags: z.array(z.string()).min(1), replace: z.boolean().optional() });
const VAULT_RELATIONS = ["references", "derived_from", "supersedes", "related", "continues"] as const;
const LinkSchema    = z.object({ fromKey: z.string().min(1), toKey: z.string().min(1), relation: z.enum(VAULT_RELATIONS) });
const RelatedSchema = z.object({ key: z.string().min(1), relation: z.enum(VAULT_RELATIONS).optional() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(n: number | undefined): string {
  if (!n) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toUTCString();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleVaultTool(name: string, args: unknown): Promise<ToolResult | null> {
  // When the user has opted into a fully-local, user-owned vault
  // (`vaultBackend: "local"`), every operation runs against ~/.finch/vault/
  // on their own disk - no Convex, no account. Falls through to the hosted
  // path when local isn't enabled. Same two-tier shape as local memory.
  const localVault = getLocalVaultConfig();
  switch (name) {
    case "vault_save": {
      const parsed = SaveSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };

      // Auto-generate title from content if not provided
      const firstLine = parsed.data.content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
      const autoTitle = parsed.data.title ?? (firstLine || `${parsed.data.type} - ${new Date().toISOString().slice(0, 10)}`);
      const savePayload = { ...parsed.data, title: autoTitle };

      const data = localVault
        ? localVaultSave(localVault, savePayload)
        : await callConvex("/vault/save", "POST", savePayload, "vault_save");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      const { key, version, changed } = data;

      // Mirror to searchable memory (fire-and-forget). Skip when running a local
      // vault WITHOUT local memory - otherwise the mirror would phone home to
      // the hosted proxy (needs auth the local-only user doesn't have, and
      // ships their data off-machine, defeating the whole point). vault_search
      // already full-text-searches the local vault directly in that mode.
      const mirrorToMemory = savePayload.type !== "credential" && (!localVault || !!getLocalMemoryConfig());
      if (mirrorToMemory) {
        syncToSupermemory(savePayload.content, {
          vaultKey: key, title: autoTitle, type: savePayload.type,
          tags: savePayload.tags, version, source: "vault_save",
        });
      }

      // Surface inline-syntax results so the user sees [[wikilinks]] and
      // #tags doing their work. Backend reports inlineLinksDetected,
      // linksCreated, linksMissing[], inlineTagsExtracted.
      const linkSummary: string[] = [];
      if (typeof data.linksCreated === "number" && data.linksCreated > 0) {
        linkSummary.push(`🔗 ${data.linksCreated} wikilink edge(s) created from \`[[...]]\``);
      }
      if (Array.isArray(data.linksMissing) && data.linksMissing.length > 0) {
        linkSummary.push(`⚠️ Missing target(s): ${data.linksMissing.map((k: string) => `\`${k}\``).join(", ")} - save them later to backlink`);
      }
      if (typeof data.inlineTagsExtracted === "number" && data.inlineTagsExtracted > 0) {
        linkSummary.push(`🏷️ ${data.inlineTagsExtracted} \`#tag\`(s) auto-extracted`);
      }
      if (data.blobStored) {
        linkSummary.push(`📁 Large content (${Math.round((data.originalSize ?? 0) / 1024)}KB) stored as blob; chunked indexing in progress`);
      }

      const lines = [
        `📦 **Vault ${changed ? (version === 1 ? "Created" : "Updated") : "Unchanged"}**`,
        `Key: \`${key}\``,
        `Version: v${version}`,
        changed && version > 1 ? `Previous version auto-snapshotted.` : "",
        mirrorToMemory ? `🧠 Synced to searchable memory` : (localVault ? `💾 Stored locally at ~/.finch/vault` : ""),
        ...linkSummary,
        ``,
        `Use \`vault_read\` to retrieve, \`vault_history\` to see all versions.`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "vault_read": {
      const parsed = ReadSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const vaultReadKey = parsed.data.key;
      let data: any;
      try {
        data = localVault
          ? localVaultRead(localVault, vaultReadKey)
          : await callConvex(`/vault/entry?key=${encodeURIComponent(vaultReadKey)}`, "GET", undefined, "vault_read");
      } catch (e: any) {
        const msg = String(e?.message ?? e).toLowerCase();
        const searchTerms = vaultReadKey.split("/").pop()?.replace(/-/g, " ") ?? vaultReadKey;
        if (msg.includes("404") || msg.includes("not found")) {
          return { content: [{ type: "text", text: [
            `vault_read: entry \`${vaultReadKey}\` not found.`,
            ``,
            `Try searching for it:`,
            `- \`vault_search query="${searchTerms}"\` — full-text search across all entries`,
            `- \`vault_list\` — browse all entries`,
            `- \`vault_search query="${vaultReadKey.split("/")[0]}"\` — search by type prefix`,
          ].join("\n") }], isError: true };
        }
        if (msg.includes("401") || msg.includes("auth") || msg.includes("unauthorized")) {
          return { content: [{ type: "text", text: `vault_read: not authenticated. Run \`finch login\` to sign in.` }], isError: true };
        }
        return { content: [{ type: "text", text: `vault_read failed: ${e?.message ?? e}` }], isError: true };
      }
      if (data?.error) {
        const err = String(data.error).toLowerCase();
        if (err.includes("not found") || err.includes("404") || err.includes("no entry")) {
          const searchTerms = vaultReadKey.split("/").pop()?.replace(/-/g, " ") ?? vaultReadKey;
          return { content: [{ type: "text", text: [
            `vault_read: entry \`${vaultReadKey}\` not found.`,
            `Try: vault_search query="${searchTerms}"`,
            `Or: vault_list`,
          ].join("\n") }], isError: true };
        }
        return { content: [{ type: "text", text: `vault_read error: ${data.error}` }], isError: true };
      }

      // Large entries are offloaded to Convex File Storage. The doc holds a
      // preview only; pull the real content from /vault/blob.
      let fullContent: string = data.content ?? "";
      if (data.contentFileId) {
        try {
          fullContent = await callConvexRaw(`/vault/blob?id=${encodeURIComponent(data.contentFileId)}`, "vault_read");
        } catch (err: any) {
          fullContent = (data.content ?? "") + `\n\n_(could not load full blob: ${err.message})_`;
        }
      }

      const sizeLabel = data.originalSize ? formatBytes(data.originalSize) : formatBytes(data.size);
      const backlinksBlock = Array.isArray(data.backlinks) && data.backlinks.length > 0
        ? `\n🔙 Linked from (${data.backlinks.length}):\n${data.backlinks.map((b: any) => `  ← \`${b.key}\`${b.title ? ` - ${b.title}` : ""}`).join("\n")}`
        : "";

      const lines = [
        `📂 **${data.title}**`,
        `Key: \`${data.key}\`  ·  Type: ${data.type}  ·  v${data.version}  ·  ${sizeLabel}${data.contentFileId ? " · blob" : ""}`,
        data.tags?.length ? `Tags: ${data.tags.join(", ")}` : "",
        data.isPinned ? "📌 Pinned" : "",
        data.agentId ? `Agent: ${data.agentId}` : "",
        `Updated: ${formatDate(data.updatedAt)}`,
        data.linkedKeys?.length ? `\nLinks out:\n${data.linkedKeys.map((l: string) => `  → ${l}`).join("\n")}` : "",
        backlinksBlock,
        ``,
        `---`,
        ``,
        fullContent,
      ].filter((l) => l !== "");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "vault_list": {
      const parsed = ListSchema.safeParse(args ?? {});
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const params = new URLSearchParams();
      if (parsed.data.type) params.set("type", parsed.data.type);
      if (parsed.data.agentId) params.set("agentId", parsed.data.agentId);
      if (parsed.data.pinned !== undefined) params.set("pinned", String(parsed.data.pinned));
      if (parsed.data.limit) params.set("limit", String(parsed.data.limit));
      const data = localVault
        ? localVaultList(localVault, parsed.data)
        : await callConvex(`/vault/list?${params}`, "GET", undefined, "vault_list");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

      const entries: any[] = data.entries ?? [];
      if (!entries.length) return { content: [{ type: "text", text: `No vault entries found${parsed.data.type ? ` of type '${parsed.data.type}'` : ""}.` }] };

      const header = `📚 **Finch Vault** (${entries.length} entries)`;
      const rows = entries.map((e) =>
        `${e.isPinned ? "📌 " : ""}[\`${e.key}\`] ${e.title} - v${e.version} · ${e.type} · ${formatBytes(e.size)} · ${formatDate(e.updatedAt)}`
      );
      return { content: [{ type: "text", text: [header, "", ...rows].join("\n") }] };
    }

    case "vault_search": {
      const parsed = SearchSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };

      // Full-text search, proxied through Convex (searchSupermemory is a
      // legacy name - it calls Finch's own /memory/search endpoint, not a
      // third-party semantic service; there is no embedding step here). Large vault
      // entries are indexed as multiple chunks tagged with isVaultChunk +
      // vaultKey - group chunks back to their parent entry so the result
      // list shows one row per entry, not one row per chunk.
      {
        const limit = parsed.data.limit ?? 20;
        // Over-fetch so that after chunk dedup we still have ~limit rows.
        const smResults = await searchSupermemory(parsed.data.query, Math.min(50, limit * 3));
        if (smResults.length > 0) {
          const filtered = parsed.data.type
            ? smResults.filter(r => r.metadata?.type === parsed.data.type)
            : smResults;

          if (filtered.length > 0) {
            // Group by vaultKey (chunks) or by id (standalone memories).
            type Grouped = {
              key: string;
              title: string;
              type: string;
              bestScore: number;
              bestPreview: string;
              chunkHits: number;
              isVaultChunk: boolean;
            };
            const groups = new Map<string, Grouped>();
            for (const r of filtered) {
              const isChunk = r.metadata?.isVaultChunk === true;
              const groupKey: string = isChunk ? (r.metadata?.vaultKey ?? r.id) : r.id;
              const existing = groups.get(groupKey);
              const score = r.score ?? 0;
              const preview = (r.content ?? "").slice(0, 200).replace(/\n/g, " ");
              const title = r.metadata?.title ?? r.content.slice(0, 60);
              const type = r.metadata?.type ?? (isChunk ? "vault" : "memory");

              if (!existing) {
                groups.set(groupKey, {
                  key: groupKey,
                  title,
                  type,
                  bestScore: score,
                  bestPreview: preview,
                  chunkHits: 1,
                  isVaultChunk: isChunk,
                });
              } else {
                existing.chunkHits += 1;
                if (score > existing.bestScore) {
                  existing.bestScore = score;
                  existing.bestPreview = preview;
                }
              }
            }

            const grouped = Array.from(groups.values())
              .sort((a, b) => b.bestScore - a.bestScore)
              .slice(0, limit);

            const header = `🔍 **Vault Search** [Semantic]: "${parsed.data.query}" - ${grouped.length} entry/entries`;
            const rows = grouped.map((g, i) => {
              const score = g.bestScore ? ` ${(g.bestScore * 100).toFixed(0)}%` : "";
              const chunkBadge = g.isVaultChunk && g.chunkHits > 1
                ? ` · ${g.chunkHits} chunk hits`
                : "";
              return [
                `${i + 1}.${score} [\`${g.key}\`] **${g.title}**  (${g.type}${chunkBadge})`,
                `   ${g.bestPreview}${g.bestPreview.length >= 200 ? "…" : ""}`,
              ].join("\n");
            });
            return { content: [{ type: "text", text: [header, "", ...rows].join("\n") }] };
          }
        }
      }

      // Fallback: local full-text (user-owned vault) or Convex full-text.
      const params = new URLSearchParams({ q: parsed.data.query });
      if (parsed.data.type) params.set("type", parsed.data.type);
      if (parsed.data.limit) params.set("limit", String(parsed.data.limit));
      const data = localVault
        ? localVaultSearch(localVault, parsed.data.query, { type: parsed.data.type, limit: parsed.data.limit })
        : await callConvex(`/vault/search?${params}`, "GET", undefined, "vault_search");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

      const results: any[] = data.results ?? [];
      if (!results.length) return { content: [{ type: "text", text: `No vault entries found for: "${parsed.data.query}"` }] };

      const header = `🔍 **Vault Search**: "${parsed.data.query}" - ${results.length} result(s)`;
      const rows = results.map((r, i) => [
        `${i + 1}. [\`${r.key}\`] **${r.title}**  (${r.type} · v${r.version})`,
        `   ${r.preview}`,
      ].join("\n"));
      return { content: [{ type: "text", text: [header, "", ...rows].join("\n") }] };
    }

    case "vault_history": {
      const parsed = HistorySchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const histKey = parsed.data.key;
      let data: any;
      try {
        data = localVault
          ? localVaultHistory(localVault, histKey)
          : await callConvex(`/vault/history?key=${encodeURIComponent(histKey)}`, "GET", undefined, "vault_history");
      } catch (e: any) {
        const msg = String(e?.message ?? e).toLowerCase();
        const searchTerms = histKey.split("/").pop()?.replace(/-/g, " ") ?? histKey;
        if (msg.includes("404") || msg.includes("not found")) {
          return { content: [{ type: "text", text: [
            `vault_history: entry \`${histKey}\` not found.`,
            `Try: vault_search query="${searchTerms}"`,
            `Or: vault_list`,
          ].join("\n") }], isError: true };
        }
        if (msg.includes("401") || msg.includes("unauthorized")) {
          return { content: [{ type: "text", text: `vault_history: not authenticated. Run \`finch login\`.` }], isError: true };
        }
        return { content: [{ type: "text", text: `vault_history failed: ${e?.message ?? e}` }], isError: true };
      }
      if (data?.error) {
        return { content: [{ type: "text", text: `vault_history failed: ${data.error}` }], isError: true };
      }

      const { key, title, currentVersion, history } = data;
      const header = [
        `📜 **History**: ${title}`,
        `Key: \`${key}\`  ·  Current: v${currentVersion}`,
        ``,
        `| Version | Commit | Agent | Size | Date |`,
        `|---------|--------|-------|------|------|`,
      ];
      const rows = (history as any[]).map((v) =>
        `| v${v.version} | ${v.commitMsg ?? "-"} | ${v.agentId ?? "-"} | ${formatBytes(v.size)} | ${formatDate(v.createdAt)} |`
      );
      return { content: [{ type: "text", text: [...header, ...rows].join("\n") }] };
    }

    case "vault_diff": {
      const parsed = DiffSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const { key, fromVersion, toVersion } = parsed.data;
      let data: any;
      try {
        data = localVault
          ? localVaultDiff(localVault, key, fromVersion, toVersion)
          : await callConvex(
              `/vault/diff?key=${encodeURIComponent(key)}&from=${fromVersion}&to=${toVersion}`,
              "GET", undefined, "vault_diff"
            );
      } catch (e: any) {
        const msg = String(e?.message ?? e).toLowerCase();
        const searchTerms = key.split("/").pop()?.replace(/-/g, " ") ?? key;
        if (msg.includes("404") || msg.includes("not found")) {
          return { content: [{ type: "text", text: [
            `vault_diff: entry \`${key}\` not found.`,
            `Try: vault_search query="${searchTerms}"`,
            `Or: vault_history key="${key}" to see available versions`,
          ].join("\n") }], isError: true };
        }
        if (msg.includes("version") || msg.includes("range")) {
          return { content: [{ type: "text", text: [
            `vault_diff: version range v${fromVersion}→v${toVersion} invalid for \`${key}\`.`,
            `Check available versions: vault_history key="${key}"`,
          ].join("\n") }], isError: true };
        }
        if (msg.includes("401") || msg.includes("unauthorized")) {
          return { content: [{ type: "text", text: `vault_diff: not authenticated. Run \`finch login\`.` }], isError: true };
        }
        return { content: [{ type: "text", text: `vault_diff failed: ${e?.message ?? e}` }], isError: true };
      }
      if (data?.error) {
        return { content: [{ type: "text", text: `vault_diff failed: ${data.error}` }], isError: true };
      }

      const lines = [
        `📝 **Diff**: \`${data.key}\` - v${fromVersion} → v${toVersion}`,
        ``,
        "```diff",
        data.diff,
        "```",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "vault_export": {
      const parsed = ExportSchema.safeParse(args ?? {});
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const params = parsed.data.type ? `?type=${parsed.data.type}` : "";
      const data = localVault
        ? localVaultExport(localVault, parsed.data.type)
        : await callConvex(`/vault/export${params}`, "GET", undefined, "vault_export");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

      const { exportedAt, totalEntries, entries } = data;
      const header = [
        `📤 **Vault Export**`,
        `Exported: ${formatDate(exportedAt)}  ·  ${totalEntries} entries${parsed.data.type ? ` (type: ${parsed.data.type})` : ""}`,
        ``,
      ];
      const rows = (entries as any[]).map((e) =>
        `**[\`${e.key}\`]** ${e.title} (${e.type} · v${e.version})\n${e.content.slice(0, 500)}${e.content.length > 500 ? "\n…" : ""}`
      );
      return { content: [{ type: "text", text: [...header, ...rows.join("\n\n---\n\n").split("\n")].join("\n") }] };
    }

    case "vault_store_credential": {
      const parsed = StoreCredentialSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const data = localVault
        ? localVaultStoreCredential(localVault, parsed.data.name, parsed.data.value, parsed.data.description)
        : await callConvex("/vault/credential/store", "POST", parsed.data, "vault_store_credential");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return { content: [{ type: "text", text: `🔐 Credential stored: \`${data.name}\`\nKey: \`${data.key}\`\nRetrieve with: \`vault_get_credential name: "${data.name}"\`` }] };
    }

    case "vault_get_credential": {
      const parsed = GetCredentialSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const params = new URLSearchParams({ name: parsed.data.name });
      let data: any;
      try {
        data = localVault
          ? localVaultGetCredential(localVault, parsed.data.name)
          : await callConvex(`/vault/credential?${params}`, "GET", undefined, "vault_get_credential");
      } catch {
        return { content: [{ type: "text", text: `vault_get_credential: no credential named \`${parsed.data.name}\`.` }], isError: true };
      }
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      const lines = [`🔐 **${data.name}**`, `Value: \`${data.value}\``];
      if (data.description) lines.push(`Note: ${data.description}`);
      if (data.storedAt) lines.push(`Stored: ${data.storedAt}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "vault_pin": {
      const parsed = PinSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const { key, pinned = true } = parsed.data;
      const data = localVault
        ? localVaultPin(localVault, key, pinned)
        : await callConvex("/vault/pin", "POST", { key, pinned }, "vault_pin");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return { content: [{ type: "text", text: pinned ? `📌 Pinned: \`${key}\`` : `📌 Unpinned: \`${key}\`` }] };
    }

    case "vault_unpublish": {
      const parsed = UnpublishSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      // Publishing is a hosted/marketplace concept - a local vault is private
      // by construction, so there is nothing to retract.
      if (localVault) {
        return { content: [{ type: "text", text: `🔒 \`${parsed.data.key}\` is in your local vault — already private, nothing to unpublish. (Publishing only applies to the hosted vault.)` }] };
      }
      const data = await callConvex("/vault/unpublish", "POST", { key: parsed.data.key }, "vault_unpublish");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return {
        content: [{
          type: "text",
          text:
            `🔒 **Private again:** \`${parsed.data.key}\`\n\n` +
            `Removed from the public community listing. Anyone who copied it while it was public ` +
            `still has that copy — this stops discovery, not distribution.`,
        }],
      };
    }

    case "vault_delete": {
      const parsed = DeleteSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      if ((args as { confirm?: boolean })?.confirm !== true) {
        return {
          content: [{
            type: "text",
            text:
              "Refusing to delete: this permanently removes the entry **and its entire version " +
              "history**, and cannot be undone. Show the user the exact entry, then pass `confirm: true`.",
          }],
          isError: true,
        };
      }
      const data = localVault
        ? localVaultDelete(localVault, parsed.data.key)
        : await callConvex("/vault/delete", "POST", { key: parsed.data.key }, "vault_delete");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

      // vault_save mirrors non-credential entries into memory for search - a
      // "PERMANENT... cannot be undone" delete that leaves that mirror intact
      // is not actually permanent. Only relevant for the local memory-file
      // backend (the hosted Convex path cleans its own memories table inside
      // the /vault/delete mutation itself, same request, no separate call).
      let memoriesRemoved = 0;
      const localMem = getLocalMemoryConfig();
      if (localMem) {
        memoriesRemoved = localMemoryDeleteByVaultKey(localMem, parsed.data.key);
      } else if (typeof data.memoriesRemoved === "number") {
        memoriesRemoved = data.memoriesRemoved;
      }
      const memoryNote = memoriesRemoved > 0 ? ` + ${memoriesRemoved} memory mirror${memoriesRemoved === 1 ? "" : "s"} removed` : "";

      return { content: [{ type: "text", text: `🗑️ Deleted: \`${parsed.data.key}\` (${data.versionsRemoved ?? 0} versions removed${memoryNote})` }] };
    }

    case "vault_tag": {
      const parsed = TagSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const { key, tags, replace = false } = parsed.data;
      const data = localVault
        ? localVaultTag(localVault, key, tags, replace)
        : await callConvex("/vault/tag", "POST", { key, tags, replace }, "vault_tag");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return { content: [{ type: "text", text: `🏷️ Tags ${replace ? "set" : "updated"} on \`${key}\`: ${(data.tags ?? tags).join(", ")}` }] };
    }

    case "vault_link": {
      const parsed = LinkSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const { fromKey, toKey, relation } = parsed.data;
      const data = localVault
        ? localVaultLink(localVault, fromKey, toKey, relation)
        : await callConvex("/vault/link", "POST", { fromKey, toKey, relation }, "vault_link");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      const action = data.updated ? "Updated link" : "Linked";
      return { content: [{ type: "text", text: `🔗 ${action}: \`${fromKey}\` -[${relation}]→ \`${toKey}\`` }] };
    }

    case "vault_related": {
      const parsed = RelatedSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
      const { key, relation } = parsed.data;
      const params = new URLSearchParams({ key });
      if (relation) params.set("relation", relation);
      const data = (localVault
        ? localVaultRelated(localVault, key, relation)
        : await callConvex(`/vault/related?${params}`, "GET", undefined, "vault_related")) as {
        key?: string; related?: Array<{ key: string; title: string; type: string; relation: string; direction: string }>; error?: string;
      };
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      const items = data.related ?? [];
      if (!items.length) return { content: [{ type: "text", text: `No related entries found for \`${key}\`${relation ? ` (relation: ${relation})` : ""}.` }] };
      const lines = items.map(r => `- **${r.title}** (\`${r.key}\`) [${r.type}] - ${r.direction} \`${r.relation}\``);
      return { content: [{ type: "text", text: `## Related entries for \`${key}\` (${items.length})\n\n${lines.join("\n")}` }] };
    }

    default:
      return null;
  }
}
