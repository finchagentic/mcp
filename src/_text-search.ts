// Shared substring/keyword scoring for the local-file backends
// (local-memory-file.ts, local-vault.ts) - no embeddings, no server, zero
// dependencies. Word-boundary aware, not raw substring counting - a short
// common term like "is"/"a" used to score a "match" purely by being a
// substring of an unrelated word ("is" inside "distances", "a" inside
// "banana"). Found via real testing of memory_add's new conflict-hint
// feature: a query for "the user's favorite pizza topping is pepperoni"
// registered as "related" to a completely unrelated stored memory about
// metric vs imperial units, purely because both contained "the" and "is".

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as",
  "and", "or", "but", "if", "so", "this", "that", "it", "its", "i",
  "you", "your", "they", "them", "their", "he", "she", "his", "her",
  "not", "no", "do", "does", "did", "has", "have", "had", "will", "would",
]);

/** Query terms worth scoring against - lowercased, stop-words and
 *  single-character noise dropped. An empty result means the query was
 *  entirely stop words/punctuation - callers should treat that as "no
 *  meaningful query" (return no matches) rather than matching everything. */
export function meaningfulTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary occurrence count of `term` inside `haystack` - not a raw
 *  substring count, so "is" doesn't match inside "distances" or "this". */
export function wordOccurrences(haystack: string, term: string): number {
  const re = new RegExp(`\\b${escapeRegex(term)}\\b`, "g");
  return (haystack.match(re) || []).length;
}
