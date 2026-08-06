import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { readConfig } from "./config.js";

// Fully-local, user-owned Noel-Vault backend. Mirrors the two-tier pattern of
// local-memory.ts: when the user opts in (`vaultBackend: "local"`), the vault
// tools store versioned artifacts on the user's own disk under
// ~/.finch/vault/ - no Finch account, no Convex, no network, no cost to
// the platform. Zero runtime dependencies (plain JSON + one content file per
// version), same spirit as codebase-memory-mcp's local-first SQLite store.
//
// Every exported function returns objects shaped like the Convex /vault/*
// responses so tools/vault.ts can swap the data source with a one-line branch
// and reuse all of its existing rendering. Not-found cases THROW an Error whose
// message contains "not found", matching how callConvex surfaces a 404 (the
// vault handlers already catch and format that).

const VAULT_DIR = path.join(os.homedir(), ".finch", "vault");

export interface LocalVaultConfig {
  dir: string;
}

// Local vault is enabled purely by config - it needs no server, just the
// filesystem. Returns null (→ "use Convex") when the user hasn't opted in.
export function getLocalVaultConfig(): LocalVaultConfig | null {
  try {
    if (readConfig().vaultBackend !== "local") return null;
    return { dir: VAULT_DIR };
  } catch {
    return null;
  }
}

// ── On-disk model ─────────────────────────────────────────────────────────────
// index.json:  { entries: { [key]: EntryMeta }, links: LinkRecord[] }
// data/<dir>/vN:  raw content for version N (dir = short hash of the key, so a
//                 key like "research/btc" can never escape the vault folder)
// credentials.json: AES-256-GCM encrypted secret store
// .credkey:     32-byte key file (0600), created on first credential write

type Relation = "references" | "derived_from" | "supersedes" | "related" | "continues";

interface VersionMeta { version: number; commitMsg?: string; agentId?: string; size: number; createdAt: number }
interface EntryMeta {
  key: string;
  dir: string;
  type: string;
  title: string;
  contentType?: string;
  agentId?: string;
  tags: string[];
  pinned: boolean;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
  metadata?: string;
  versions: VersionMeta[];
}
interface LinkRecord { fromKey: string; toKey: string; relation: Relation }
interface VaultIndex { entries: Record<string, EntryMeta>; links: LinkRecord[] }

function now(): number { return Date.now(); }

function ensureDir(cfg: LocalVaultConfig): void {
  fs.mkdirSync(path.join(cfg.dir, "data"), { recursive: true });
}

function indexPath(cfg: LocalVaultConfig): string { return path.join(cfg.dir, "index.json"); }

function readIndex(cfg: LocalVaultConfig): VaultIndex {
  try {
    const raw = fs.readFileSync(indexPath(cfg), "utf8");
    const parsed = JSON.parse(raw) as Partial<VaultIndex>;
    return { entries: parsed.entries ?? {}, links: parsed.links ?? [] };
  } catch {
    return { entries: {}, links: [] };
  }
}

// Atomic write: temp file + rename, so a crash mid-write can't corrupt the
// manifest every entry depends on.
function writeIndex(cfg: LocalVaultConfig, idx: VaultIndex): void {
  ensureDir(cfg);
  const tmp = indexPath(cfg) + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
  fs.renameSync(tmp, indexPath(cfg));
}

function keyDir(key: string): string {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function contentPath(cfg: LocalVaultConfig, dir: string, version: number): string {
  return path.join(cfg.dir, "data", dir, `v${version}`);
}

function readContent(cfg: LocalVaultConfig, dir: string, version: number): string {
  try { return fs.readFileSync(contentPath(cfg, dir, version), "utf8"); } catch { return ""; }
}

function writeContent(cfg: LocalVaultConfig, dir: string, version: number, content: string): void {
  const d = path.join(cfg.dir, "data", dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(contentPath(cfg, dir, version), content, "utf8");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "entry";
}

function notFound(key: string): Error {
  return new Error(`Vault entry not found: ${key}`);
}

// ── save ──────────────────────────────────────────────────────────────────────

export interface SaveInput {
  type: string;
  title: string;
  content: string;
  key?: string;
  contentType?: string;
  agentId?: string;
  tags?: string[];
  commitMsg?: string;
  metadata?: string;
}

export function localVaultSave(cfg: LocalVaultConfig, input: SaveInput): {
  key: string; version: number; changed: boolean;
  linksCreated: number; linksMissing: string[]; inlineTagsExtracted: number;
} {
  const idx = readIndex(cfg);
  let key = input.key ?? `${input.type}/${slugify(input.title)}`;
  // An auto-generated key can collide with an unrelated entry when two
  // different titles slugify to the same thing. Only version-in-place when the
  // key was explicit or the existing entry is the same title; otherwise
  // disambiguate, so a different note never silently gets folded into this one.
  if (!input.key && idx.entries[key] && idx.entries[key].title !== input.title) {
    let n = 2;
    while (idx.entries[`${key}-${n}`]) n++;
    key = `${key}-${n}`;
  }

  // Parity with the hosted vault: [[wikilinks]] become graph edges, #tags are
  // pulled into the entry's tag set.
  const inlineTags = Array.from(new Set((input.content.match(/(?:^|\s)#([a-z0-9][a-z0-9_-]*)/gi) ?? []).map((t) => t.trim().replace(/^#/, "").toLowerCase())));
  const wikilinks = Array.from(new Set((input.content.match(/\[\[([^\]]+)\]\]/g) ?? []).map((w) => w.slice(2, -2).trim())));
  const tags = Array.from(new Set([...(input.tags ?? []), ...inlineTags]));

  const existing = idx.entries[key];
  const ts = now();

  if (existing) {
    const currentContent = readContent(cfg, existing.dir, existing.currentVersion);
    if (currentContent === input.content) {
      // No change - don't bump the version (matches hosted "Unchanged").
      return { key, version: existing.currentVersion, changed: false, linksCreated: 0, linksMissing: [], inlineTagsExtracted: inlineTags.length };
    }
    const version = existing.currentVersion + 1;
    writeContent(cfg, existing.dir, version, input.content);
    existing.currentVersion = version;
    existing.title = input.title;
    existing.type = input.type;
    existing.contentType = input.contentType ?? existing.contentType;
    existing.agentId = input.agentId ?? existing.agentId;
    existing.tags = Array.from(new Set([...existing.tags, ...tags]));
    existing.updatedAt = ts;
    existing.metadata = input.metadata ?? existing.metadata;
    existing.versions.push({ version, commitMsg: input.commitMsg, agentId: input.agentId, size: Buffer.byteLength(input.content), createdAt: ts });
    const linkResult = applyWikilinks(idx, key, wikilinks);
    writeIndex(cfg, idx);
    return { key, version, changed: true, ...linkResult, inlineTagsExtracted: inlineTags.length };
  }

  const dir = keyDir(key);
  writeContent(cfg, dir, 1, input.content);
  idx.entries[key] = {
    key, dir, type: input.type, title: input.title, contentType: input.contentType,
    agentId: input.agentId, tags, pinned: false, currentVersion: 1,
    createdAt: ts, updatedAt: ts, metadata: input.metadata,
    versions: [{ version: 1, commitMsg: input.commitMsg, agentId: input.agentId, size: Buffer.byteLength(input.content), createdAt: ts }],
  };
  const linkResult = applyWikilinks(idx, key, wikilinks);
  writeIndex(cfg, idx);
  return { key, version: 1, changed: true, ...linkResult, inlineTagsExtracted: inlineTags.length };
}

function applyWikilinks(idx: VaultIndex, fromKey: string, targets: string[]): { linksCreated: number; linksMissing: string[] } {
  let linksCreated = 0;
  const linksMissing: string[] = [];
  for (const toKey of targets) {
    if (!idx.entries[toKey]) { linksMissing.push(toKey); continue; }
    const dup = idx.links.find((l) => l.fromKey === fromKey && l.toKey === toKey && l.relation === "references");
    if (!dup) { idx.links.push({ fromKey, toKey, relation: "references" }); linksCreated++; }
  }
  return { linksCreated, linksMissing };
}

// ── read ──────────────────────────────────────────────────────────────────────

export function localVaultRead(cfg: LocalVaultConfig, key: string): any {
  const idx = readIndex(cfg);
  const e = idx.entries[key];
  if (!e) throw notFound(key);
  const linkedKeys = idx.links.filter((l) => l.fromKey === key).map((l) => `${l.toKey} (${l.relation})`);
  const backlinks = idx.links
    .filter((l) => l.toKey === key)
    .map((l) => ({ key: l.fromKey, title: idx.entries[l.fromKey]?.title }));
  return {
    key: e.key, title: e.title, type: e.type, version: e.currentVersion,
    size: e.versions[e.versions.length - 1]?.size, tags: e.tags, isPinned: e.pinned,
    agentId: e.agentId, updatedAt: e.updatedAt, content: readContent(cfg, e.dir, e.currentVersion),
    linkedKeys, backlinks,
  };
}

// ── list ──────────────────────────────────────────────────────────────────────

export function localVaultList(cfg: LocalVaultConfig, opts: { type?: string; agentId?: string; pinned?: boolean; limit?: number }): { entries: any[] } {
  const idx = readIndex(cfg);
  let rows = Object.values(idx.entries).filter((e) => e.type !== "credential");
  if (opts.type) rows = rows.filter((e) => e.type === opts.type);
  if (opts.agentId) rows = rows.filter((e) => e.agentId === opts.agentId);
  if (opts.pinned !== undefined) rows = rows.filter((e) => e.pinned === opts.pinned);
  rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
  const entries = rows.slice(0, opts.limit ?? 50).map((e) => ({
    key: e.key, title: e.title, type: e.type, version: e.currentVersion,
    size: e.versions[e.versions.length - 1]?.size, updatedAt: e.updatedAt, isPinned: e.pinned,
  }));
  return { entries };
}

// ── search (full-text, local) ─────────────────────────────────────────────────

export function localVaultSearch(cfg: LocalVaultConfig, query: string, opts: { type?: string; limit?: number }): { results: any[] } {
  const idx = readIndex(cfg);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ e: EntryMeta; score: number; preview: string }> = [];
  for (const e of Object.values(idx.entries)) {
    if (e.type === "credential") continue;
    if (opts.type && e.type !== opts.type) continue;
    const content = readContent(cfg, e.dir, e.currentVersion);
    const hay = `${e.title}\n${e.tags.join(" ")}\n${content}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (e.title.toLowerCase().includes(t)) score += 3;
      if (e.tags.some((tag) => tag.toLowerCase().includes(t))) score += 2;
      const occurrences = hay.split(t).length - 1;
      score += Math.min(occurrences, 5);
    }
    if (score > 0) {
      const firstHit = terms.map((t) => content.toLowerCase().indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
      scored.push({ e, score, preview: content.slice(Math.max(0, firstHit - 20), firstHit + 180).replace(/\n/g, " ") });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, opts.limit ?? 20).map(({ e, preview }) => ({
    key: e.key, title: e.title, type: e.type, version: e.currentVersion, preview,
  }));
  return { results };
}

// ── history ───────────────────────────────────────────────────────────────────

export function localVaultHistory(cfg: LocalVaultConfig, key: string): any {
  const idx = readIndex(cfg);
  const e = idx.entries[key];
  if (!e) throw notFound(key);
  return {
    key: e.key, title: e.title, currentVersion: e.currentVersion,
    history: [...e.versions].sort((a, b) => b.version - a.version),
  };
}

// ── diff ──────────────────────────────────────────────────────────────────────

function lineDiff(a: string, b: string): string {
  const al = a.split("\n"), bl = b.split("\n");
  const m = al.length, n = bl.length;
  // LCS length table (bottom-up) - fine for the artifact sizes a vault holds.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (al[i] === bl[j]) { out.push(`  ${al[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${al[i]}`); i++; }
    else { out.push(`+ ${bl[j]}`); j++; }
  }
  while (i < m) out.push(`- ${al[i++]}`);
  while (j < n) out.push(`+ ${bl[j++]}`);
  return out.join("\n");
}

export function localVaultDiff(cfg: LocalVaultConfig, key: string, fromVersion: number, toVersion: number): any {
  const idx = readIndex(cfg);
  const e = idx.entries[key];
  if (!e) throw notFound(key);
  const has = (v: number) => e.versions.some((x) => x.version === v);
  if (!has(fromVersion) || !has(toVersion)) {
    throw new Error(`version range v${fromVersion}->v${toVersion} invalid for ${key}`);
  }
  const from = readContent(cfg, e.dir, fromVersion);
  const to = readContent(cfg, e.dir, toVersion);
  // The LCS diff is O(m*n) in memory - guard against a pathologically large
  // multi-line entry blowing up the process instead of returning a diff.
  const la = from.split("\n").length, lb = to.split("\n").length;
  if (la * lb > 4_000_000) {
    return { key, diff: `(v${fromVersion}: ${la} lines · v${toVersion}: ${lb} lines — too large for a line-by-line diff)` };
  }
  return { key, diff: lineDiff(from, to) };
}

// ── export ────────────────────────────────────────────────────────────────────

export function localVaultExport(cfg: LocalVaultConfig, type?: string): any {
  const idx = readIndex(cfg);
  let rows = Object.values(idx.entries).filter((e) => e.type !== "credential");
  if (type) rows = rows.filter((e) => e.type === type);
  const entries = rows.map((e) => ({
    key: e.key, title: e.title, type: e.type, version: e.currentVersion,
    content: readContent(cfg, e.dir, e.currentVersion),
  }));
  return { exportedAt: now(), totalEntries: entries.length, entries };
}

// ── pin / delete / tag ────────────────────────────────────────────────────────

export function localVaultPin(cfg: LocalVaultConfig, key: string, pinned: boolean): any {
  const idx = readIndex(cfg);
  const e = idx.entries[key];
  if (!e) throw notFound(key);
  e.pinned = pinned;
  writeIndex(cfg, idx);
  return { pinned };
}

export function localVaultDelete(cfg: LocalVaultConfig, key: string): any {
  const idx = readIndex(cfg);
  const e = idx.entries[key];
  if (!e) throw notFound(key);
  const versionsRemoved = e.versions.length;
  try { fs.rmSync(path.join(cfg.dir, "data", e.dir), { recursive: true, force: true }); } catch { /* best effort */ }
  delete idx.entries[key];
  idx.links = idx.links.filter((l) => l.fromKey !== key && l.toKey !== key);
  writeIndex(cfg, idx);
  return { versionsRemoved };
}

export function localVaultTag(cfg: LocalVaultConfig, key: string, tags: string[], replace: boolean): any {
  const idx = readIndex(cfg);
  const e = idx.entries[key];
  if (!e) throw notFound(key);
  e.tags = replace ? Array.from(new Set(tags)) : Array.from(new Set([...e.tags, ...tags]));
  e.updatedAt = now();
  writeIndex(cfg, idx);
  return { tags: e.tags };
}

// ── link / related ────────────────────────────────────────────────────────────

export function localVaultLink(cfg: LocalVaultConfig, fromKey: string, toKey: string, relation: Relation): any {
  const idx = readIndex(cfg);
  if (!idx.entries[fromKey]) throw notFound(fromKey);
  if (!idx.entries[toKey]) throw notFound(toKey);
  const existing = idx.links.find((l) => l.fromKey === fromKey && l.toKey === toKey);
  if (existing) { existing.relation = relation; writeIndex(cfg, idx); return { updated: true }; }
  idx.links.push({ fromKey, toKey, relation });
  writeIndex(cfg, idx);
  return { updated: false };
}

export function localVaultRelated(cfg: LocalVaultConfig, key: string, relation?: Relation): any {
  const idx = readIndex(cfg);
  if (!idx.entries[key]) throw notFound(key);
  const related: any[] = [];
  for (const l of idx.links) {
    if (relation && l.relation !== relation) continue;
    if (l.fromKey === key) {
      const t = idx.entries[l.toKey];
      if (t) related.push({ key: l.toKey, title: t.title, type: t.type, relation: l.relation, direction: "→" });
    } else if (l.toKey === key) {
      const f = idx.entries[l.fromKey];
      if (f) related.push({ key: l.fromKey, title: f.title, type: f.type, relation: l.relation, direction: "←" });
    }
  }
  return { key, related };
}

// ── credentials (AES-256-GCM, key at ~/.finch/vault/.credkey, 0600) ─────────

function credKeyPath(cfg: LocalVaultConfig): string { return path.join(cfg.dir, ".credkey"); }
function credStorePath(cfg: LocalVaultConfig): string { return path.join(cfg.dir, "credentials.json"); }

function getCredKey(cfg: LocalVaultConfig): Buffer {
  ensureDir(cfg);
  const p = credKeyPath(cfg);
  try {
    return Buffer.from(fs.readFileSync(p, "utf8").trim(), "hex");
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

function readCredStore(cfg: LocalVaultConfig): Record<string, { iv: string; tag: string; data: string; description?: string; storedAt: string }> {
  try { return JSON.parse(fs.readFileSync(credStorePath(cfg), "utf8")); } catch { return {}; }
}

export function localVaultStoreCredential(cfg: LocalVaultConfig, name: string, value: string, description?: string): any {
  const key = getCredKey(cfg);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const store = readCredStore(cfg);
  store[name] = { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: enc.toString("hex"), description, storedAt: new Date(now()).toUTCString() };
  fs.writeFileSync(credStorePath(cfg), JSON.stringify(store, null, 2), { mode: 0o600 });
  return { name, key: `credential/${name}` };
}

export function localVaultGetCredential(cfg: LocalVaultConfig, name: string): any {
  const store = readCredStore(cfg);
  const rec = store[name];
  if (!rec) throw notFound(`credential ${name}`);
  const key = getCredKey(cfg);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(rec.iv, "hex"));
  decipher.setAuthTag(Buffer.from(rec.tag, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(rec.data, "hex")), decipher.final()]).toString("utf8");
  return { name, value: dec, description: rec.description, storedAt: rec.storedAt };
}
