import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { callConvex } from "../convex.js";

// ─── Tool schema ──────────────────────────────────────────────────────────────

export const RESEARCH_CHAIN_TOOLS: Tool[] = [
  {
    name: "research_chain",
    description:
      "Walk a research topic's timeline. Follows `continues` relations both backward and forward from a starting report and returns the chronological list with each report's date/title/TL;DR, plus the rubric for YOU to write the 'net evolution' — what shifted at each step. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        startKey: {
          type: "string",
          description: "Vault key of any research entry in the chain. The tool walks both directions from there. Format: 'research/...'",
        },
        maxDepth: {
          type: "number",
          description: "Max number of entries to walk in each direction. Default 8 (so up to 17 entries including start). Capped at 20.",
        },
        synthesize: {
          type: "boolean",
          description: "Append the 'net evolution' rubric after the timeline. Default true. Set false if you only want the raw timeline.",
        },
      },
      required: ["startKey"],
    },
  },
];

const InputSchema = z.object({
  startKey: z.string().min(3).max(200),
  maxDepth: z.number().int().min(1).max(20).optional(),
  synthesize: z.boolean().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ChainEntry {
  key: string;
  title: string;
  updatedAt?: number;
  content: string;
  tldr: string;
}

async function loadEntry(key: string): Promise<ChainEntry | null> {
  try {
    const e = (await callConvex(
      `/vault/entry?key=${encodeURIComponent(key)}`,
      "GET",
      undefined,
      "vault_read",
    )) as { key?: string; title?: string; content?: string; updatedAt?: number } | null;
    if (!e?.content) return null;
    return {
      key: e.key ?? key,
      title: e.title ?? key,
      updatedAt: e.updatedAt,
      content: e.content,
      tldr: extractTLDR(e.content),
    };
  } catch {
    return null;
  }
}

function extractTLDR(content: string): string {
  // Look for "## TL;DR" / "## Summary" section.
  const m = content.match(/##\s*(TL;DR|Summary)[\s\S]*?(?=\n##|\n#|$)/i);
  if (m) {
    const body = m[0].replace(/^##.*$/m, "").trim();
    return body.split("\n\n")[0].trim().slice(0, 320);
  }
  // Fallback: first non-header paragraph
  const para = content
    .split("\n\n")
    .find((p) => p.trim() && !p.trim().startsWith("#") && !p.trim().startsWith("📁") && !p.trim().startsWith("🔬"));
  return (para ?? "").trim().slice(0, 320);
}

async function getLinkedKeys(key: string, relation: "continues" | "continued_by"): Promise<string[]> {
  // /vault/related returns linked entries via vault_related. Each result has
  // direction "outbound" (this -> other) or "inbound" (other -> this).
  // continues = outbound continues link → next-older report
  // continued_by = inbound continues link → next-newer report
  try {
    const result = (await callConvex(
      `/vault/related?key=${encodeURIComponent(key)}&relation=continues`,
      "GET",
      undefined,
      "vault_related",
    )) as { related?: Array<{ key: string; direction: string }> } | null;
    const wanted = relation === "continues" ? "outbound" : "inbound";
    return (result?.related ?? [])
      .filter((r) => r.direction === wanted)
      .map((r) => r.key);
  } catch {
    return [];
  }
}

async function walkChain(startKey: string, maxDepth: number): Promise<ChainEntry[]> {
  const startEntry = await loadEntry(startKey);
  if (!startEntry) return [];

  const visited = new Set<string>([startKey]);

  // Walk backward: follow outbound `continues` links (this report continues prior).
  const backward: ChainEntry[] = [];
  let backCursor: string = startKey;
  for (let i = 0; i < maxDepth; i++) {
    const linkedKeys: string[] = await getLinkedKeys(backCursor, "continues");
    const next: string | undefined = linkedKeys.find((k: string) => !visited.has(k));
    if (!next) break;
    visited.add(next);
    const entry = await loadEntry(next);
    if (!entry) break;
    backward.unshift(entry);  // oldest at front
    backCursor = next;
  }

  // Walk forward: follow inbound `continues` links (other reports continue this one).
  const forward: ChainEntry[] = [];
  let fwdCursor: string = startKey;
  for (let i = 0; i < maxDepth; i++) {
    const linkedKeys: string[] = await getLinkedKeys(fwdCursor, "continued_by");
    const next: string | undefined = linkedKeys.find((k: string) => !visited.has(k));
    if (!next) break;
    visited.add(next);
    const entry = await loadEntry(next);
    if (!entry) break;
    forward.push(entry);
    fwdCursor = next;
  }

  return [...backward, startEntry, ...forward];
}

// The timeline is the tool's real work: walking `continues` relations in both
// directions, loading each entry, extracting its TL;DR and ordering the stops.
// Reading the arc off that timeline is model work, so the rubric travels with
// the data instead of a server-side summary the caller can't steer.
function evolutionRubric(chain: ChainEntry[]): string {
  const spanDays =
    chain[0].updatedAt && chain[chain.length - 1].updatedAt
      ? Math.round((chain[chain.length - 1].updatedAt! - chain[0].updatedAt!) / 86_400_000)
      : null;

  return [
    `## Write the net evolution from this`,
    ``,
    `4-6 sentences on how the understanding evolved across these ${chain.length} stops` +
      `${spanDays !== null ? ` (${spanDays} day${spanDays === 1 ? "" : "s"})` : ""}. Call out:`,
    ``,
    `- **Position shifts** — a claim that went from confident to weak, or the reverse`,
    `- **New entities or data points** and the exact stop where they appeared`,
    `- **Predictions** that came true or were falsified`,
    `- **Current state vs starting state**`,
    ``,
    `Synthesize the arc — do not list the reports back. Emphasise what CHANGED, not what held steady. ` +
      `Each TL;DR above is truncated: if the arc turns on a detail you can't see, read the full entry with ` +
      `\`vault_read\` before writing.`,
  ].join("\n");
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleResearchChain(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "research_chain") return null;

  const parsed = InputSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
  }

  const { startKey } = parsed.data;
  const maxDepth = parsed.data.maxDepth ?? 8;
  const synthesize = parsed.data.synthesize ?? true;

  const progress: string[] = [];
  const log = (line: string) => progress.push(line);

  log(`🔍 Loading start entry: \`${startKey}\``);
  log(`🧬 Walking continues chain (max ${maxDepth} steps each direction)...`);

  const chain = await walkChain(startKey, maxDepth);

  if (chain.length === 0) {
    return {
      content: [{
        type: "text",
        text: `Could not load \`${startKey}\` - check the vault key (use vault_list type:research) and make sure you're authenticated.`,
      }],
      isError: true,
    };
  }

  if (chain.length === 1) {
    return {
      content: [{
        type: "text",
        text:
          `🧬 **Research Chain** - \`${startKey}\` is a standalone report.\n\n` +
          `No \`continues\` links found in either direction. To start building a chain, ` +
          `run \`deep_research\` again on the same topic with \`continueFrom="${startKey}"\` - ` +
          `that creates the temporal link.\n\n` +
          `Once you have 2+ continuations, this tool will walk and synthesize the evolution.`,
      }],
    };
  }

  log(`✅ Loaded ${chain.length} entries in chain.`);

  // Render the timeline
  const timelineLines: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i];
    const date = e.updatedAt ? new Date(e.updatedAt).toISOString().slice(0, 10) : "-";
    const marker = e.key === startKey ? " ← you are here" : "";
    timelineLines.push(`### [${i + 1}/${chain.length}] ${date}${marker}`);
    timelineLines.push(`**${e.title}**`);
    timelineLines.push(`\`${e.key}\``);
    timelineLines.push("");
    timelineLines.push(e.tldr);
    timelineLines.push("");
    if (i < chain.length - 1) {
      timelineLines.push("⬇ *continues into*");
      timelineLines.push("");
    }
  }

  if (synthesize && chain.length >= 2) {
    log(`📐 Attached the net-evolution rubric for ${chain.length} stops.`);
  }
  const netEvolution = synthesize && chain.length >= 2 ? evolutionRubric(chain) : "";

  const header = [
    `🧬 **Research Chain** - ${chain.length} reports across the timeline`,
    `📍 You are at: \`${startKey}\``,
    chain[0].updatedAt && chain[chain.length - 1].updatedAt
      ? `🗓 Spans ${new Date(chain[0].updatedAt!).toISOString().slice(0, 10)} → ${new Date(chain[chain.length - 1].updatedAt!).toISOString().slice(0, 10)}`
      : "",
    ``,
    `<details><summary>📋 Process log</summary>`,
    ``,
    progress.map((p) => `- ${p}`).join("\n"),
    ``,
    `</details>`,
    ``,
  ].filter(Boolean).join("\n");

  const evolutionBlock = netEvolution ? `\n---\n\n${netEvolution}\n` : "";

  const text = [
    header,
    `## Timeline`,
    ``,
    timelineLines.join("\n"),
    evolutionBlock,
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
