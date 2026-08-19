import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { meaningfulTerms, wordOccurrences } from "./_text-search.js";

// Fully-local, user-owned memory backend (local-vault.ts's counterpart) -
// one JSON index under ~/.finch/memory/, no server/key/network. Zero-setup
// alternative to local-memory.ts's supermemory client (which requires
// self-hosting that server separately). Keyword scoring, not embeddings -
// good enough for "what did I say about X", zero-dependency tradeoff.

export interface LocalMemoryFileConfig {
  dir: string;
}

interface MemoryRow {
  id: string;
  content: string;
  title?: string;
  tags?: string[];
  source?: string;
  sourceUrl?: string;
  contentHash: string;
  pinned?: boolean;
  addedAt: number;
  /** Set when this row mirrors a vault_save call - lets vault_delete find and
   * remove the mirror too, instead of leaving "permanently deleted" content
   * fully readable through memory_search/memory_list. */
  vaultKey?: string;
}

interface MemoryIndex {
  memories: MemoryRow[];
}

export function getLocalMemoryFileConfig(): LocalMemoryFileConfig {
  return { dir: path.join(os.homedir(), ".finch", "memory") };
}

function indexPath(cfg: LocalMemoryFileConfig): string {
  return path.join(cfg.dir, "index.json");
}

function readIndex(cfg: LocalMemoryFileConfig): MemoryIndex {
  try {
    const raw = fs.readFileSync(indexPath(cfg), "utf8");
    const parsed = JSON.parse(raw) as Partial<MemoryIndex>;
    return { memories: parsed.memories ?? [] };
  } catch {
    return { memories: [] };
  }
}

// Atomic write: temp file + rename, matching local-vault.ts's pattern so a
// crash mid-write can't corrupt the index every memory depends on.
function writeIndex(cfg: LocalMemoryFileConfig, idx: MemoryIndex): void {
  fs.mkdirSync(cfg.dir, { recursive: true });
  const tmp = indexPath(cfg) + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
  fs.renameSync(tmp, indexPath(cfg));
}

function toResult(m: MemoryRow): { id: string; content: string; metadata: Record<string, unknown>; score?: number } {
  return {
    id: m.id,
    content: m.content,
    metadata: { title: m.title, tags: m.tags, source: m.source, sourceUrl: m.sourceUrl, contentHash: m.contentHash, pinned: m.pinned, addedAt: m.addedAt, vaultKey: m.vaultKey },
  };
}

export function fileMemoryAdd(
  cfg: LocalMemoryFileConfig,
  content: string,
  metadata: Record<string, unknown>,
  sourceUrl?: string,
): { id: string } {
  const idx = readIndex(cfg);
  const id = crypto.randomBytes(8).toString("hex");
  const row: MemoryRow = {
    id,
    content,
    title: metadata.title as string | undefined,
    tags: metadata.tags as string[] | undefined,
    source: metadata.source as string | undefined,
    sourceUrl,
    contentHash: (metadata.contentHash as string | undefined) ?? "",
    pinned: metadata.pinned as boolean | undefined,
    addedAt: (metadata.addedAt as number | undefined) ?? Date.now(),
    vaultKey: metadata.vaultKey as string | undefined,
  };
  idx.memories.push(row);
  writeIndex(cfg, idx);
  return { id };
}

/** Remove every memory row mirroring a given vault entry - called by
 * vault_delete so its "PERMANENT... cannot be undone" claim is actually true,
 * instead of leaving the content fully recoverable via memory_search. */
export function fileMemoryDeleteByVaultKey(cfg: LocalMemoryFileConfig, vaultKey: string): number {
  const idx = readIndex(cfg);
  const next = idx.memories.filter((m) => m.vaultKey !== vaultKey);
  const removed = idx.memories.length - next.length;
  if (removed > 0) writeIndex(cfg, { memories: next });
  return removed;
}

export function fileMemorySearch(
  cfg: LocalMemoryFileConfig,
  query: string,
  limit: number,
): Array<{ id: string; content: string; metadata: any; score?: number }> {
  const idx = readIndex(cfg);
  const terms = meaningfulTerms(query);
  if (terms.length === 0) return [];
  const scored: Array<{ m: MemoryRow; score: number }> = [];
  for (const m of idx.memories) {
    const hay = `${m.title ?? ""}\n${(m.tags ?? []).join(" ")}\n${m.content}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if ((m.title ?? "").toLowerCase().includes(t)) score += 3;
      if ((m.tags ?? []).some((tag) => tag.toLowerCase().includes(t))) score += 2;
      score += Math.min(wordOccurrences(hay, t), 5);
    }
    if (score > 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const maxScore = top[0]?.score || 1;
  return top.map(({ m, score }) => ({ ...toResult(m), score: score / maxScore }));
}

export function fileMemoryList(
  cfg: LocalMemoryFileConfig,
  limit: number,
  tag?: string,
): Array<{ id: string; content: string; metadata: any }> {
  const idx = readIndex(cfg);
  let rows = [...idx.memories].sort((a, b) => b.addedAt - a.addedAt);
  if (tag) rows = rows.filter((m) => (m.tags ?? []).includes(tag));
  return rows.slice(0, limit).map(toResult);
}

export function fileMemoryDelete(cfg: LocalMemoryFileConfig, id: string): void {
  const idx = readIndex(cfg);
  const next = idx.memories.filter((m) => m.id !== id);
  if (next.length === idx.memories.length) throw new Error(`Memory not found: ${id}`);
  writeIndex(cfg, { memories: next });
}

export function fileMemoryProfile(cfg: LocalMemoryFileConfig): { total: number; status: string; space: string } {
  const idx = readIndex(cfg);
  return { total: idx.memories.length, status: "ok", space: "local" };
}
