// Firecrawl search/scrape - BYOK direct call with a Finch backend-proxy
// fallback for signed-in users without their own key.

import { callConvex } from "../convex.js";
import { FC_BASE } from "./deep-research-constants.js";

export type SearchHit = { url: string; title: string; description?: string };

/**
 * Firecrawl returns either a flat array or a keyed object of result groups
 * (`{ web: [...], news: [...] }`). The proxy path assumed the flat shape and
 * handed an object to `.forEach`, which threw — invisible until now because
 * without an API key the run always died at the planner first.
 */
export function normalizeSearchHits(raw: unknown): SearchHit[] {
  if (Array.isArray(raw)) return raw as SearchHit[];
  if (raw && typeof raw === "object") {
    const out: SearchHit[] = [];
    for (const group of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(group)) out.push(...(group as SearchHit[]));
    }
    return out;
  }
  return [];
}

export async function fcSearch(query: string, limit: number): Promise<Array<{ url: string; title: string; description?: string }>> {
  // BYOK path - direct call to Firecrawl with user's key. Fastest, no proxy hop.
  const key = process.env.FIRECRAWL_API_KEY;
  if (key) {
    try {
      const res = await fetch(`${FC_BASE}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: unknown };
        return normalizeSearchHits(data.data);
      }
    } catch { /* fall through */ }
  }

  // Backend-proxy path - session-authed; Finch covers Firecrawl cost.
  try {
    const data = await callConvex(
      "/research/firecrawl-search",
      "POST",
      { query, limit },
      "web_search",
      20_000,
    ) as { results?: unknown } | null;
    return normalizeSearchHits(data?.results);
  } catch {
    return [];
  }
}

export async function fcScrape(url: string): Promise<{ markdown: string; publishedAt?: string } | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (key) {
    try {
      const res = await fetch(`${FC_BASE}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { markdown?: string; metadata?: { publishedAt?: string; ogPublishedTime?: string; "article:published_time"?: string } } };
        const md = data.data?.markdown;
        if (md) {
          const meta = data.data?.metadata;
          const publishedAt = meta?.publishedAt ?? meta?.ogPublishedTime ?? meta?.["article:published_time"];
          return { markdown: md, publishedAt };
        }
      }
    } catch { /* fall through */ }
  }

  // Backend-proxy path. Returns markdown only - no metadata extraction yet,
  // which means continueFrom can't auto-date proxied scrapes. Acceptable
  // tradeoff for now; markdown is the primary signal.
  try {
    const data = await callConvex(
      "/research/firecrawl-scrape",
      "POST",
      { url },
      "web_scrape",
      25_000,
    ) as { markdown?: string } | null;
    if (data?.markdown) return { markdown: data.markdown };
  } catch { /* swallow */ }
  return null;
}
