import { readConfig } from "./config.js";

// Client for a self-hosted, local `supermemory` server (MIT licensed,
// github.com/supermemoryai/supermemory) running on the user's own machine.
// Mirrors the two-tier BYOK pattern used by fcSearch/fcScrape in
// tools/deep-research.ts: prefer a local/direct call, and callers fall back
// to the Convex-proxied path when this isn't configured or reachable.

export interface LocalMemoryConfig {
  url: string;
  apiKey: string;
}

const DEFAULT_URL = "http://localhost:6767";
const REACHABILITY_TIMEOUT_MS = 1500;
const CALL_TIMEOUT_MS = 15_000;

// Returns config only when the user has explicitly opted into local memory
// (memoryBackend: "local") and a key is present. Callers should still treat
// a null return as "use Convex" - this never throws.
export function getLocalMemoryConfig(): LocalMemoryConfig | null {
  try {
    const cfg = readConfig();
    if (cfg.memoryBackend !== "local" || !cfg.supermemoryApiKey) return null;
    return { url: cfg.supermemoryUrl ?? DEFAULT_URL, apiKey: cfg.supermemoryApiKey };
  } catch {
    return null;
  }
}

// Requires a genuine 2xx, not just "something answered" - a stale/wrong
// supermemoryApiKey returns 401 (server is up, but every real memory call
// will fail the same way), and that must show as unhealthy, not healthy.
export async function isLocalMemoryReachable(cfg: LocalMemoryConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.url}/v3/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ q: "__noelclaw_reachability_check__", limit: 1 }),
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
  const rows = await localMemorySearch(cfg, "*", Math.max(limit * (tag ? 3 : 1), limit));
  const filtered = tag ? rows.filter((r) => Array.isArray(r.metadata?.tags) && r.metadata.tags.includes(tag)) : rows;
  return filtered.slice(0, limit);
}

// Delete endpoint isn't confirmed in the public self-hosting docs at the
// time this was written - throws a distinct error so callers can surface a
// clear "not supported locally yet" message instead of a generic failure.
export async function localMemoryDelete(cfg: LocalMemoryConfig, id: string): Promise<void> {
  const res = await fetch(`${cfg.url}/v3/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`local supermemory delete failed: HTTP ${res.status}`);
}

// No dedicated count endpoint is documented for the local server, so this
// approximates via a capped wildcard search - accurate up to `SAMPLE_LIMIT`,
// reported as a floor ("200+") beyond that rather than a false exact count.
const PROFILE_SAMPLE_LIMIT = 200;

export async function localMemoryProfile(cfg: LocalMemoryConfig): Promise<{ total: number; status: string; space: string; approximate: boolean }> {
  const rows = await localMemorySearch(cfg, "*", PROFILE_SAMPLE_LIMIT);
  return { total: rows.length, status: "ok", space: "local", approximate: rows.length >= PROFILE_SAMPLE_LIMIT };
}
