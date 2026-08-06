import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  localVaultSave, localVaultRead, localVaultList, localVaultSearch,
  localVaultHistory, localVaultDiff, localVaultExport, localVaultPin,
  localVaultDelete, localVaultTag, localVaultLink, localVaultRelated,
  localVaultStoreCredential, localVaultGetCredential,
  type LocalVaultConfig,
} from "../src/local-vault.js";

let cfg: LocalVaultConfig;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noelvault-"));
  cfg = { dir };
});
afterEach(() => {
  try { fs.rmSync(cfg.dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("local vault - versioning", () => {
  it("creates v1, then bumps to v2 on real change, and is idempotent on identical content", () => {
    const r1 = localVaultSave(cfg, { type: "research", title: "BTC dominance", content: "first draft" });
    expect(r1).toMatchObject({ version: 1, changed: true });
    expect(r1.key).toBe("research/btc-dominance");

    const r2 = localVaultSave(cfg, { type: "research", title: "BTC dominance", content: "second draft", key: r1.key, commitMsg: "refined" });
    expect(r2).toMatchObject({ version: 2, changed: true });

    // identical content = no new version
    const r3 = localVaultSave(cfg, { type: "research", title: "BTC dominance", content: "second draft", key: r1.key });
    expect(r3).toMatchObject({ version: 2, changed: false });

    const read = localVaultRead(cfg, r1.key);
    expect(read.content).toBe("second draft");
    expect(read.version).toBe(2);

    const hist = localVaultHistory(cfg, r1.key);
    expect(hist.currentVersion).toBe(2);
    expect(hist.history.map((h: any) => h.version)).toEqual([2, 1]);
    expect(hist.history.find((h: any) => h.version === 2).commitMsg).toBe("refined");
  });

  it("diffs two versions git-style", () => {
    const { key } = localVaultSave(cfg, { type: "prompt", title: "P", content: "line a\nline b" });
    localVaultSave(cfg, { type: "prompt", title: "P", content: "line a\nline c", key });
    const d = localVaultDiff(cfg, key, 1, 2);
    expect(d.diff).toContain("- line b");
    expect(d.diff).toContain("+ line c");
    expect(d.diff).toContain("  line a"); // unchanged line kept
  });

  it("throws not-found for a missing key and invalid version range", () => {
    expect(() => localVaultRead(cfg, "nope/x")).toThrow(/not found/i);
    const { key } = localVaultSave(cfg, { type: "prompt", title: "P", content: "x" });
    expect(() => localVaultDiff(cfg, key, 1, 5)).toThrow(/invalid/i);
  });
});

describe("local vault - auto-key collisions & diff safety", () => {
  it("disambiguates when two different titles slugify to the same auto-key", () => {
    const a = localVaultSave(cfg, { type: "research", title: "BTC!" , content: "alpha" });
    const b = localVaultSave(cfg, { type: "research", title: "BTC?" , content: "beta" });
    expect(a.key).toBe("research/btc");
    expect(b.key).toBe("research/btc-2"); // NOT folded into the first entry
    expect(localVaultRead(cfg, "research/btc").content).toBe("alpha");
    expect(localVaultRead(cfg, "research/btc-2").content).toBe("beta");
  });

  it("still versions in place when the same title (or an explicit key) is reused", () => {
    const a = localVaultSave(cfg, { type: "research", title: "Same", content: "v1" });
    const b = localVaultSave(cfg, { type: "research", title: "Same", content: "v2" });
    expect(b.key).toBe(a.key);
    expect(b.version).toBe(2);
    // explicit key always updates, never disambiguates
    const c = localVaultSave(cfg, { type: "prompt", title: "Totally different", content: "v3", key: a.key });
    expect(c.key).toBe(a.key);
    expect(c.version).toBe(3);
  });

  it("returns a safe message instead of OOMing on a huge line-by-line diff", () => {
    const big1 = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n");
    const big2 = Array.from({ length: 2100 }, (_, i) => `LINE ${i}`).join("\n");
    const { key } = localVaultSave(cfg, { type: "file", title: "Big", content: big1 });
    localVaultSave(cfg, { type: "file", title: "Big", content: big2, key });
    const d = localVaultDiff(cfg, key, 1, 2);
    expect(d.diff).toMatch(/too large for a line-by-line diff/);
  });
});

describe("local vault - list / search / tags / pin", () => {
  it("lists pinned first, filters by type, excludes credentials", () => {
    localVaultSave(cfg, { type: "research", title: "A", content: "aaa" });
    const b = localVaultSave(cfg, { type: "prompt", title: "B", content: "bbb" });
    localVaultStoreCredential(cfg, "SECRET", "shh");
    localVaultPin(cfg, b.key, true);

    const all = localVaultList(cfg, {});
    expect(all.entries.map((e: any) => e.key)).toEqual([b.key, "research/a"]); // pinned first
    expect(all.entries.some((e: any) => e.type === "credential")).toBe(false); // credentials hidden

    const onlyResearch = localVaultList(cfg, { type: "research" });
    expect(onlyResearch.entries).toHaveLength(1);
  });

  it("full-text search ranks title/tag/content hits", () => {
    localVaultSave(cfg, { type: "research", title: "Ethereum staking yields", content: "conservative approach", tags: ["defi"] });
    localVaultSave(cfg, { type: "research", title: "Random", content: "nothing relevant here" });
    const res = localVaultSearch(cfg, "staking", { limit: 10 });
    expect(res.results[0].key).toBe("research/ethereum-staking-yields");
    expect(res.results[0].preview).toContain("conservative");
  });

  it("adds and replaces tags", () => {
    const { key } = localVaultSave(cfg, { type: "research", title: "T", content: "x", tags: ["a"] });
    expect(localVaultTag(cfg, key, ["b"], false).tags.sort()).toEqual(["a", "b"]);
    expect(localVaultTag(cfg, key, ["c"], true).tags).toEqual(["c"]);
  });
});

describe("local vault - knowledge graph", () => {
  it("wikilinks + explicit links produce backlinks and related traversal", () => {
    localVaultSave(cfg, { type: "research", title: "Source", content: "source text", key: "research/source" });
    // wikilink to existing + missing
    const syn = localVaultSave(cfg, { type: "research", title: "Synthesis", content: "builds on [[research/source]] and [[research/ghost]] #summary", key: "research/synth" });
    expect(syn.linksCreated).toBe(1);
    expect(syn.linksMissing).toEqual(["research/ghost"]);
    expect(syn.inlineTagsExtracted).toBe(1);

    localVaultLink(cfg, "research/synth", "research/source", "derived_from"); // updates the existing edge
    const rel = localVaultRelated(cfg, "research/source");
    expect(rel.related.some((r: any) => r.key === "research/synth" && r.direction === "←")).toBe(true);

    const read = localVaultRead(cfg, "research/source");
    expect(read.backlinks.map((b: any) => b.key)).toContain("research/synth");
  });
});

describe("local vault - credentials (encrypted at rest)", () => {
  it("round-trips a secret and stores ciphertext, not plaintext, on disk", () => {
    localVaultStoreCredential(cfg, "ALCHEMY_API_KEY", "super-secret-value", "prod key");
    const got = localVaultGetCredential(cfg, "ALCHEMY_API_KEY");
    expect(got.value).toBe("super-secret-value");
    expect(got.description).toBe("prod key");

    // the on-disk store must not contain the plaintext
    const raw = fs.readFileSync(path.join(cfg.dir, "credentials.json"), "utf8");
    expect(raw).not.toContain("super-secret-value");

    expect(() => localVaultGetCredential(cfg, "MISSING")).toThrow(/not found/i);
  });
});

describe("local vault - export / delete", () => {
  it("exports non-credential entries and deletes with history removal", () => {
    const a = localVaultSave(cfg, { type: "research", title: "Keep", content: "keep me" });
    localVaultSave(cfg, { type: "research", title: "Keep", content: "v2", key: a.key });
    localVaultStoreCredential(cfg, "SECRET", "x");

    const exp = localVaultExport(cfg);
    expect(exp.totalEntries).toBe(1); // credential excluded
    expect(exp.entries[0].content).toBe("v2");

    const del = localVaultDelete(cfg, a.key);
    expect(del.versionsRemoved).toBe(2);
    expect(() => localVaultRead(cfg, a.key)).toThrow(/not found/i);
  });
});
