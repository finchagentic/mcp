// Report synthesis: source classification, the main LLM synthesis call,
// citation-density retry, and the structural/citation quality checks that
// gate whether a report ships as-is or gets one retry.

import { callLLM, type LiveSearchOptions } from "../llm.js";
import { callConvex } from "../convex.js";
import { enrichQuery, todayContext } from "../enrichment-router.js";
import { searchSupermemory } from "./memory.js";
import { todayISO } from "./deep-research-text.js";
import type { ResearchAngle } from "./deep-research-planning.js";

export type SourceClass = "primary" | "expert" | "secondary" | "market" | "unclassified";

export function classifySource(score: number): SourceClass {
  if (score >= 3) return "primary";
  if (score === 2) return "expert";
  if (score === 1) return "secondary";
  if (score < 0) return "market";
  return "unclassified";
}

export interface Source {
  n: number;
  url: string;
  domain: string;
  title: string;
  excerpt: string;
  score: number;
  class: SourceClass;
  publishedAt?: string;
}

export async function synthesize(
  query: string,
  sources: Source[],
  isFinal: boolean,
  liveSearch?: LiveSearchOptions,
  priorContext?: { key: string; content: string },
  freshMode?: boolean,
  angles?: ResearchAngle[],
  criticNotes?: string,
): Promise<{ report: string; liveCitations: string[] }> {
  const sourceBlocks = sources
    .map((s) => {
      const dateNote = s.publishedAt ? ` (published ${s.publishedAt.slice(0, 10)})` : "";
      const classNote = s.class !== "unclassified" ? ` [${s.class}]` : "";
      return `[${s.n}]${classNote} ${s.title} - ${s.domain}${dateNote}\nURL: ${s.url}\n\n${s.excerpt}`;
    })
    .join("\n\n---\n\n");

  // Multi-domain enrichment - auto-detect topic (crypto/tech/academic/general)
  // and pull live primary-source data in parallel. Crypto routes to DefiLlama
  // + CoinGecko; tech to HackerNews + GitHub; academic to arXiv; general to
  // Wikipedia. The combined block prepends to source blocks and is tagged
  // AUTHORITATIVE LIVE DATA so the LLM treats those numbers as ground truth.
  const enrichment = isFinal ? await enrichQuery(query) : { context: "", hasData: false, domains: [] as string[] };

  // Profile + memory auto-injection - only on final synthesis.
  // Profile: persistent identity/business/state from vault.
  // Memory: top relevant memories for this query (personalizes report framing).
  // Both run in parallel; either can fail without blocking synthesis.
  let profileContext = "";
  let memoryContext = "";
  if (isFinal) {
    const [profileData, memHits] = await Promise.allSettled([
      callConvex("/vault/profile-context?maxChars=1200", "GET", undefined, "vault_read"),
      searchSupermemory(query, 4),
    ]);
    if (profileData.status === "fulfilled") {
      profileContext = ((profileData.value as any)?.context ?? "").trim();
    }
    if (memHits.status === "fulfilled" && memHits.value.length > 0) {
      memoryContext = memHits.value
        .map((r) => {
          const title = r.metadata?.title ? `[${r.metadata.title}] ` : "";
          return `- ${title}${r.content.slice(0, 200).replace(/\n/g, " ")}`;
        })
        .join("\n");
    }
  }

  const liveSearchNote = liveSearch
    ? `\n\nIMPORTANT - Real-time augmentation:
You have Live Search enabled. In addition to the numbered sources above, you have access to **real-time results from ${liveSearch.sources.join(", ")}**. Use them to:
1. Verify recent claims (last ${liveSearch.fromDate ? "from " + liveSearch.fromDate : "few weeks"})
2. Add fresh data points the static sources may have missed
3. Surface X (Twitter) posts when the topic is moving quickly
4. Pull current numbers when the static sources are dated

CITATION RULE for Live Search content:
- Numbered sources [N] = static scraped sources at top of prompt
- Real-time content from Live Search: cite inline as **(X post)** or **(news, [outlet])** WITHOUT [N] numbering - they'll be appended to the Sources section automatically
- If a Live Search result contradicts a static source, FLAG it as "(real-time conflicts with [N])"`
    : "";

  const finalSections = isFinal
    ? `## TL;DR
2-3 sentences answering the question directly. No hedging unless evidence demands it.

## At a Glance
A Markdown table summarizing 4-8 key metrics, dimensions, or status indicators from the sources. Format:
| Dimension | Value / Status | Source |
|---|---|---|
| (example) Production adoption | 57% have agents in production | [3] |

Use tables whenever you have:
- Comparison data (X vs Y vs Z)
- Status snapshots (multiple metrics at one point in time)
- Rankings or scorecards
- Dollar amounts, percentages, dates side-by-side

This section is REQUIRED whenever the sources contain quantitative data. Skip ONLY if the topic is purely qualitative.

## Key Findings
- 6-10 substantive bullets, each citing source numbers like [1] or [2,4]
- Lead with specific named entities, dollar amounts, percentages, dates - not generalities
- Mix angles - definition, current state, comparisons, criticisms
- Tag each bullet with a confidence level at the end: \`(high)\` / \`(medium)\` / \`(low)\`
- "high" means primary sources or strong consensus; "low" means single source or contested

## Analysis
3-5 paragraphs synthesizing the sources. Connect findings, note tensions and gaps, distinguish correlation from causation. Use inline citations throughout - every numerical claim or named entity must carry a [N].

## Counterevidence & Limitations
- 2-4 bullets listing what could change the conclusion: weak sources, missing data, conflicting findings, age of evidence
- This section is required - never skip it

## Follow-up Questions
- 3-5 questions a curious reader would ask after reading this report
- Make them concrete and answerable, not philosophical`
    : `## Draft Summary
Single paragraph synthesis covering the main findings from sources, with inline citations.`;

  const profileBlock = profileContext
    ? `\n\n<user_profile>\n${profileContext}\n</user_profile>\n`
    : "";

  const memoryBlock = memoryContext
    ? `\n\n<user_memory>\nStored knowledge about this user — use to frame the report toward their known interests, not to fabricate facts:\n${memoryContext}\n</user_memory>\n`
    : "";

  const sys = `You are a senior analyst writing a structured research report from numbered web sources.

${todayContext()}${profileBlock}${memoryBlock}

OUTPUT FORMAT (strict - exact Markdown sections, in this order):

# {short concrete title - max 10 words}

${finalSections}

SOURCE CLASS TAGGING (mandatory in Key Findings):
Each source in the list above is labeled [primary] / [expert] / [secondary] / [market].
- [primary]: official docs, .gov/.edu, protocol data (DefiLlama, CoinGecko, etherscan), peer-reviewed
- [expert]: named researchers, audit reports, tier-1 financial press (Reuters, FT, Bloomberg)
- [secondary]: crypto media, newsletters, Wikipedia, GitHub
- [market]: X/Twitter, Reddit, Substack, prediction markets - sentiment, not fact

TAG RULES:
- Every Key Findings bullet must end with the source class of its strongest citation, e.g. "[primary]" or "[market]"
- Example: "Aerodrome TVL reached $2.1B in June 2026 [3] [primary]"
- If a bullet's evidence mixes classes, use the LOWEST class: one Reddit citation drags the whole bullet to "[market]"

CONTRADICTION RULES (mandatory):
- When two sources disagree on a fact, do NOT average them. Surface the conflict explicitly:
  "Source [N] says X; source [M] says not-X - reconciliation: ..."
- Put irreconcilable contradictions in Counterevidence & Limitations, not Key Findings
- A single uncontested source is flagged: "(single source [N])"

CITATION DENSITY RULES:
- Every numerical claim (percentage, dollar amount, count, date) MUST carry [N]
- Every named entity (company, product, framework, person) MUST carry [N] on first mention
- Target: at least 1 citation per 50 words in Key Findings and Analysis
- Note source dates when relevant - older sources may be stale

STYLE RULES:
- Be specific: numbers, names, dates over vague claims
- Lead with concrete entities, not abstract concepts
- Tables > bullets when comparing dimensions
- No filler ("it is important to note", "in conclusion", "in today's world", "navigate the landscape")
- No hedging when evidence is strong; no false confidence when it's weak
- Don't write a Sources section - that gets appended automatically`;

  const freshBlock = freshMode && isFinal
    ? `

⏱ FRESH MODE active - today is ${todayISO()}:
- Prioritize claims dated within the last 30 days. If a source is older, only cite it if it's primary evidence (data, official statement).
- In the At a Glance table, include a "Date" column showing the publish date for each metric.
- In Key Findings, prefix each bullet with the source's publish date in brackets: [2026-MM-DD] Finding text [N].
- In Counterevidence, flag any claim whose evidence is older than 60 days as "(potentially stale).".`
    : "";

  const continuationBlock = priorContext && isFinal
    ? `

PRIOR REPORT (you are CONTINUING this research, not starting fresh):

\`\`\`
${priorContext.content.slice(0, 3500)}
\`\`\`

CONTINUATION RULES:
- Start the TL;DR with: "Update to prior report \`${priorContext.key}\` -" followed by the new takeaway.
- The "At a Glance" table must include a column "Δ since prior" showing what changed.
- Key Findings must mark each bullet with: \`(NEW)\` for genuinely new info, \`(UPDATED)\` for changed numbers/positions, or \`(CONFIRMED)\` for points the new sources reinforce.
- Counterevidence section must explicitly say which prior claims are now weaker.
- Follow-up Questions must build on the prior report's open questions if they're still relevant.

Do not re-explain background already in the prior report. Assume the reader read it.`
    : "";

  const enrichmentBlock = enrichment.hasData
    ? `\n\n${enrichment.context}\n\n`
    : "";

  // Specialist angles - when present, tell the synthesizer to mirror this
  // structure in the report (Key Findings organized by angle, At a Glance
  // table dimensions match the angles). Without this, the model blends
  // every angle into a homogeneous narrative.
  const anglesBlock = isFinal && angles && angles.length > 0
    ? `\n\nSPECIALIST ANGLES INVESTIGATED:
${angles.map((a, i) => `${i + 1}. **${a.label}** - ${a.rationale}`).join("\n")}

Mirror this structure: Key Findings should group bullets by angle (use the angle label as a sub-header), and the At a Glance table dimensions should match the angles.`
    : "";

  // Critic notes (deep mode only) - explicit weaknesses surfaced during
  // the audit pass. The synthesizer must address each one rather than
  // simply ignoring it. This is the strongest single quality lever.
  const criticBlock = isFinal && criticNotes && criticNotes.length > 50
    ? `\n\nCRITIC AUDIT - concrete weaknesses found in the draft. You MUST address each one in the final report (either by revising the claim, surfacing the uncertainty, or providing additional support):

${criticNotes}

If a critic concern can't be resolved with the sources you have, surface it in Counterevidence & Limitations rather than burying it.`
    : "";

  const user = `RESEARCH QUESTION: ${query}
${enrichmentBlock}
SOURCES:
${sourceBlocks}${liveSearchNote}${continuationBlock}${freshBlock}${anglesBlock}${criticBlock}

Write the ${isFinal ? "final" : "draft"} report now. Markdown only - no preamble, no postamble.${
    enrichment.hasData
      ? `\n\nIMPORTANT: The AUTHORITATIVE LIVE DATA block at the top contains current numbers from primary APIs (DefiLlama, CoinGecko). Lead with these numbers when they exist - they override any conflicting figures in the scraped sources below. Cite them as [DefiLlama] or [CoinGecko].`
      : ""
  }`;

  // Research synthesis uses FINCH_RESEARCH_MODEL when set. Default is
  // `grok-4.3` - when Bankr is the active gateway this routes to Grok 4.3
  // through Bankr (Grok handles fresh data better; Claude is the safer
  // pick for reasoning, JSON, code). Override via env or pass the same
  // model string to FINCH_MODEL to bypass.
  const researchModel = process.env.FINCH_RESEARCH_MODEL ?? "grok-4.3";
  // Deep mode (critic notes present, or the 5-angle planner ran) produces a
  // longer report than the standard 6-section template - a fixed 4000-token
  // budget was cutting deep reports off mid-sentence around risk #6-7 of 13+.
  const isDeepMode = !!criticNotes || (angles?.length ?? 0) >= 5;
  const finalTokens = isDeepMode ? 7000 : 4000;
  const raw = await callLLM(sys, user, isFinal ? finalTokens : 2000, [], 90_000, { liveSearch, model: researchModel });
  const { content: report, liveCitations } = extractLiveCitations(raw);

  // Citation density check - only for final reports. If the report has many
  // numerical claims but very few [N] citations, retry once with a stricter
  // instruction. Cheap insurance against lazy synthesis.
  if (!isFinal) return { report, liveCitations };

  const density = measureCitationDensity(report);
  if (density.numericalClaims >= 5 && density.citations < Math.max(3, density.numericalClaims / 2)) {
    const retryUser = `${user}

⚠️ Your previous draft had ${density.numericalClaims} numerical claims but only ${density.citations} [N] citations. That ratio is too low. Rewrite with stricter citation density: every percentage, dollar amount, count, date, and named entity must carry [N]. Use the At a Glance table to anchor the key metrics.`;
    try {
      const rawRetry = await callLLM(sys, retryUser, finalTokens, [], 90_000, { liveSearch, model: researchModel });
      const { content: retryReport, liveCitations: retryCitations } = extractLiveCitations(rawRetry);
      return { report: retryReport, liveCitations: retryCitations.length > 0 ? retryCitations : liveCitations };
    } catch {
      return { report, liveCitations };
    }
  }

  return { report, liveCitations };
}

// Strip the GROK_LIVE_CITATIONS sentinel block (added by callGrok when Live
// Search ran) and return the citation URLs separately.
export function extractLiveCitations(raw: string): { content: string; liveCitations: string[] } {
  const match = raw.match(/<!--GROK_LIVE_CITATIONS\n([\s\S]*?)\nGROK_LIVE_CITATIONS-->/);
  if (!match) return { content: raw, liveCitations: [] };
  const urls = match[1].split("\n").map((u) => u.trim()).filter(Boolean);
  return { content: raw.replace(match[0], "").trimEnd(), liveCitations: urls };
}

export function measureCitationDensity(report: string): { numericalClaims: number; citations: number; namedEntities: number } {
  // Numerical claims: percentages, dollar amounts, large counts, years
  const percentages = report.match(/\d+(?:\.\d+)?\s*%/g) ?? [];
  const dollars = report.match(/\$\s*\d+(?:\.\d+)?\s*(?:[KkMmBbTt]|million|billion|trillion)?/g) ?? [];
  const counts = report.match(/\b\d{1,3}(?:,\d{3})+\b/g) ?? [];
  const years = report.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const numericalClaims = percentages.length + dollars.length + counts.length + years.length;

  // Inline citations
  const citationsMatches = report.match(/\[\d+(?:\s*,\s*\d+)*\]/g) ?? [];
  const citations = citationsMatches.length;

  // Capitalized multi-word entities (proper nouns) - proxy for named entities
  const namedEntities = (report.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+|\s+[A-Z][a-z]+)\b/g) ?? []).length;

  return { numericalClaims, citations, namedEntities };
}

// Output structure validation - returns the names of any failed checks.
// Used to decide whether the synthesis output is worth retrying.
export function validateReportStructure(report: string): string[] {
  const issues: string[] = [];

  // 1. "At a Glance" section with a Markdown table
  const atGlance = report.match(/##\s*At a Glance[\s\S]*?(?=\n##|\n#|$)/i);
  if (!atGlance) {
    issues.push("missing-at-a-glance");
  } else {
    // Markdown table = at least 2 lines that start with `|`
    const tableLines = (atGlance[0].match(/^\|.+\|.+$/gm) ?? []).length;
    if (tableLines < 2) issues.push("at-a-glance-no-table");
  }

  // 2. Counterevidence section must exist and be non-trivial
  const counter = report.match(/##\s*Counterevidence[\s\S]*?(?=\n##|\n#|$)/i);
  if (!counter) {
    issues.push("missing-counterevidence");
  } else {
    const counterText = counter[0].replace(/##.*$/m, "").trim();
    if (counterText.length < 80) issues.push("counterevidence-too-short");
  }

  // 3. Citation density - every 200 words should have at least 1 [N] citation
  // in the Key Findings + Analysis sections
  const findingsAndAnalysis = report
    .replace(/^#.+$/m, "") // strip title
    .replace(/##\s*(TL;DR|At a Glance|Sources|Follow-up Questions)[\s\S]*?(?=\n##|\n#|$)/gi, "")
    .replace(/##\s*Counterevidence[\s\S]*?(?=\n##|\n#|$)/gi, "");
  const wordCount = findingsAndAnalysis.split(/\s+/).filter(Boolean).length;
  const citationCount = (findingsAndAnalysis.match(/\[\d+(?:\s*,\s*\d+)*\]/g) ?? []).length;
  if (wordCount >= 200 && citationCount < Math.floor(wordCount / 200)) {
    issues.push("low-citation-density");
  }

  // 4. Follow-up Questions section present
  if (!report.match(/##\s*Follow-up Questions/i)) {
    issues.push("missing-followups");
  }

  return issues;
}

// Group Live Search citations by source type (X, news, web) for readability.
export function formatLiveCitations(urls: string[]): string {
  const groups: Record<string, string[]> = { "X (Twitter)": [], "News": [], "Web": [] };
  for (const url of urls) {
    if (/x\.com|twitter\.com/i.test(url)) groups["X (Twitter)"].push(url);
    else if (/(reuters|apnews|bbc|cnbc|bloomberg|theverge|techcrunch|wsj|ft|nytimes|coindesk|axios|economist)\.com/i.test(url)) groups["News"].push(url);
    else groups["Web"].push(url);
  }
  const lines: string[] = [];
  for (const [label, list] of Object.entries(groups)) {
    if (list.length === 0) continue;
    lines.push(`**${label}** (${list.length}):`);
    for (const url of list.slice(0, 8)) {
      lines.push(`- ${url}`);
    }
    if (list.length > 8) lines.push(`- _…and ${list.length - 8} more_`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
