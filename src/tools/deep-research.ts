// deep_research orchestrator: plan → search → scrape → (draft → reflect →
// critic) → synthesize → validate → save/link. Each stage's logic lives in
// its own deep-research-*.ts sibling module; this file wires them together.
//
// Kept at this exact path/name so server.ts's `./tools/deep-research.js`
// import needs no change.

import { ToolResult } from "../types.js";
import { isGrokActive, hasDirectLLMKey, grokLiveSearchHits, type LiveSearchOptions, type LiveSearchSource } from "../llm.js";
import { callConvex } from "../convex.js";
import { checkSignal } from "../signal-gate.js";

import { MAX_PER_DOMAIN, FRESH_TRIGGER_RE } from "./deep-research-constants.js";
import { InputSchema } from "./deep-research-tools.js";
import {
  extractQueryTerms,
  domainOf,
  tierBonus,
  pickBestExcerpt,
  rankAndDedupe,
  buildSearchTermsForLinking,
  extractVaultKeyFromHit,
} from "./deep-research-text.js";
import { fcSearch, fcScrape } from "./deep-research-firecrawl.js";
import {
  deriveSubQueries,
  planQueries,
  planAngles,
  runCritic,
  reflectAndExtend,
  type ResearchAngle,
} from "./deep-research-planning.js";
import {
  classifySource,
  synthesize,
  validateReportStructure,
  formatLiveCitations,
  type Source,
} from "./deep-research-synthesis.js";

export { DEEP_RESEARCH_TOOLS } from "./deep-research-tools.js";

export type ProgressCallback = (message: string, totalSteps?: number) => void | Promise<void>;

export async function handleDeepResearch(
  name: string,
  args: unknown,
  onProgress?: ProgressCallback,
): Promise<ToolResult | null> {
  if (name !== "deep_research") return null;

  const parsed = InputSchema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
  }

  const { query, focus, continueFrom } = parsed.data;
  const clientQueries = parsed.data.queries ?? [];
  // Default to the evidence pack: it always works (no key) and lets the caller
  // do the synthesis it is better at. 'report' is the opt-in legacy path.
  const sourcesMode = (parsed.data.mode ?? "sources") === "sources";
  const depth = parsed.data.depth ?? "standard";
  const saveToVault = parsed.data.saveToVault ?? true;

  // Fresh mode: auto-detect from query unless explicitly set.
  const freshModeAuto = FRESH_TRIGGER_RE.test(query);
  const freshMode = parsed.data.freshMode ?? freshModeAuto;
  const freshDays = parsed.data.freshDays ?? 14;
  const freshConfig = freshMode ? { days: freshDays } : undefined;

  // Live Search resolution - opt-in only when Grok is the active provider.
  // Default: enable when Grok is active (smart default - they paid for the
  // feature, use it), disable otherwise (other providers ignore it anyway).
  const grokActive = isGrokActive();
  const liveSearchEnabled = (parsed.data.liveSearch ?? grokActive) && grokActive;
  const liveSearch: LiveSearchOptions | undefined = liveSearchEnabled
    ? {
        mode: "on",
        sources: (parsed.data.liveSearchSources as LiveSearchSource[] | undefined) ?? ["web", "x", "news"],
        maxResults: depth === "fast" ? 8 : depth === "deep" ? 18 : 12,
        fromDate: parsed.data.liveSearchDays
          ? new Date(Date.now() - parsed.data.liveSearchDays * 86_400_000).toISOString().slice(0, 10)
          : undefined,
      }
    : undefined;

  // No early FIRECRAWL_API_KEY gate - fcSearch/fcScrape transparently fall
  // through to the Finch backend proxy when the user is signed in but
  // has no local key. If both paths fail, the search loop returns an empty
  // source list and the synthesis stage produces the "insufficient signal"
  // skip report instead of a fake summary.

  // Depth knobs
  // Multi-agent mode (standard/deep): N angles × 2-3 queries each = effective
  // sub-query count. Fast mode keeps the original flat-planner behavior.
  const angleN      = depth === "deep" ? 5 : 3;
  const subN        = depth === "fast" ? 3 : depth === "deep" ? 7 : 5;
  const searchLimit = depth === "fast" ? 4 : depth === "deep" ? 6 : 5;
  const maxScrape   = depth === "fast" ? 10 : depth === "deep" ? 22 : 16;
  const maxSources  = depth === "fast" ? 10 : depth === "deep" ? 20 : 14;
  const useReflection = depth !== "fast";
  const useCritic     = depth === "deep";
  const useAngles     = depth !== "fast";

  const queryTerms = extractQueryTerms(query);
  const progress: string[] = [];
  // log() retains backwards-compat (collects messages for the final report
  // footer), and also emits MCP progress notifications when the client
  // opted in via _meta.progressToken (handled at the server.ts layer).
  // Estimated total steps for fast/standard/deep - used as `total` in the
  // notification so progress UIs can render a percentage.
  const totalSteps = depth === "deep" ? 9 : depth === "standard" ? 8 : 6;
  const log = (line: string) => {
    progress.push(line);
    if (onProgress) {
      // Fire-and-forget - never let progress emission slow the pipeline.
      Promise.resolve(onProgress(line.replace(/^[^\w]+/, "").trim(), totalSteps)).catch(() => {});
    }
  };

  if (liveSearch) {
    log(`🛰  Live Search: ON · sources=[${liveSearch.sources.join(", ")}] · max=${liveSearch.maxResults}${liveSearch.fromDate ? ` · since=${liveSearch.fromDate}` : ""}`);
  }

  if (freshMode) {
    log(`⏱ Fresh mode: ON · last ${freshDays} days · news-domain boost active${freshModeAuto && !parsed.data.freshMode ? " (auto-detected from query)" : ""}`);
  }

  // ── Stage 0: load prior report (continueFrom) ──
  let priorContext: { key: string; content: string } | undefined;
  if (continueFrom) {
    log(`📚 Loading prior report \`${continueFrom}\` to continue research thread...`);
    try {
      const prior = await callConvex(
        `/vault/entry?key=${encodeURIComponent(continueFrom)}`,
        "GET",
        undefined,
        "vault_read",
      ) as { content?: string; key?: string } | null;
      if (prior?.content && prior.content.length > 100) {
        priorContext = { key: prior.key ?? continueFrom, content: prior.content };
        log(`✅ Loaded prior report (${prior.content.length} chars) - planner & synth will build on it.`);
      } else {
        log(`⚠️ Prior report \`${continueFrom}\` not found or empty - proceeding as fresh research.`);
      }
    } catch (err: any) {
      log(`⚠️ Could not load prior report (${err.message ?? "error"}) - proceeding as fresh research.`);
    }
  }

  // ── Stage 1: plan ──
  // Multi-agent mode (standard/deep) decomposes into labeled angles. Each
  // angle has 2-3 sub-queries - flatten them for the search stage but keep
  // the angle structure for synthesis & critic prompts.
  let angles: ResearchAngle[] = [];
  let subQs: string[];
  if (clientQueries.length > 0) {
    // The client is itself a strong model and knows the user's intent — when it
    // supplies the angles we skip the planner entirely. No LLM call, no key,
    // and the user can actually steer what gets researched.
    subQs = clientQueries;
    log(`🧭 Using ${subQs.length} caller-supplied queries (no planner call).`);
  } else if (!hasDirectLLMKey() && !sourcesMode) {
    subQs = deriveSubQueries(query, subN, focus, freshConfig);
    log(`🧭 Derived ${subQs.length} sub-queries without a planner (no LLM key).`);
  } else if (sourcesMode) {
    // Evidence-pack mode must never require a key. Derive locally.
    subQs = deriveSubQueries(query, subN, focus, freshConfig);
    log(`🧭 Derived ${subQs.length} sub-queries. Pass \`queries\` to control the angles yourself.`);
  } else if (useAngles) {
    log(`🧭 Planning ${angleN} specialist angles${priorContext ? " (continuation mode)" : ""}${freshMode ? " (fresh mode)" : ""}...`);
    angles = await planAngles(query, angleN, focus, priorContext?.content, freshConfig);
    if (angles.length === 0) {
      // Planner returned nothing usable - fall back to flat sub-query mode
      log(`⚠️ Angle planner failed, falling back to flat sub-query planning.`);
      subQs = await planQueries(query, subN, focus, priorContext?.content, freshConfig);
    } else {
      const seen = new Set<string>();
      const flat: string[] = [];
      for (const a of angles) {
        for (const q of a.queries) {
          if (!seen.has(q.toLowerCase())) { seen.add(q.toLowerCase()); flat.push(q); }
        }
      }
      subQs = flat;
      log(`📐 Angles: ${angles.map((a) => `"${a.label}"`).join(" · ")} → ${subQs.length} unique queries.`);
    }
  } else {
    log(`🧭 Planning ${subN} sub-questions${priorContext ? " (continuation mode)" : ""}${freshMode ? " (fresh mode)" : ""}...`);
    subQs = await planQueries(query, subN, focus, priorContext?.content, freshConfig);
  }

  // ── Stage 2: parallel search ──
  log(`🔎 Searching ${subQs.length} queries × ${searchLimit} results each...`);
  const searchResults = await Promise.all(subQs.map((q) => fcSearch(q, searchLimit)));

  // Flatten with rank info
  const allCandidates: Array<{ url: string; title: string; desc: string; queryRank: number }> = [];
  for (const results of searchResults) {
    results.forEach((r, idx) => {
      if (r.url) allCandidates.push({ url: r.url, title: r.title ?? r.url, desc: r.description ?? "", queryRank: idx });
    });
  }

  if (allCandidates.length === 0) {
    return { content: [{ type: "text", text: `No sources found for: "${query}". Try a more specific query or a different focus angle.` }], isError: true };
  }

  const ranked = rankAndDedupe(allCandidates, freshMode).slice(0, maxScrape);
  log(`📊 Ranked ${allCandidates.length} candidates → ${ranked.length} after domain dedup (max ${MAX_PER_DOMAIN}/domain)${freshMode ? " + news-domain boost" : ""}.`);

  // ── Stage 3: parallel scrape ──
  log(`📥 Scraping ${ranked.length} sources in parallel...`);
  // Track why sources drop out. Silently returning fewer sources makes a thin
  // report look like a complete one — the user can't tell a well-supported
  // finding from one built on two pages that happened to load.
  let unreachable = 0;
  let tooThin = 0;
  const scraped = await Promise.all(
    ranked.map(async (c) => {
      const r = await fcScrape(c.url);
      if (!r) {
        unreachable++;
        return null;
      }
      const excerpt = pickBestExcerpt(r.markdown, queryTerms);
      if (excerpt.length < 150) {
        tooThin++;
        return null;
      }
      return {
        url: c.url,
        domain: domainOf(c.url),
        title: c.title,
        excerpt,
        publishedAt: r.publishedAt,
        score: tierBonus(c.url),
      };
    }),
  );

  let sources: Source[] = scraped
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .slice(0, maxSources)
    .map((s, i) => ({ n: i + 1, ...s, class: classifySource(s.score) }));

  const dropped = unreachable + tooThin;
  if (dropped > 0) {
    const parts: string[] = [];
    if (unreachable) parts.push(`${unreachable} unreachable/blocked`);
    if (tooThin) parts.push(`${tooThin} too thin to quote`);
    log(
      `⚠️  ${dropped} of ${ranked.length} sources dropped (${parts.join(", ")}) — ` +
        `report is based on ${sources.length}.`
    );
  }

  if (sources.length === 0) {
    return { content: [{ type: "text", text: `Could not scrape any usable sources for: "${query}". Sites may be blocking or paywalled.` }], isError: true };
  }

  // ── Evidence-pack mode: hand the sources back and stop ──
  // Everything below this point is the server writing prose. The caller is a
  // model with the user's full context; it synthesises better, it can be
  // steered mid-conversation, and it needs no API key to do it.
  if (sourcesMode) {
    // X / news via Grok Live Search — the one input the caller's model cannot
    // fetch for itself. Retrieved verbatim and appended as ordinary numbered
    // sources so the caller can weigh them (and discount anonymous accounts)
    // rather than receiving a pre-filtered opinion. Skipped silently with no key.
    let liveHits: Array<{ url: string; excerpt: string }> = [];
    const liveSources: LiveSearchSource[] = liveSearch?.sources ?? ["x", "news", "web"];
    if (liveSearch) {
      log(`📡 Grok Live Search (${liveSources.join(", ")}) for real-time X/news...`);
      liveHits = await grokLiveSearchHits(
        query,
        liveSources,
        parsed.data.liveSearchDays,
        depth === "fast" ? 6 : 10
      );
      log(liveHits.length ? `📡 ${liveHits.length} live item(s) retrieved.` : `📡 Live Search returned nothing usable.`);
    }

    log(`📦 Returning ${sources.length + liveHits.length} sources as an evidence pack.`);
    const pack: string[] = [
      `# Research evidence — "${query}"`,
      ``,
      `**${sources.length} sources** · queries run: ${subQs.length}${dropped > 0 ? ` · ${dropped} dropped` : ""}`,
      `_Synthesis is yours: cite with [N], and say if the evidence is thin or one-sided._`,
      ``,
      `**Queries searched:**`,
      ...subQs.map((q) => `- ${q}`),
      ``,
      `---`,
      ``,
    ];
    for (const s of sources) {
      pack.push(
        `### [${s.n}] ${s.title}`,
        `${s.url}`,
        `_${s.domain}${s.publishedAt ? ` · ${String(s.publishedAt).slice(0, 10)}` : ""} · ${s.class}_`,
        ``,
        s.excerpt,
        ``
      );
    }

    if (liveHits.length) {
      pack.push(
        `---`,
        ``,
        `## Real-time (${liveSources.join(" / ")}) — retrieved verbatim`,
        `_Unvetted social/news chatter. Weigh it yourself: check who is speaking, whether the claim is`,
        `corroborated by a numbered source above, and discount anonymous or promotional accounts._`,
        ``
      );
      liveHits.forEach((h, idx) => {
        pack.push(
          `### [L${idx + 1}] ${h.url || "(no url)"}`,
          ``,
          h.excerpt || "_(no excerpt returned)_`",
          ``
        );
      });
    }

    pack.push(`---`, ``);
    // Announce the capability rather than silently omitting it — a missing key
    // should look like an unconfigured option, not like the feature never existed.
    if (!liveSearch) {
      pack.push(
        `ℹ️ **No real-time X / news in this pack.** Web sources only. Set \`GROK_API_KEY\` to add ` +
          `live X and news items — it is optional, and everything above works without it.`,
        ``
      );
    }
    pack.push(
      `_Pass \`queries\` next time to control the angles. Use \`mode: "report"\` only if you want the server to write the prose (needs an LLM key)._`
    );
    return { content: [{ type: "text", text: pack.join("\n") }] };
  }

  // ── Stage 4: draft synthesis (only if reflection enabled) ──
  let draft = "";
  if (useReflection) {
    log(`✍️  Drafting initial report (will reflect & refine)...`);
    try {
      const draftResult = await synthesize(query, sources, false, liveSearch);
      draft = draftResult.report;
    } catch {
      // If draft fails, fall through to final synth with what we have
      draft = "";
    }
  }

  // ── Stage 5: reflection - find gaps, search again ──
  if (useReflection && draft) {
    log(`🤔 Auditing draft for gaps...`);
    const gapQs = await reflectAndExtend(query, draft, subQs, depth === "deep" ? 3 : 2);
    if (gapQs.length > 0) {
      log(`🔁 Running ${gapQs.length} gap-search(es)...`);
      const gapResults = await Promise.all(gapQs.map((q) => fcSearch(q, 3)));
      const gapCandidates: Array<{ url: string; title: string; desc: string; queryRank: number }> = [];
      const existingUrls = new Set(sources.map((s) => s.url));
      for (const results of gapResults) {
        results.forEach((r, idx) => {
          if (r.url && !existingUrls.has(r.url)) {
            gapCandidates.push({ url: r.url, title: r.title ?? r.url, desc: r.description ?? "", queryRank: idx });
          }
        });
      }
      const gapRanked = rankAndDedupe(gapCandidates, freshMode).slice(0, gapQs.length * 2);
      const gapScraped = await Promise.all(
        gapRanked.map(async (c) => {
          const r = await fcScrape(c.url);
          if (!r || r.markdown.length < 200) return null;
          return {
            url: c.url,
            domain: domainOf(c.url),
            title: c.title,
            excerpt: pickBestExcerpt(r.markdown, queryTerms),
            publishedAt: r.publishedAt,
            score: tierBonus(c.url),
          };
        }),
      );
      const newSources = gapScraped.filter((s): s is NonNullable<typeof s> => s !== null);
      const startN = sources.length;
      const appended = newSources.map((s, i) => ({ n: startN + i + 1, ...s, class: classifySource(s.score) }));
      sources = [...sources, ...appended].slice(0, maxSources + 4);
      log(`✅ Added ${appended.length} gap-fill source(s).`);
    } else {
      log(`✅ No gaps found - draft is complete.`);
    }
  }

  // ── Stage 5b: critic (deep mode only) ──
  // Adversarial pass over the draft. Critic notes get prepended to the
  // final synthesizer's prompt so the model addresses concrete weaknesses.
  let criticNotes = "";
  if (useCritic && draft) {
    log(`⚖️ Critic audit - challenging draft for single-source claims & contradictions...`);
    criticNotes = await runCritic(query, draft, angles, sources.length);
    if (criticNotes) {
      // Tolerant verdict extraction - the critic LLM doesn't always honor
      // the "Net recommendation: X" sentinel exactly. Look for any of the
      // three verdict tokens near the end of the notes.
      const tail = criticNotes.slice(-400).toLowerCase();
      let verdict = "delivered";
      if (/\brevise|\brewrite|\bweak|\bfix/i.test(tail)) verdict = "revise";
      if (/\breject|\binsufficient|\bcannot/i.test(tail)) verdict = "reject";
      if (/\baccept|\bsolid|\bsound|\bgood|\bcorrect/i.test(tail)) verdict = "accept";
      log(`✅ Critic ${verdict} (${criticNotes.length} chars of notes).`);
    } else {
      log(`⚠️ Critic returned no notes (LLM error or empty response).`);
    }
  }

  // ── Stage 6: final synthesis ──
  log(`📝 Writing final report from ${sources.length} sources${angles.length > 0 ? ` across ${angles.length} angle(s)` : ""}${criticNotes ? " (critic-audited)" : ""}${liveSearch ? " + Live Search" : ""}${priorContext ? ` (continuing \`${priorContext.key}\`)` : ""}${freshMode ? " (fresh)" : ""}...`);
  let report: string;
  let liveCitations: string[] = [];
  try {
    const finalResult = await synthesize(query, sources, true, liveSearch, priorContext, freshMode, angles, criticNotes);
    report = finalResult.report;
    liveCitations = finalResult.liveCitations;
  } catch (err: any) {
    return { content: [{ type: "text", text: `Synthesis failed: ${err.message ?? err}` }], isError: true };
  }

  // ── Stage 6b: structural output validation ──
  // Verify the report contains the required sections + adequate citation
  // density. If 2+ checks fail, retry synthesis once with stricter prompt.
  const issues = validateReportStructure(report);
  if (issues.length >= 2) {
    log(`🔧 Output validation found ${issues.length} issues (${issues.join(", ")}). Retrying synthesis with stricter prompt...`);
    try {
      const retryResult = await synthesize(query, sources, true, liveSearch, priorContext, freshMode, angles, criticNotes);
      const retryIssues = validateReportStructure(retryResult.report);
      if (retryIssues.length < issues.length) {
        report = retryResult.report;
        if (retryResult.liveCitations.length > 0) liveCitations = retryResult.liveCitations;
        log(`✅ Retry improved - ${retryIssues.length} issues remaining.`);
      } else {
        log(`⚠️ Retry didn't improve - keeping original.`);
      }
    } catch {
      log(`⚠️ Retry failed - keeping original output.`);
    }
  } else if (issues.length > 0) {
    log(`⚠️ Output has minor issues: ${issues.join(", ")}.`);
  } else {
    log(`✅ Output structure validated.`);
  }

  // Append sources list with snippets
  const sourcesSection = sources
    .map((s) => {
      const date = s.publishedAt ? ` (${s.publishedAt.slice(0, 10)})` : "";
      const cls = s.class !== "unclassified" ? ` · ${s.class}` : "";
      return `[${s.n}] **${s.title}** - ${s.domain}${date}${cls}\n   ${s.url}`;
    })
    .join("\n\n");

  // Group live citations by source type for readability
  const liveSection = liveCitations.length > 0
    ? `\n\n### 🛰 Real-time sources (Live Search)\n\n${formatLiveCitations(liveCitations)}`
    : "";

  const fullReport = `${report.trim()}\n\n## Sources\n\n${sourcesSection}${liveSection}`;

  // ── Stage 6.5: signal gate ──
  // If the synthesis is thin (LLM admitted "search returned directory pages"
  // or content has no concrete data), return an honest "insufficient signal"
  // result instead of saving and citing a fake summary. The user can rerun
  // with a sharper query.
  const signal = checkSignal(report);
  if (!signal.ok) {
    const skipMsg = [
      `## ⚠️ Insufficient signal`,
      ``,
      `**Query:** ${query}`,
      `**Reason:** ${signal.reason}`,
      `**Signal score:** ${signal.score.toFixed(2)} / 1.00`,
      ``,
      `The search results were too thin to produce a substantive report. Try a narrower or more recent query, or scope to a specific domain.`,
      ``,
      `<details><summary>Raw synthesis (saved for audit, not vault)</summary>`,
      ``,
      "```",
      report.slice(0, 1500),
      "```",
      ``,
      `</details>`,
    ].join("\n");
    return { content: [{ type: "text", text: skipMsg }] };
  }

  // ── Stage 7: vault save ──
  let vaultKey: string | null = null;
  if (saveToVault) {
    try {
      const r = (await callConvex("/vault/save", "POST", {
        type: "research",
        title: priorContext
          ? `Deep Research (cont.): ${query.slice(0, 80)}`
          : `Deep Research: ${query.slice(0, 80)}`,
        content: fullReport,
        tags: [
          "deep-research",
          depth,
          ...(focus ? [focus] : []),
          ...(priorContext ? ["continuation"] : []),
        ],
        agentId: "research",
        commitMsg: priorContext ? `deep_research continues ${priorContext.key}` : "deep_research run",
      }, "vault_save")) as { key?: string } | null;
      vaultKey = r?.key ?? null;
    } catch { /* keep going - return report inline */ }
  }

  // ── Stage 7b: link as continuation when continueFrom was used ──
  if (vaultKey && priorContext) {
    try {
      await callConvex("/vault/link", "POST", {
        fromKey: vaultKey,
        toKey: priorContext.key,
        relation: "continues",
      }, "vault_link");
      log(`🧬 Linked new report as \`continues\` → \`${priorContext.key}\`.`);
    } catch {
      log(`⚠️ Could not create continuation link.`);
    }
  }

  // ── Stage 8: vault auto-linking - connect this report to related research ──
  // This is what makes Finch deep_research compound over time. Every new
  // report finds related past reports in your vault and creates typed links,
  // so your knowledge base grows into a connected graph (vault_related to
  // explore it). Best-effort - failure here never blocks the report.
  const linkedKeys: string[] = [];
  if (vaultKey && saveToVault) {
    try {
      const searchTerms = buildSearchTermsForLinking(query);
      log(`🔗 Searching vault for related research (terms: ${searchTerms.slice(0, 60)}...)`);
      const searchResult = (await callConvex("/vault/search", "POST", {
        q: searchTerms,
        n: 8,
      }, "vault_search")) as { results?: Array<{ id?: string; metadata?: { title?: string }; content?: string }> } | null;

      const hits = (searchResult?.results ?? [])
        .map((r) => ({
          // The /vault/search endpoint returns documents from the semantic
          // memory layer, not vault keys directly. We need to extract vault
          // keys from the metadata when present.
          key: extractVaultKeyFromHit(r),
          title: r.metadata?.title ?? "(untitled)",
        }))
        .filter((h): h is { key: string; title: string } => !!h.key && h.key !== vaultKey)
        .slice(0, 3);

      if (hits.length > 0) {
        for (const hit of hits) {
          try {
            await callConvex("/vault/link", "POST", {
              fromKey: vaultKey,
              toKey: hit.key,
              relation: "related",
            }, "vault_link");
            linkedKeys.push(hit.key);
          } catch { /* skip individual link failures */ }
        }
        log(`✅ Linked to ${linkedKeys.length} related vault entr${linkedKeys.length === 1 ? "y" : "ies"}.`);
      } else {
        log(`✅ No related vault entries found - this is a fresh research thread.`);
      }
    } catch {
      // Vault auto-linking is purely additive - silent failure is fine
      log(`⚠️ Vault auto-link skipped (search unavailable).`);
    }
  }

  const linkedSection = linkedKeys.length > 0
    ? `🔗 Auto-linked to ${linkedKeys.length} related research entr${linkedKeys.length === 1 ? "y" : "ies"} in your vault:\n${linkedKeys.map((k) => `   • \`${k}\``).join("\n")}`
    : "";

  const continuationSection = priorContext
    ? `🧬 **Continuation** of \`${priorContext.key}\` - linked as relation:continues`
    : "";

  const header = [
    `🔬 **Deep Research v3** - depth: ${depth} · ${subQs.length} planned + ${useReflection ? "reflection" : "no reflection"} · ${sources.length} scraped sources${liveCitations.length > 0 ? ` · ${liveCitations.length} live` : ""}${liveSearch ? ` · 🛰 Live Search [${liveSearch.sources.join(",")}]` : ""}${freshMode ? ` · ⏱ fresh:${freshDays}d` : ""}`,
    vaultKey ? `📁 Saved to vault: \`${vaultKey}\`` : (saveToVault ? `⚠️ Vault save skipped (not authenticated - sign in with \`finch login\`)` : ""),
    continuationSection,
    linkedSection,
    ``,
    `<details><summary>📋 Process log</summary>`,
    ``,
    progress.map((p) => `- ${p}`).join("\n"),
    ``,
    `</details>`,
    ``,
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: `${header}\n${fullReport}` }] };
}
