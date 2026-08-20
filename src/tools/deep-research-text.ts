// Text utilities: JSON extraction, domain scoring, excerpt selection, query
// terms, and source ranking/dedup - the parts of the pipeline with no LLM
// or network call.

import { DOMAIN_TIER_BONUS, EXCERPT_CHARS_PER_CHUNK, EXCERPT_TOP_CHUNKS, STOPWORDS, MAX_PER_DOMAIN, NEWS_DOMAIN_BOOST_RE } from "./deep-research-constants.js";

export function safeParseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { /* try the next parse strategy */ }
  const stripped = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  try { return JSON.parse(stripped) as T; } catch { /* try the next parse strategy */ }
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]) as T; } catch { /* try the next parse strategy */ } }
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]) as T; } catch { /* try the next parse strategy */ } }
  return fallback;
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; }
}

export function tierBonus(url: string): number {
  for (const [re, bonus] of DOMAIN_TIER_BONUS) if (re.test(url)) return bonus;
  return 0;
}

// Split markdown into ~600-char chunks at paragraph boundaries.
export function chunkMarkdown(md: string, chunkSize = EXCERPT_CHARS_PER_CHUNK): string[] {
  const paragraphs = md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current.length + p.length + 2 <= chunkSize) {
      current = current ? `${current}\n\n${p}` : p;
    } else {
      if (current) chunks.push(current);
      current = p.slice(0, chunkSize * 2); // very long single paragraph → cap
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Score a chunk against the query using term overlap. Cheap, no LLM call.
export function chunkRelevance(chunk: string, queryTerms: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    const occurrences = lower.split(term).length - 1;
    score += Math.min(occurrences, 5); // cap each term so a spammy page can't win
  }
  return score;
}

export function pickBestExcerpt(md: string, queryTerms: string[]): string {
  const chunks = chunkMarkdown(md);
  if (chunks.length === 0) return md.slice(0, 1500);
  const scored = chunks.map((c, i) => ({ c, i, score: chunkRelevance(c, queryTerms) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, EXCERPT_TOP_CHUNKS).sort((a, b) => a.i - b.i);
  return top.map((t) => t.c).join("\n\n---\n\n");
}

export function extractQueryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    )
  ).slice(0, 10);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentYearMonth(): string {
  const now = new Date();
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[now.getMonth()]} ${now.getFullYear()}`;
}

// Build a search query for finding related vault entries. Prefer high-signal
// terms from the user query, dropping common research filler words.
export function buildSearchTermsForLinking(query: string): string {
  const terms = extractQueryTerms(query);
  return terms.length > 0 ? terms.join(" ") : query;
}

// Extract a vault key from a search hit. The /vault/search endpoint returns
// semantic memory documents whose metadata may or may not contain a vault key.
export function extractVaultKeyFromHit(hit: { id?: string; metadata?: any; content?: string }): string | null {
  // Heuristic 1: metadata.vaultKey or metadata.key
  if (hit.metadata?.vaultKey && typeof hit.metadata.vaultKey === "string") return hit.metadata.vaultKey;
  if (hit.metadata?.key && typeof hit.metadata.key === "string") return hit.metadata.key;
  // Heuristic 2: content first line matches the vault key path pattern
  const firstLine = (hit.content ?? "").split("\n", 1)[0];
  const m = firstLine.match(/^(research|memory|workflow|prompt|execution|file|credential)\/[a-z0-9\-/]+/i);
  if (m) return m[0];
  return null;
}

export function rankAndDedupe(
  candidates: Array<{ url: string; title: string; desc: string; queryRank: number }>,
  freshMode?: boolean,
): Array<{ url: string; title: string; desc: string }> {
  // Score: search-rank inverse + domain tier bonus. Lower queryRank = higher.
  // In fresh mode, give news domains an extra +2 boost so recent reporting
  // ranks above evergreen content.
  const scored = candidates.map((c) => ({
    ...c,
    score: -c.queryRank + tierBonus(c.url) + (freshMode && NEWS_DOMAIN_BOOST_RE.test(c.url) ? 2 : 0),
    domain: domainOf(c.url),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Domain diversity - cap MAX_PER_DOMAIN sources from same domain
  const seenDomain = new Map<string, number>();
  const seenUrl = new Set<string>();
  const result: typeof candidates = [];
  for (const c of scored) {
    if (seenUrl.has(c.url)) continue;
    const count = seenDomain.get(c.domain) ?? 0;
    if (count >= MAX_PER_DOMAIN) continue;
    seenUrl.add(c.url);
    seenDomain.set(c.domain, count + 1);
    result.push(c);
  }
  return result;
}
