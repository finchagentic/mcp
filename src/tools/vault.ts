import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
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
import { resolveProjectId } from "../project.js";

const VAULT_TYPES = ["research", "execution", "workflow", "prompt", "file", "memory", "code", "credential"] as const;

export const VAULT_TOOLS: Tool[] = [
  {
    name: "vault_save",
    description:
      "Save or update a versioned artifact in Finch Vault. Same key = update (git-style: prior version snapshotted, patched to v+1). " +
      "Types: research | execution | workflow | prompt | file | memory | code. " +
      "Entries up to 10MB - content over 600KB auto-offloads to blob storage. " +
      "For quick unstructured notes, use memory_add instead. For coding sessions specifically, " +
      "prefer code_session_save - same versioning, but a structured template and auto-linking built in.",
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
        workspaceProject: {
          type: "string",
          description:
            "Optional: file this entry into a named Finch workspace project (the same Projects a user " +
            "organizes their Agents/vault into on the Agents page). Matched case-insensitively by name; " +
            "created automatically if it doesn't exist yet. Not the same thing as a `key` path segment - " +
            "this tags the entry in Finch's own project system. Hosted vault only (no effect in local-vault mode).",
        },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "code_session_save",
    description:
      "Persist a coding/debugging session as a versioned Markdown snapshot in Finch Vault, keyed by " +
      "project (`code/<project>`) - so the next session (yours, or another agent's) has real context " +
      "instead of starting cold. Same project = new version, full history kept (git-style, like vault_save). " +
      "Auto-links to related past code and research entries. " +
      "Call this at the end of a substantive coding task - not for every single file read or trivial edit.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project or repo slug, e.g. 'finch-webapp', 'mcp-server'. Becomes the vault key: code/<project>." },
        summary: { type: "string", description: "What was done this session - the task, the approach, the outcome." },
        filesChanged: { type: "array", items: { type: "string" }, description: "Files touched, e.g. ['app/convex/vault.ts', 'app/src/App.tsx']" },
        decisions: { type: "string", description: "Notable decisions or tradeoffs made and why - the part a future session can't re-derive from a diff alone." },
        nextSteps: { type: "string", description: "What's left, or what to pick up next session." },
        tags: { type: "array", items: { type: "string" }, description: "Extra tags for search, e.g. ['bugfix', 'refactor']" },
      },
      required: ["project", "summary"],
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
  {
    name: "list_projects",
    description:
      "List your Finch workspace projects - the same Projects used to organize Agents and vault content on the " +
      "webapp Agents page. Read-only. Check this before passing `workspaceProject` to vault_save/agent_spawn if " +
      "you want to reuse an existing project rather than relying on the automatic case-insensitive name match. " +
      "No effect / nothing to list in local-vault mode.",
    inputSchema: { type: "object", properties: {}, required: [] },
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
  workspaceProject: z.string().optional(),
});

const CodeSessionSchema = z.object({
  project: z.string().min(1).max(80),
  summary: z.string().min(1),
  filesChanged: z.array(z.string()).max(100).optional(),
  decisions: z.string().optional(),
  nextSteps: z.string().optional(),
  tags: z.array(z.string()).optional(),
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

// ── Structured output builders (schemas in output-schemas.ts) ───────────────
export function buildVaultList(entries: any[], type?: string): Record<string, unknown> {
  return {
    type: type ?? null,
    count: entries.length,
    entries: entries.map((e) => ({
      key: e.key,
      title: e.title ?? null,
      type: e.type ?? null,
      version: e.version ?? null,
      size: e.size ?? null,
      updatedAt: e.updatedAt ?? null,
      isPinned: !!e.isPinned,
    })),
  };
}

export function buildVaultSearch(
  query: string,
  results: Array<{ key: string; title?: string; type?: string; score?: number; preview?: string }>,
): Record<string, unknown> {
  return {
    query,
    count: results.length,
    results: results.map((r) => ({
      key: r.key,
      title: r.title ?? null,
      type: r.type ?? null,
      score: r.score ?? null,
      preview: r.preview ?? null,
    })),
  };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
      if (parsed.data.type === "credential") {
        // vault_save writes plaintext to disk/DB - "credential" is only a
        // valid FILTER value for vault_list/search/export (which correctly
        // exclude it), never a valid type to actually SAVE through here.
        // vault_store_credential is the only path that encrypts at rest.
        return {
          content: [{
            type: "text",
            text: "Use `vault_store_credential` to save a secret - it encrypts at rest (AES-256-GCM). " +
              "`vault_save` writes plaintext, so `type: \"credential\"` is refused here.",
          }],
          isError: true,
        };
      }

      // Auto-generate title from content if not provided
      const firstLine = parsed.data.content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
      const autoTitle = parsed.data.title ?? (firstLine || `${parsed.data.type} - ${new Date().toISOString().slice(0, 10)}`);
      const { workspaceProject, ...rest } = parsed.data;
      const savePayload = { ...rest, title: autoTitle };

      // Resolve the project name -> id server-side (auto-creates on first use).
      // Local vault has no project concept at all - workspaceProject is
      // silently a no-op there rather than a confusing network error.
      let resolvedProjectName: string | null = null;
      if (workspaceProject && !localVault) {
        const resolved = await resolveProjectId(workspaceProject);
        if (resolved) {
          (savePayload as any).projectId = resolved.projectId;
          resolvedProjectName = resolved.name;
        }
      }

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
        resolvedProjectName ? `📁 Project: ${resolvedProjectName}` : "",
        mirrorToMemory ? `🧠 Synced to searchable memory` : (localVault ? `💾 Stored locally at ~/.finch/vault` : ""),
        ...linkSummary,
        ``,
        `Use \`vault_read\` to retrieve, \`vault_history\` to see all versions.`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "code_session_save": {
      const parsed = CodeSessionSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
      const { project, summary, filesChanged, decisions, nextSteps, tags } = parsed.data;

      const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "session";
      const key = `code/${projectSlug}`;

      const content = [
        `# Code session: ${project}`,
        ``,
        `_${new Date().toISOString()}_`,
        ``,
        `## Summary`,
        summary,
        filesChanged?.length ? `\n## Files changed\n${filesChanged.map((f) => `- \`${f}\``).join("\n")}` : "",
        decisions ? `\n## Decisions\n${decisions}` : "",
        nextSteps ? `\n## Next steps\n${nextSteps}` : "",
      ].filter(Boolean).join("\n");

      const savePayload = {
        type: "code" as const,
        key,
        title: `Code: ${project}`,
        content,
        contentType: "markdown" as const,
        agentId: "code-session",
        tags: ["code-session", ...(tags ?? [])],
        commitMsg: summary.slice(0, 80),
      };

      const data = localVault
        ? localVaultSave(localVault, savePayload)
        : await callConvex("/vault/save", "POST", savePayload, "vault_save");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      const { version, changed } = data;

      // Same mirror-to-memory rule as vault_save: skip only when local vault
      // is on WITHOUT local memory, so query terms never phone home for a
      // fully offline setup.
      const mirrorToMemory = !localVault || !!getLocalMemoryConfig();
      if (mirrorToMemory) {
        syncToSupermemory(content, {
          vaultKey: key, title: savePayload.title, type: "code",
          tags: savePayload.tags, version, source: "code_session_save",
        });
      }

      // Auto-link to related past code/research entries - same idea as
      // deep_research's auto-linking, so a project's session history and any
      // research that informed it stay connected instead of sitting as
      // disconnected entries. Purely additive - never blocks the save.
      const linked: string[] = [];
      try {
        const searchQuery = `${project} ${summary}`.slice(0, 200);
        let hits: Array<{ key: string; title: string }> = [];
        if (localVault) {
          const searchResult = localVaultSearch(localVault, searchQuery, { limit: 6 });
          hits = ((searchResult.results ?? []) as Array<{ key?: string; title?: string }>)
            .filter((r): r is { key: string; title?: string } => !!r.key && r.key !== key)
            .map((r) => ({ key: r.key, title: r.title ?? "(untitled)" }));
        } else {
          const searchResult = (await callConvex("/vault/search", "POST", { q: searchQuery, n: 8 }, "vault_search")) as
            { results?: Array<{ metadata?: { title?: string; vaultKey?: string; key?: string } }> } | null;
          hits = (searchResult?.results ?? [])
            .map((r) => {
              const hitKey = r.metadata?.vaultKey ?? r.metadata?.key ?? null;
              return hitKey ? { key: hitKey, title: r.metadata?.title ?? "(untitled)" } : null;
            })
            .filter((h): h is { key: string; title: string } => !!h && h.key !== key);
        }
        for (const hit of hits.slice(0, 3)) {
          try {
            if (localVault) localVaultLink(localVault, key, hit.key, "related");
            else await callConvex("/vault/link", "POST", { fromKey: key, toKey: hit.key, relation: "related" }, "vault_link");
            linked.push(hit.key);
          } catch { /* skip individual link failures */ }
        }
      } catch { /* auto-link is purely additive */ }

      const lines = [
        `📦 **Code session ${changed ? (version === 1 ? "saved" : "updated") : "unchanged"}** - \`${key}\` (v${version})`,
        filesChanged?.length ? `Files: ${filesChanged.length}` : "",
        linked.length ? `🔗 Linked to ${linked.length} related entr${linked.length === 1 ? "y" : "ies"}: ${linked.map((k) => `\`${k}\``).join(", ")}` : "",
        mirrorToMemory ? `🧠 Synced to searchable memory` : "",
        ``,
        `Next session: \`vault_read key="${key}"\` for the latest state, or \`vault_history key="${key}"\` for the full timeline.`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "vault_read": {
      const parsed = ReadSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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

      // NOTE: there is no blob-storage tier on the backend (see
      // app/convex/vault.ts MAX_CONTENT_BYTES comment) - oversized content is
      // rejected at save time, not offloaded to file storage, so `contentFileId`
      // never comes back on a vault entry. A `/vault/blob` fallback used to live
      // here but the route was never registered in http.ts either, so it was
      // dead in both directions - removed rather than fixed against a storage
      // tier that doesn't exist. Re-add only alongside building that tier.
      const fullContent: string = data.content ?? "";

      const sizeLabel = data.originalSize ? formatBytes(data.originalSize) : formatBytes(data.size);
      const backlinksBlock = Array.isArray(data.backlinks) && data.backlinks.length > 0
        ? `\n🔙 Linked from (${data.backlinks.length}):\n${data.backlinks.map((b: any) => `  ← \`${b.key}\`${b.title ? ` - ${b.title}` : ""}`).join("\n")}`
        : "";

      // A raw projectId means nothing to a reader - resolve it to a name.
      // One extra call only when the entry is actually tagged; skipped
      // entirely for the common case (unassigned) and in local-vault mode.
      let projectLabel = "";
      if (data.projectId && !localVault) {
        try {
          const projData = await callConvex("/projects/list", "GET", undefined, "list_projects") as
            { projects?: Array<{ id: string; name: string }> } | null;
          const match = projData?.projects?.find((p) => p.id === data.projectId);
          if (match) projectLabel = `📁 Project: ${match.name}`;
        } catch { /* best-effort - never block the read over this */ }
      }

      const lines = [
        `📂 **${data.title}**`,
        `Key: \`${data.key}\`  ·  Type: ${data.type}  ·  v${data.version}  ·  ${sizeLabel}${data.contentFileId ? " · blob" : ""}`,
        data.tags?.length ? `Tags: ${data.tags.join(", ")}` : "",
        data.isPinned ? "📌 Pinned" : "",
        data.agentId ? `Agent: ${data.agentId}` : "",
        projectLabel,
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!entries.length) {
        return {
          content: [{ type: "text", text: `No vault entries found${parsed.data.type ? ` of type '${parsed.data.type}'` : ""}.` }],
          structuredContent: buildVaultList([], parsed.data.type),
        };
      }

      const header = `📚 **Finch Vault** (${entries.length} entries)`;
      const rows = entries.map((e) =>
        `${e.isPinned ? "📌 " : ""}[\`${e.key}\`] ${e.title} - v${e.version} · ${e.type} · ${formatBytes(e.size)} · ${formatDate(e.updatedAt)}`
      );
      return {
        content: [{ type: "text", text: [header, "", ...rows].join("\n") }],
        structuredContent: buildVaultList(entries, parsed.data.type),
      };
    }

    case "vault_search": {
      const parsed = SearchSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };

      // Full-text search, proxied through Convex (searchSupermemory is a
      // legacy name - it calls Finch's own /memory/search endpoint, not a
      // third-party semantic service; there is no embedding step here). Large vault
      // entries are indexed as multiple chunks tagged with isVaultChunk +
      // vaultKey - group chunks back to their parent entry so the result
      // list shows one row per entry, not one row per chunk.
      //
      // Skipped entirely when vaultBackend is local - a local vault's whole
      // point is "no network," so the query string must never leave the
      // machine, not even to check for results before falling back to the
      // (always-local) full-text branch below.
      if (!localVault) {
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

            const header = `🔍 **Vault Search**: "${parsed.data.query}" - ${grouped.length} entry/entries`;
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
            return {
              content: [{ type: "text", text: [header, "", ...rows].join("\n") }],
              structuredContent: buildVaultSearch(
                parsed.data.query,
                grouped.map((g) => ({ key: g.key, title: g.title, type: g.type, score: g.bestScore, preview: g.bestPreview })),
              ),
            };
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
      if (!results.length) {
        return {
          content: [{ type: "text", text: `No vault entries found for: "${parsed.data.query}"` }],
          structuredContent: buildVaultSearch(parsed.data.query, []),
        };
      }

      const header = `🔍 **Vault Search**: "${parsed.data.query}" - ${results.length} result(s)`;
      const rows = results.map((r, i) => [
        `${i + 1}. [\`${r.key}\`] **${r.title}**  (${r.type} · v${r.version})`,
        `   ${r.preview}`,
      ].join("\n"));
      return {
        content: [{ type: "text", text: [header, "", ...rows].join("\n") }],
        structuredContent: buildVaultSearch(parsed.data.query, results),
      };
    }

    case "vault_history": {
      const parsed = HistorySchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
      const data = localVault
        ? localVaultStoreCredential(localVault, parsed.data.name, parsed.data.value, parsed.data.description)
        : await callConvex("/vault/credential/store", "POST", parsed.data, "vault_store_credential");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return { content: [{ type: "text", text: `🔐 Credential stored: \`${data.name}\`\nKey: \`${data.key}\`\nRetrieve with: \`vault_get_credential name: "${data.name}"\`` }] };
    }

    case "vault_get_credential": {
      const parsed = GetCredentialSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
      const { key, pinned = true } = parsed.data;
      const data = localVault
        ? localVaultPin(localVault, key, pinned)
        : await callConvex("/vault/pin", "POST", { key, pinned }, "vault_pin");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return { content: [{ type: "text", text: pinned ? `📌 Pinned: \`${key}\`` : `📌 Unpinned: \`${key}\`` }] };
    }

    case "vault_unpublish": {
      const parsed = UnpublishSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
      const { key, tags, replace = false } = parsed.data;
      const data = localVault
        ? localVaultTag(localVault, key, tags, replace)
        : await callConvex("/vault/tag", "POST", { key, tags, replace }, "vault_tag");
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      return { content: [{ type: "text", text: `🏷️ Tags ${replace ? "set" : "updated"} on \`${key}\`: ${(data.tags ?? tags).join(", ")}` }] };
    }

    case "vault_link": {
      const parsed = LinkSchema.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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
      if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
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

    case "list_projects": {
      if (localVault) {
        return { content: [{ type: "text", text: "Local vault mode has no project concept - `workspaceProject` has no effect, and there's nothing to list here." }] };
      }
      const data = await callConvex("/projects/list", "GET", undefined, "list_projects") as {
        projects?: Array<{ id: string; name: string; slug: string; description: string | null; updatedAt: number }>;
        error?: string;
      };
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };
      const projects = data.projects ?? [];
      if (!projects.length) {
        return { content: [{ type: "text", text: "No projects yet. Pass `workspaceProject: \"name\"` to `vault_save` or `agent_spawn` and one is created automatically." }] };
      }
      const lines = projects.map((p) => `- **${p.name}** (\`${p.slug}\`)${p.description ? ` - ${p.description}` : ""}`);
      return { content: [{ type: "text", text: `📁 **Your projects** (${projects.length})\n\n${lines.join("\n")}` }] };
    }

    default:
      return null;
  }
}
