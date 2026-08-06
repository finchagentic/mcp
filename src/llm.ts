const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const BANKR_URL = "https://llm.bankr.bot/v1/chat/completions";
const GROK_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type LiveSearchSource = "web" | "x" | "news" | "rss";

export interface LiveSearchOptions {
  mode: "auto" | "on";
  sources: LiveSearchSource[];
  maxResults?: number;
  fromDate?: string;  // ISO YYYY-MM-DD
  toDate?: string;    // ISO YYYY-MM-DD
}

export interface LLMOptions {
  /**
   * Provider-specific real-time search. Currently only applied when Grok is
   * the active provider (`provider="grok"` or auto-selected Grok).
   * For other providers this is silently ignored - the call proceeds normally.
   */
  liveSearch?: LiveSearchOptions;
  /**
   * Per-call model override. When set, takes precedence over FINCH_MODEL
   * and provider defaults. Useful when one tool (e.g. deep_research) wants a
   * Grok model via Bankr for real-time search while the rest of the stack
   * stays on Claude. Pass a Bankr-supported name like `grok-4.3` or
   * `claude-sonnet-4-6`.
   */
  model?: string;
}

/**
 * Returns true if Grok is the currently active LLM provider, based on env.
 * Useful for tools that want to conditionally enable Grok-specific features
 * like Live Search.
 */
/**
 * True if any BYOK provider key (Bankr/Anthropic/OpenAI/Grok) is set. Callers
 * that must never fall through to callViaConvex() - e.g. local-memory mode,
 * which promises zero Convex involvement - should check this first and fail
 * clearly instead of letting callLLM() silently proxy through Finch.
 */
export function hasDirectLLMKey(): boolean {
  return !!(process.env.BANKR_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GROK_API_KEY);
}

/**
 * Grok Live Search used purely as a RETRIEVAL layer.
 *
 * X/news content is the one thing an MCP client genuinely cannot reach on its
 * own, which makes fetching it real tool work. Interpreting it is not — so this
 * asks Grok to return the found items verbatim and hands them upward as sources.
 * The caller's model decides what any of it means.
 *
 * Returns [] on any failure: live search is an augmentation, never a hard
 * dependency, and research must still work without a Grok key.
 */
export async function grokLiveSearchHits(
  query: string,
  sources: LiveSearchSource[] = ["x", "news", "web"],
  days?: number,
  maxResults = 10,
): Promise<Array<{ url: string; excerpt: string }>> {
  const apiKey = process.env.GROK_API_KEY;
  if (!apiKey) return [];

  const body: Record<string, unknown> = {
    model: process.env.FINCH_GROK_MODEL ?? "grok-4.3",
    max_tokens: 2000,
    messages: [
      {
        role: "system",
        content:
          "You are a retrieval tool, not an analyst. Return what you find verbatim. " +
          "Never summarise, interpret, rank by opinion, or add commentary.",
      },
      {
        role: "user",
        content:
          `Search for: ${query}\n\n` +
          `Return up to ${maxResults} of the most relevant recent items, one per line, ` +
          `in exactly this format:\n\n` +
          `URL :: verbatim quote or post text (max 400 chars)\n\n` +
          `Rules: quote the source's own words. Do not paraphrase. Do not add analysis, ` +
          `conclusions, or your own framing. If an item has no URL, use "-" for the URL.`,
      },
    ],
    search_parameters: {
      mode: "on",
      sources: sources.map((type) => ({ type })),
      max_search_results: maxResults,
      ...(days ? { from_date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) } : {}),
    },
  };

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      citations?: string[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";

    const hits: Array<{ url: string; excerpt: string }> = [];
    for (const line of content.split("\n")) {
      const idx = line.indexOf("::");
      if (idx === -1) continue;
      const url = line.slice(0, idx).trim().replace(/^[-*\d.\s]+/, "");
      const excerpt = line.slice(idx + 2).trim();
      if (excerpt.length < 20) continue;
      hits.push({ url: /^https?:\/\//.test(url) ? url : "", excerpt });
    }

    // If the model ignored the format, fall back to bare citations so the
    // caller still receives the URLs rather than nothing.
    if (hits.length === 0 && data.citations?.length) {
      return data.citations.slice(0, maxResults).map((url) => ({ url, excerpt: "" }));
    }
    return hits.slice(0, maxResults);
  } catch {
    return [];
  }
}

export function isGrokActive(): boolean {
  const provider = process.env.FINCH_PROVIDER?.toLowerCase().trim();
  if (provider === "grok") return !!process.env.GROK_API_KEY;
  if (provider === "bankr" || provider === "anthropic" || provider === "openai") return false;
  // Auto-priority - Grok is only active if it's the only key present
  if (process.env.BANKR_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) return false;
  return !!process.env.GROK_API_KEY;
}

/**
 * Call the best available LLM.
 *
 * Provider auto-priority (when FINCH_PROVIDER unset):
 *   BANKR_API_KEY → ANTHROPIC_API_KEY → OPENAI_API_KEY → GROK_API_KEY → Convex backend
 *
 * Force a provider via FINCH_PROVIDER: "bankr" | "anthropic" | "openai" | "grok"
 *
 * Model selection (first wins):
 *   FINCH_MODEL → {provider}_MODEL → provider default
 */
export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1024,
  history: ChatMessage[] = [],
  timeoutMs = 60_000,
  options: LLMOptions = {},
): Promise<string> {
  const provider     = process.env.FINCH_PROVIDER?.toLowerCase().trim();
  const bankrKey     = process.env.BANKR_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  const grokKey      = process.env.GROK_API_KEY;

  // Explicit provider override - user picked one
  if (provider === "grok" && grokKey)           return callGrok(grokKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.liveSearch, options.model);
  if (provider === "anthropic" && anthropicKey) return callAnthropic(anthropicKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.model);
  if (provider === "openai" && openaiKey)       return callOpenAI(openaiKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.model);
  if (provider === "bankr" && bankrKey)         return callBankr(bankrKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.model);

  // Auto priority
  if (bankrKey)     return callBankr(bankrKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.model);
  if (anthropicKey) return callAnthropic(anthropicKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.model);
  if (openaiKey)    return callOpenAI(openaiKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.model);
  if (grokKey)      return callGrok(grokKey, systemPrompt, userPrompt, maxTokens, history, timeoutMs, options.liveSearch, options.model);

  // No provider key configured - BYOK is required. This tool needs its own
  // multi-step reasoning (planning, synthesis, critique) that an MCP host's
  // model cannot do on the tool's behalf, so there is no free path: bring
  // your own key or don't use tools that need one (ask_finch, deep_research,
  // market_thesis, trade_plan, scheduled agent runs). Fails clearly instead
  // of silently billing the Finch deployment owner for every anonymous
  // install of this package.
  throw new Error(
    "No LLM provider configured. This tool needs its own key to do multi-step " +
    "reasoning server-side - set one of BANKR_API_KEY, ANTHROPIC_API_KEY, " +
    "OPENAI_API_KEY, or GROK_API_KEY as an environment variable (see the " +
    "Configuration section of the README), then retry. Most other Finch tools " +
    "don't need this - only ones that do their own internal LLM reasoning do."
  );
}

async function callAnthropic(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  history: ChatMessage[],
  timeoutMs: number,
  modelOverride?: string,
): Promise<string> {
  const messages: ChatMessage[] = [...history, { role: "user", content: userPrompt }];
  const model = modelOverride ?? process.env.FINCH_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find(b => b.type === "text")?.text ?? "";
}

async function callBankr(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  history: ChatMessage[],
  timeoutMs: number,
  modelOverride?: string,
): Promise<string> {
  const model = modelOverride ?? process.env.FINCH_MODEL ?? process.env.BANKR_MODEL ?? "claude-haiku-4-5-20251001";

  const res = await fetch(BANKR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bankr error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

// OPENAI_BASE_URL lets this point at any OpenAI Chat Completions-compatible
// endpoint instead of api.openai.com - self-hosted gateways (LiteLLM, vLLM,
// Ollama, LocalAI) and aggregators (OpenRouter) all speak this same API
// shape, so no separate provider code is needed for them.
function openAiChatUrl(): string {
  const base = process.env.OPENAI_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}/chat/completions` : OPENAI_URL;
}

async function callOpenAI(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  history: ChatMessage[],
  timeoutMs: number,
  modelOverride?: string,
): Promise<string> {
  const model = modelOverride ?? process.env.FINCH_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const res = await fetch(openAiChatUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    data?: { choices?: Array<{ message?: { content?: string } }> };
  };
  // Most OpenAI-compatible gateways put `choices` at the top level, but
  // OPENAI_BASE_URL can point at anything that speaks this API shape - at
  // least one (9Router) wraps the whole payload in `{ data: {...}, success:
  // true }` for some models (confirmed live: routers9/glm5.2 returns this
  // wrapper while routers9/tencent/hy3 on the SAME endpoint/key returns
  // top-level choices). Without this fallback the call silently returns ""
  // instead of throwing - worse than an error, since every caller of
  // callLLM() just gets an empty synthesis with no indication anything failed.
  const content = data.choices?.[0]?.message?.content ?? data.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenAI-compatible endpoint returned no content (model: ${model})`);
  return content;
}

async function callGrok(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  history: ChatMessage[],
  timeoutMs: number,
  liveSearch?: LiveSearchOptions,
  modelOverride?: string,
): Promise<string> {
  const model = modelOverride ?? process.env.FINCH_MODEL ?? process.env.GROK_MODEL ?? "grok-4-fast-reasoning";

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
    stream: false,
  };

  // xAI Live Search - pulls real-time results from web/X/news/RSS during inference.
  // Docs: https://docs.x.ai/docs/guides/live-search
  // Note: as of late 2026 xAI deprecated this in favor of Agent Tools API
  // (returns 410 Gone). We detect that and retry without search_parameters
  // so synthesis still succeeds - just without the real-time augmentation.
  if (liveSearch) {
    body.search_parameters = {
      mode: liveSearch.mode,
      sources: liveSearch.sources.map((type) => ({ type })),
      max_search_results: liveSearch.maxResults ?? 10,
      ...(liveSearch.fromDate ? { from_date: liveSearch.fromDate } : {}),
      ...(liveSearch.toDate ? { to_date: liveSearch.toDate } : {}),
    };
  }

  let res = await fetch(GROK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Live Search deprecated → strip search_parameters and retry
  if (res.status === 410 && liveSearch) {
    delete (body as Record<string, unknown>).search_parameters;
    res = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Grok error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };

  const content = data.choices?.[0]?.message?.content ?? "";

  // When Live Search ran (and was not deprecated), append the citations as a
  // parsable block at the bottom - downstream consumers (deep_research) can
  // read these and merge into the final source list.
  if (liveSearch && data.citations && data.citations.length > 0) {
    return `${content}\n\n<!--GROK_LIVE_CITATIONS\n${data.citations.join("\n")}\nGROK_LIVE_CITATIONS-->`;
  }

  return content;
}
