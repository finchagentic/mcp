// Query planning: sub-query derivation, LLM planners (flat + multi-angle),
// the deep-mode adversarial critic, and gap-finding reflection.

import { callLLM } from "../llm.js";
import { safeParseJson, todayISO, currentYearMonth } from "./deep-research-text.js";

/**
 * Sub-queries without an LLM.
 *
 * The caller should normally pass `queries` — it is a model and plans better
 * than any heuristic. This exists so the evidence-pack path still works with
 * zero configuration, rather than failing when no API key is set.
 */
export function deriveSubQueries(
  query: string,
  n: number,
  focus?: string,
  freshMode?: { days: number }
): string[] {
  const base = query.trim().replace(/\?+$/, "");
  const recency = freshMode ? ` ${new Date().getFullYear()} latest` : "";
  const lenses = focus
    ? [focus, `${focus} risks`, `${focus} data`]
    : ["overview", "latest developments", "risks and criticism", "data and numbers", "expert analysis"];

  const out = [`${base}${recency}`];
  for (const lens of lenses) {
    if (out.length >= Math.max(2, n)) break;
    out.push(`${base} ${lens}${recency}`);
  }
  return out;
}

export async function planQueries(query: string, n: number, focus?: string, priorContext?: string, freshMode?: { days: number }): Promise<string[]> {
  const focusNote = focus ? ` Focus angle: ${focus}.` : "";
  const sys = "You are a research planner. Output strict JSON only - no preamble, no markdown.";

  const freshNote = freshMode
    ? `

⏱ FRESH MODE - last ${freshMode.days} days:
- Add a recency hint to most sub-questions: "in ${currentYearMonth()}", "last ${freshMode.days} days", "this week", "as of ${todayISO()}", etc.
- Prefer queries that surface news / press releases / X posts over evergreen background.
- Skip generic background - the user wants what's CURRENT, not historical.
- At least 70% of sub-questions must include a date or recency token.`
    : "";

  const continuationNote = priorContext
    ? `

⚠️ CONTINUATION MODE - there is a PRIOR research report on this topic:

"""
${priorContext.slice(0, 2500)}
"""

Your sub-questions must focus on:
1. UPDATES - what has changed since the prior report (new releases, news, data revisions)
2. GAPS - angles the prior report explicitly listed as open questions or follow-ups
3. NEW developments - entities/events the prior report doesn't mention
4. VERIFICATION - claims the prior report flagged as low-confidence or single-source

DO NOT re-tread material already well-covered in the prior report. The user already has those answers.`
    : "";

  const user = `Decompose this research question into ${n} sub-questions that together cover the topic from different angles.${focusNote}${continuationNote}${freshNote}

Rules:
- Each sub-question must be a standalone web search query, under 90 chars.
- Cover different facets: definition, current state, key actors, comparisons, counterarguments, recent news, forward outlook.
- No duplicates, no near-paraphrases.

ENTITY-HUNTING - at least HALF of your sub-questions must target queries likely to surface:
- Specific company / product / framework names (e.g., "LangGraph adoption stats", "Manus orchestration funding")
- Dollar amounts (acquisitions, funding rounds, revenue, ARR, market size)
- Benchmark numbers (% adoption, latency ms, accuracy scores, MMLU/HumanEval/SWE-bench results)
- Specific dates and timeline events (when X launched, when Y reached scale)
- Named studies / surveys / reports (e.g., "Anthropic Economic Index 2026", "a16z AI infrastructure report")

Bad: "what is X" → too generic, returns Wikipedia
Good: "X adoption rate enterprise 2026 survey" → returns concrete stats

Question: "${query}"

Return: {"queries": ["...", "..."]} - exactly ${n} items.`;

  let raw = "";
  try { raw = await callLLM(sys, user, 500, [], 30_000); } catch { return [query]; }

  const parsed = safeParseJson<{ queries?: unknown }>(raw, {});
  if (!parsed.queries || !Array.isArray(parsed.queries)) return [query];
  const queries = parsed.queries
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 200)
    .slice(0, n);
  return queries.length > 0 ? queries : [query];
}

// ─── Multi-agent angle decomposition ─────────────────────────────────────────
// Replaces flat sub-query planning for standard/deep depths. Each angle is a
// labeled facet of the topic - what would be a "specialist agent's territory"
// in a swarm. The synthesizer consumes findings ORGANIZED by angle, so the
// final report has structural diversity (not all sources blended together).
//
// Effect at runtime: same number of LLM calls as the flat path (one planner
// + one synthesizer), but angle structure flows through every stage. In
// deep mode, an extra critic call audits findings before final synthesis.

export type ResearchAngle = {
  label: string;            // "on-chain data + TVL flows"
  rationale: string;        // why this angle matters for the topic
  queries: string[];        // 2-3 web search queries for this angle
};

export async function planAngles(
  query: string,
  n: number,
  focus?: string,
  priorContext?: string,
  freshMode?: { days: number },
): Promise<ResearchAngle[]> {
  const focusNote = focus ? ` Focus angle: ${focus}.` : "";

  const freshNote = freshMode
    ? `\n\n⏱ FRESH MODE - last ${freshMode.days} days: bias each angle's queries toward news/recent press/dated reports.`
    : "";

  const continuationNote = priorContext
    ? `\n\n⚠️ CONTINUATION - prior report exists. Angles must focus on UPDATES, GAPS, NEW developments since:\n"""\n${priorContext.slice(0, 1500)}\n"""`
    : "";

  const sys = "You are a research planner that decomposes topics into specialist angles. Output strict JSON only.";

  const user = `Break this research topic into ${n} DIFFERENT specialist angles. Each angle gets its own 2-3 search queries.${focusNote}${continuationNote}${freshNote}

Topic: "${query}"

Pick angles that are GENUINELY different - not paraphrases of the same question. Good angle diversity examples:
- data / quantitative metrics
- competitive landscape
- team / governance / actors
- recent news / catalysts
- counterarguments / risks / criticism
- forward outlook / projections
- historical context / origins
- regulatory / policy angle
- technical / mechanism
- ecosystem partners

Pick the ${n} angles that most fit THIS specific topic. Each angle should have a label (3-6 words) and rationale (1 sentence). Queries must be standalone, ≤90 chars, entity-rich (specific names, dollar amounts, dates, benchmark numbers - NOT generic background).

Return strict JSON:
{
  "angles": [
    {
      "label": "...",
      "rationale": "...",
      "queries": ["...", "..."]
    }
  ]
}

Exactly ${n} angles. 2-3 queries per angle. No duplicate queries across angles.`;

  let raw = "";
  try { raw = await callLLM(sys, user, 1200, [], 30_000); } catch { return []; }

  const parsed = safeParseJson<{ angles?: unknown }>(raw, {});
  if (!parsed.angles || !Array.isArray(parsed.angles)) return [];

  const angles: ResearchAngle[] = [];
  for (const a of parsed.angles) {
    if (typeof a !== "object" || a === null) continue;
    const o = a as any;
    if (typeof o.label !== "string" || typeof o.rationale !== "string") continue;
    if (!Array.isArray(o.queries)) continue;
    const queries = (o.queries as unknown[])
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length > 0 && q.length <= 200)
      .slice(0, 3);
    if (queries.length === 0) continue;
    angles.push({
      label: o.label.trim().slice(0, 80),
      rationale: o.rationale.trim().slice(0, 200),
      queries,
    });
    if (angles.length >= n) break;
  }
  return angles;
}

// Adversarial critic - only runs for depth=deep. Reads the draft + sources
// already gathered and produces a structured challenge block: single-source
// claims, contradictions across angles, speculation framed as fact. The
// final synthesizer is told to incorporate or refute these challenges
// explicitly, lifting the quality floor.
export async function runCritic(
  query: string,
  draft: string,
  angles: ResearchAngle[],
  sourceCount: number,
): Promise<string> {
  const sys = "You are an adversarial research critic. Be terse, specific, and unsparing. Output markdown.";

  const angleLabels = angles.map((a, i) => `${i + 1}. ${a.label}`).join("\n");

  const user = `Original question: "${query}"

Specialist angles investigated:
${angleLabels}

Total sources gathered: ${sourceCount}

Draft report:
"""
${draft.slice(0, 5000)}
"""

Audit the draft for quality problems. Be specific and quote spans where possible.

Identify:
1. **Single-source claims** - major assertions resting on one [N] citation that aren't widely corroborated
2. **Contradictions** - places where different sources disagree but the draft doesn't surface the disagreement
3. **Speculation framed as fact** - confident statements about future/intent/cause without evidence
4. **Coverage gaps** - angles from the list above that got shallow treatment
5. **Stale or weak sources** - dated material treated as current, blog posts cited as primary data

Output format:
## Critic notes
- **[type]**: specific issue + relevant quote or claim. (1-2 sentences each)
- Skip categories with no findings - don't pad.

End with one line: "Net recommendation: [accept|revise|reject]"

If the draft is solid, say so plainly - don't manufacture issues.`;

  try {
    const notes = await callLLM(sys, user, 1500, [], 60_000);
    return notes.trim();
  } catch {
    return ""; // critic failure shouldn't block final synth
  }
}

export async function reflectAndExtend(query: string, draft: string, existingQueries: string[], n: number): Promise<string[]> {
  const sys = "You are a research auditor. Find gaps in a draft report and propose follow-up search queries. Output strict JSON.";
  const user = `Original question: "${query}"

Queries already run:
${existingQueries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Draft report:
"""
${draft.slice(0, 4000)}
"""

Identify ${n} GAPS in the draft - angles missing, claims that need verification, counter-perspectives not represented, or recent developments not covered. For each gap, give ONE web search query (≤90 chars) that would fill it.

Return: {"gap_queries": ["...", "..."]} - exactly ${n} items, no duplicates of existing queries.`;

  let raw = "";
  try { raw = await callLLM(sys, user, 500, [], 30_000); } catch { return []; }

  const parsed = safeParseJson<{ gap_queries?: unknown }>(raw, {});
  if (!parsed.gap_queries || !Array.isArray(parsed.gap_queries)) return [];
  return parsed.gap_queries
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 200)
    .slice(0, n);
}
