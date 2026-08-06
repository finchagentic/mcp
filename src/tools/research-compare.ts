import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { callConvex } from "../convex.js";

// ─── Tool schema ──────────────────────────────────────────────────────────────

export const RESEARCH_COMPARE_TOOLS: Tool[] = [
  {
    name: "research_compare",
    description:
      "Diff two vault research reports. Two-pass, no API key needed. " +
      "PASS 1 — call with keyA + keyB: loads both reports, extracts their section structure, and returns " +
      "both bodies plus the comparison rubric for YOU to write. " +
      "PASS 2 — call again with the same keys plus `comparison`: saves your write-up as type:research and " +
      "auto-links it to both source reports.",
    inputSchema: {
      type: "object",
      properties: {
        keyA: {
          type: "string",
          description: "Vault key of the FIRST (older / baseline) report. Format: 'research/...' - use vault_list type:research to find candidates.",
        },
        keyB: {
          type: "string",
          description: "Vault key of the SECOND (newer / current) report to compare against keyA.",
        },
        focus: {
          type: "string",
          description: "Optional aspect to focus the comparison on: 'numbers', 'sentiment', 'sources', 'predictions', 'consensus'. Default: all.",
        },
        comparison: {
          type: "string",
          description: "PASS 2 only. Your finished comparison in Markdown. Supplying it switches this tool from 'return the evidence' to 'save and link the result'.",
        },
        saveToVault: { type: "boolean", description: "Save the pass-2 comparison to vault (default true)" },
        maxChars: {
          type: "number",
          description: "Max characters of each report body to return in pass 1 (default 12000, max 40000). Raise it if the reports are long and you need the full text.",
        },
      },
      required: ["keyA", "keyB"],
    },
  },
];

const InputSchema = z.object({
  keyA: z.string().min(3).max(200),
  keyB: z.string().min(3).max(200),
  focus: z.string().max(80).optional(),
  comparison: z.string().min(1).optional(),
  saveToVault: z.boolean().optional(),
  maxChars: z.number().int().min(1000).max(40_000).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadVaultEntry(key: string): Promise<{ key: string; title: string; content: string; updatedAt?: number } | null> {
  try {
    const entry = await callConvex(
      `/vault/entry?key=${encodeURIComponent(key)}`,
      "GET",
      undefined,
      "vault_read",
    ) as { key?: string; title?: string; content?: string; updatedAt?: number } | null;
    if (!entry?.content) return null;
    return {
      key: entry.key ?? key,
      title: entry.title ?? key,
      content: entry.content,
      updatedAt: entry.updatedAt,
    };
  } catch {
    return null;
  }
}

function slugifyKey(key: string): string {
  return key.replace(/^research\//, "").replace(/[^a-z0-9-]/gi, "-").slice(0, 50);
}

// ─── Structural diff ──────────────────────────────────────────────────────────
// Mechanical work the caller shouldn't have to eyeball: which sections exist in
// one report and not the other, and how the bodies differ in size. It is not a
// judgement about what changed - that's the caller's job - but it tells them
// where to look first.

function sectionHeadings(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (m) out.push(m[1].replace(/[*`]/g, "").trim());
  }
  return out;
}

function normHeading(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface StructuralDiff {
  onlyInA: string[];
  onlyInB: string[];
  shared: string[];
}

function diffStructure(a: string, b: string): StructuralDiff {
  const ha = sectionHeadings(a);
  const hb = sectionHeadings(b);
  const na = new Map(ha.map((h) => [normHeading(h), h]));
  const nb = new Map(hb.map((h) => [normHeading(h), h]));
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const shared: string[] = [];
  for (const [k, h] of na) (nb.has(k) ? shared : onlyInA).push(h);
  for (const [k, h] of nb) if (!na.has(k)) onlyInB.push(h);
  return { onlyInA, onlyInB, shared };
}

// The discipline the old synthesis prompt enforced, moved into the output so
// the user can see it and steer it. The "Weakened or Removed" section is the
// one that matters most and the one a model skips first if not told to keep it.
function comparisonRubric(dateA: string, dateB: string, focus?: string): string {
  return [
    `## Write the comparison from this`,
    ``,
    `Show what **changed** in the understanding — not a side-by-side rehash of both reports.`,
    ``,
    `### TL;DR`,
    `2-3 sentences. Lead with the most important shift. No filler.`,
    ``,
    `### Net Direction`,
    `One line: **STRENGTHENED** / **WEAKENED** / **PIVOTED** / **REFINED**, then 1-2 sentences on why.`,
    ``,
    `### At a Glance`,
    `A table with exactly these columns, 5-8 rows of the most important shifts, ↑/↓/→/⚡/❓ in Change:`,
    ``,
    `| Dimension | ${dateA} (A) | ${dateB} (B) | Change |`,
    `|---|---|---|---|`,
    ``,
    `### 🆕 New in B`,
    `3-6 bullets — findings, entities or data points present in B and absent from A.`,
    ``,
    `### 🔄 Updated`,
    `3-6 bullets, each as "{Claim}: was {A's position}, now {B's position}".`,
    ``,
    `### ⚠️ Weakened or Removed`,
    `2-4 bullets — claims A made that B contradicts, drops, or is less confident about. ` +
      `**Do not skip this section.** It is the "what we got wrong" record and it is the whole point of ` +
      `comparing. If nothing weakened, say so explicitly rather than omitting the heading.`,
    ``,
    `### Confidence Shift`,
    `Did overall confidence rise or fall? Are B's sources stronger? Are its predictions more grounded?`,
    ``,
    `### What to Watch Next`,
    `3-4 forward-looking questions this comparison raised.`,
    ``,
    `**Rules:** quote actual numbers and names from both bodies. No hedging filler. If A was right and B ` +
      `is worse-sourced, say that. Don't manufacture differences — an unchanged dimension gets one line.` +
      (focus ? ` **Focus on ${focus}; down-weight everything else.**` : ""),
    ``,
    `When you're done, call \`research_compare\` again with the same keys plus \`comparison: "<your markdown>"\` ` +
      `to save it to the vault and link it to both sources.`,
  ].join("\n");
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleResearchCompare(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "research_compare") return null;

  const parsed = InputSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
  }

  const { keyA, keyB, focus, comparison } = parsed.data;
  const saveToVault = parsed.data.saveToVault ?? true;
  const maxChars = parsed.data.maxChars ?? 12_000;

  if (keyA === keyB) {
    return { content: [{ type: "text", text: "keyA and keyB are the same - comparison needs two different reports." }], isError: true };
  }

  // Load both reports in parallel
  const progress: string[] = [];
  const log = (line: string) => progress.push(line);

  log(`📂 Loading report A: \`${keyA}\``);
  log(`📂 Loading report B: \`${keyB}\``);
  const [reportA, reportB] = await Promise.all([loadVaultEntry(keyA), loadVaultEntry(keyB)]);

  if (!reportA) {
    return { content: [{ type: "text", text: `Could not load report A (\`${keyA}\`). Check the vault key is correct and you're authenticated. Use vault_list type:research to find candidates.` }], isError: true };
  }
  if (!reportB) {
    return { content: [{ type: "text", text: `Could not load report B (\`${keyB}\`). Check the vault key is correct.` }], isError: true };
  }

  log(`✅ Loaded A (${reportA.content.length} chars) and B (${reportB.content.length} chars).`);

  const dateA = reportA.updatedAt ? new Date(reportA.updatedAt).toISOString().slice(0, 10) : "earlier";
  const dateB = reportB.updatedAt ? new Date(reportB.updatedAt).toISOString().slice(0, 10) : "later";

  // ── PASS 2: caller brought the finished comparison - save it and link it ──
  if (comparison) {
    let compareKey: string | null = null;
    if (saveToVault) {
      try {
        const titleA = reportA.title.replace(/^Deep Research(?:\s*\(cont\.\))?:\s*/i, "").slice(0, 30);
        const titleB = reportB.title.replace(/^Deep Research(?:\s*\(cont\.\))?:\s*/i, "").slice(0, 30);
        const r = (await callConvex("/vault/save", "POST", {
          type: "research",
          title: `Compare: ${titleA} vs ${titleB}`,
          content: comparison,
          tags: ["research-compare", "comparison", ...(focus ? [`focus:${focus}`] : [])],
          agentId: "research",
          commitMsg: `compare ${slugifyKey(keyA)} vs ${slugifyKey(keyB)}`,
        }, "vault_save")) as { key?: string } | null;
        compareKey = r?.key ?? null;
        log(`💾 Saved comparison to vault: \`${compareKey}\``);
      } catch {
        log(`⚠️ Vault save skipped (not authenticated).`);
      }
    }

    // Auto-link to both source reports
    if (compareKey) {
      for (const target of [keyA, keyB]) {
        try {
          await callConvex("/vault/link", "POST", {
            fromKey: compareKey,
            toKey: target,
            relation: "references",
          }, "vault_link");
        } catch { /* silent */ }
      }
      log(`🔗 Linked comparison → ${keyA} (references)`);
      log(`🔗 Linked comparison → ${keyB} (references)`);
    }

    return {
      content: [{
        type: "text",
        text: [
          compareKey
            ? `📊 **Comparison saved** — \`${compareKey}\`, linked to \`${keyA}\` and \`${keyB}\`.`
            : `📊 **Comparison not saved** — vault write unavailable (not authenticated) or \`saveToVault: false\`.`,
          `🧬 Your knowledge base is now queryable across time.`,
          ``,
          `<details><summary>📋 Process log</summary>`,
          ``,
          progress.map((p) => `- ${p}`).join("\n"),
          ``,
          `</details>`,
        ].join("\n"),
      }],
    };
  }

  // ── PASS 1: return both bodies + the structural diff + the rubric ────────
  const struct = diffStructure(reportA.content, reportB.content);
  log(`🔍 Structural diff: ${struct.shared.length} shared sections, ${struct.onlyInA.length} only in A, ${struct.onlyInB.length} only in B.`);

  const clip = (s: string) =>
    s.length > maxChars
      ? `${s.slice(0, maxChars)}\n\n…[truncated ${s.length - maxChars} chars — raise \`maxChars\` for the rest]`
      : s;

  const structLines = [
    `**Sections only in A:** ${struct.onlyInA.length ? struct.onlyInA.join(" · ") : "none"}`,
    `**Sections only in B:** ${struct.onlyInB.length ? struct.onlyInB.join(" · ") : "none"}`,
    `**Shared sections:** ${struct.shared.length ? struct.shared.join(" · ") : "none"}`,
    `**Length:** A ${reportA.content.length.toLocaleString()} chars → B ${reportB.content.length.toLocaleString()} chars ` +
      `(${reportB.content.length >= reportA.content.length ? "+" : ""}${(((reportB.content.length - reportA.content.length) / Math.max(reportA.content.length, 1)) * 100).toFixed(0)}%)`,
  ].join("\n");

  const text = [
    `📊 **Research Compare** — \`${reportA.key}\` ⇄ \`${reportB.key}\``,
    ``,
    `<details><summary>📋 Process log</summary>`,
    ``,
    progress.map((p) => `- ${p}`).join("\n"),
    ``,
    `</details>`,
    ``,
    `## Structural diff`,
    ``,
    structLines,
    ``,
    `---`,
    ``,
    `## Report A — ${dateA} · ${reportA.title}`,
    `\`${reportA.key}\``,
    ``,
    clip(reportA.content),
    ``,
    `---`,
    ``,
    `## Report B — ${dateB} · ${reportB.title}`,
    `\`${reportB.key}\``,
    ``,
    clip(reportB.content),
    ``,
    `---`,
    ``,
    comparisonRubric(dateA, dateB, focus),
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
