import { readConfig } from "./config.js";
import {
  getLocalMemoryFileConfig,
  fileMemoryAdd, fileMemorySearch, fileMemoryList, fileMemoryDelete, fileMemoryDeleteByVaultKey, fileMemoryProfile,
  type LocalMemoryFileConfig,
} from "./local-memory-file.js";

// Two self-hosted memory backends, dispatched from one place so every caller
// in tools/memory.ts, tools/vault.ts, tools/os.ts and cli.ts keeps calling
// the same five functions regardless of which one the user picked:
//
//   memoryBackend: "local-file" - zero-dependency, JSON on disk under
//     ~/.finch/memory/ (local-memory-file.ts). No server, no key. Default
//     recommendation - this is what "self-hosted memory" should mean.
//   memoryBackend: "local"      - client for a separately-run, self-hosted
//     supermemory server (github.com/supermemoryai/supermemory) on
//     localhost. Real semantic/embedding search, but the user has to
//     install and run that server themselves. Kept for anyone already on it.
//   unset / "convex"            - hosted, hits Finch's own /memory/* routes.

export interface SupermemoryConfig {
  kind: "supermemory";
  url: string;
  apiKey: string;
}

export type LocalMemoryConfig =
  | ({ kind: "file" } & LocalMemoryFileConfig)
  | SupermemoryConfig;

const DEFAULT_URL = "http://localhost:6767";
const REACHABILITY_TIMEOUT_MS = 1500;
const CALL_TIMEOUT_MS = 15_000;

// Returns config only when the user has explicitly opted into a local
// backend. Callers should still treat a null return as "use Convex" - this
// never throws.
export function getLocalMemoryConfig(): LocalMemoryConfig | null {
  try {
    const cfg = readConfig();
    if (cfg.memoryBackend === "local-file") return { kind: "file", ...getLocalMemoryFileConfig() };
    if (cfg.memoryBackend === "local" && cfg.supermemoryApiKey) {
      return { kind: "supermemory", url: cfg.supermemoryUrl ?? DEFAULT_URL, apiKey: cfg.supermemoryApiKey };
    }
    return null;
  } catch {
    return null;
  }
}

// Requires a genuine 2xx, not just "something answered" - a stale/wrong
// supermemoryApiKey returns 401 (server is up, but every real memory call
// will fail the same way), and that must show as unhealthy, not healthy.
// The file backend is always "reachable" - it's a directory, not a server.
export async function isLocalMemoryReachable(cfg: LocalMemoryConfig): Promise<boolean> {
  if (cfg.kind === "file") return true;
  try {
    const res = await fetch(`${cfg.url}/v3/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ q: "__finch_reachability_check__", limit: 1 }),
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function localMemoryAdd(
  cfg: LocalMemoryConfig,
  content: string,
  metadata: Record<string, unknown>,
  sourceUrl?: string,
): Promise<{ id: string }> {
  if (cfg.kind === "file") return fileMemoryAdd(cfg, content, metadata, sourceUrl);
  const res = await fetch(`${cfg.url}/v3/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ content, metadata, ...(sourceUrl ? { sourceUrl } : {}) }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`local supermemory add failed: HTTP ${res.status}`);
  const data = await res.json() as { id?: string; documentId?: string };
  return { id: data.id ?? data.documentId ?? "saved" };
}

export async function localMemorySearch(
  cfg: LocalMemoryConfig,
  query: string,
  limit: number,
): Promise<Array<{ id: string; content: string; metadata: any; score?: number }>> {
  if (cfg.kind === "file") return fileMemorySearch(cfg, query, limit);
  const res = await fetch(`${cfg.url}/v3/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ q: query, limit }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`local supermemory search failed: HTTP ${res.status}`);
  const data = await res.json() as { results?: Array<{ documentId?: string; id?: string; chunks?: Array<{ content?: string }>; content?: string; metadata?: any; score?: number }> };
  return (data.results ?? []).map((r) => ({
    id: r.id ?? r.documentId ?? "",
    content: r.content ?? r.chunks?.map((c) => c.content ?? "").join("\n") ?? "",
    metadata: r.metadata ?? {},
    score: r.score,
  }));
}

// supermemory's search endpoint doubles as "list": a wildcard query returns
// recent documents. No dedicated /list endpoint is documented for the local
// server, so callers pass "*" and post-filter by tag client-side, matching
// how the Convex-side /memory/list already does its own tag post-filter.
export async function localMemoryList(
  cfg: LocalMemoryConfig,
  limit: number,
  tag?: string,
): Promise<Array<{ id: string; content: string; metadata: any }>> {
  if (cfg.kind === "file") return fileMemoryList(cfg, limit, tag);
  const rows = await localMemorySearch(cfg, "*", Math.max(limit * (tag ? 3 : 1), limit));
  const filtered = tag ? rows.filter((r) => Array.isArray(r.metadata?.tags) && r.metadata.tags.includes(tag)) : rows;
  return filtered.slice(0, limit);
}

// Delete endpoint isn't confirmed in the public self-hosting docs at the
// time this was written - throws a distinct error so callers can surface a
// clear "not supported locally yet" message instead of a generic failure.
export async function localMemoryDelete(cfg: LocalMemoryConfig, id: string): Promise<void> {
  if (cfg.kind === "file") { fileMemoryDelete(cfg, id); return; }
  const res = await fetch(`${cfg.url}/v3/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`local supermemory delete failed: HTTP ${res.status}`);
}

/**
 * Remove memory rows mirroring a deleted vault entry - called by vault_delete.
 * "file" backend: direct filter+delete, exact. Self-hosted supermemory server:
 * no documented "delete by metadata filter" endpoint, so this is a no-op that
 * returns 0 rather than guessing at an unconfirmed API - vault_delete surfaces
 * that count so a 0 on that backend doesn't get silently mistaken for success.
 */
export function localMemoryDeleteByVaultKey(cfg: LocalMemoryConfig, vaultKey: string): number {
  if (cfg.kind === "file") return fileMemoryDeleteByVaultKey(cfg, vaultKey);
  return 0;
}

// No dedicated count endpoint is documented for the local supermemory server,
// so that path approximates via a capped wildcard search - accurate up to
// `PROFILE_SAMPLE_LIMIT`, reported as a floor ("200+") beyond that rather
// than a false exact count. The file backend counts exactly.
const PROFILE_SAMPLE_LIMIT = 200;

export async function localMemoryProfile(cfg: LocalMemoryConfig): Promise<{ total: number; status: string; space: string; approximate: boolean }> {
  if (cfg.kind === "file") return { ...fileMemoryProfile(cfg), approximate: false };
  const rows = await localMemorySearch(cfg, "*", PROFILE_SAMPLE_LIMIT);
  return { total: rows.length, status: "ok", space: "local", approximate: rows.length >= PROFILE_SAMPLE_LIMIT };
}
