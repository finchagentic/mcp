import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callConvex } from "../convex.js";
import { callLLM, hasDirectLLMKey } from "../llm.js";
import { ToolResult } from "../types.js";
import { searchSupermemory, syncToSupermemory } from "./memory.js";
import { enrichQuery, todayContext } from "../enrichment-router.js";
import { checkSignal } from "../signal-gate.js";
import { parseOrError } from "../_zod-helpers.js";

export const INSIGHT_TOOLS: Tool[] = [
  {
    name: "ask_finch",
    description: "Ask Finch anything - analysis, opinions, explanations, strategy, or ideas. Finch loads your saved memory to personalize every answer. Use for: research questions, content ideas, code explanations, decision-making, DeFi analysis, trade ideas, or just thinking out loud. Pass previous messages to continue a conversation across tool calls. If YOU are already a reasoning model (Claude, GPT, etc. calling this via MCP) and other tools already gave you the data you need, just answer directly instead of calling this - it runs a separate LLM call and won't tell you anything you can't already work out yourself from that data.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Your question or request for Finch" },
        messages: {
          type: "array",
          description: "Previous conversation messages for context (optional)",
          items: {
            type: "object",
            properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } },
            required: ["role", "content"],
          },
        },
      },
      required: ["question"],
    },
  },
  {
    name: "market_thesis",
    description:
      "Fetch a cross-checked live price for any token (CoinGecko + DexScreener + Pyth, with a source-spread " +
      "warning when they disagree) and return it with the bull/bear/verdict structure for YOU to write. " +
      "Refuses outright when no source can verify the price. Use before opening a position or when " +
      "researching a token you're watching. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        token:   { type: "string", description: "Token symbol or CoinGecko ID, e.g. 'ETH', 'bitcoin', 'AERO'" },
        context: { type: "string", description: "Optional: extra context - your time horizon, thesis seed, or specific concerns" },
      },
      required: ["token"],
    },
  },
  {
    name: "trade_plan",
    description:
      "Return the verified inputs for a trade plan on any token: cross-checked live price, a table of " +
      "stop-loss and take-profit price levels computed off spot (signed for long or short), and position " +
      "sizing math for the given risk tolerance and portfolio size. YOU pick the entry, stop and targets " +
      "from those levels and write the plan. Refuses when no source can verify the price. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        token:          { type: "string", description: "Token symbol or CoinGecko ID" },
        side:           { type: "string", enum: ["long", "short"], description: "Trade direction (default: long)" },
        portfolioSize:  { type: "number", description: "Optional: your portfolio size in USD (for position sizing)" },
        riskTolerance:  { type: "string", enum: ["conservative", "moderate", "aggressive"], description: "Risk profile (default: moderate)" },
        timeframe:      { type: "string", description: "Optional: trade timeframe, e.g. 'intraday', 'swing', 'weeks'" },
      },
      required: ["token"],
    },
  },
];

const AskFinchSchema = z.object({
  question: z.string().min(1),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
});

const MarketThesisSchema = z.object({
  token:   z.string().min(1),
  context: z.string().optional(),
});

const TradePlanSchema = z.object({
  token:         z.string().min(1),
  side:          z.enum(["long", "short"]).optional(),
  portfolioSize: z.number().positive().optional(),
  riskTolerance: z.enum(["conservative", "moderate", "aggressive"]).optional(),
  timeframe:     z.string().optional(),
});

const FINCH_BASE_PROMPT = `You are Finch, the core intelligence of the Finch runtime - the persistent state layer for AI assistants. You are direct, sharp, and thorough. You have access to memory that accumulates, vaults that version knowledge, agents that keep running between sessions, workflows that execute on schedule, plus execution domains: web research, market intelligence, code, and DeFi on Base. When asked anything, give your honest read backed by real reasoning. No filler, no disclaimers.

When the user's vault or memory contains relevant prior research, build on it explicitly rather than starting from scratch. Reference vault entries by title when you cite them.`;

type VaultHit = { key?: string; title?: string; type?: string; preview?: string };

interface ContextMeta {
  hasProfile: boolean;
  memories: Array<{ title?: string; snippet: string }>;
  vault: Array<{ title: string; type?: string; preview: string }>;
}

async function searchVault(question: string, limit = 3): Promise<VaultHit[]> {
  try {
    const data = await callConvex("/vault/search", "POST", { query: question, limit }, "vault_search");
    const entries = (data as any)?.entries ?? (data as any)?.results ?? [];
    return Array.isArray(entries) ? entries.slice(0, limit) : [];
  } catch {
    return [];
  }
}

async function fetchProfileContext(): Promise<string> {
  try {
    const data = await callConvex(
      "/vault/profile-context?maxChars=3000",
      "GET", undefined, "vault_read",
    ) as { context?: string };
    return (data?.context ?? "").trim();
  } catch {
    return "";
  }
}

async function buildSystemPrompt(question: string): Promise<{ prompt: string; meta: ContextMeta }> {
  // Run profile fetch + memory + vault searches in parallel - each fails
  // gracefully so a slow or down one doesn't block the others.
  const [profileContext, memories, vaultHits] = await Promise.all([
    fetchProfileContext(),
    searchSupermemory(question, 5),
    searchVault(question, 3),
  ]);

  const blocks: string[] = [];
  const meta: ContextMeta = { hasProfile: false, memories: [], vault: [] };

  if (profileContext) {
    meta.hasProfile = true;
    blocks.push(`<user_profile>\n${profileContext}\n</user_profile>`);
  }

  if (memories.length) {
    const memBlock = memories
      .map(r => {
        const title = r.metadata?.title ? `[${r.metadata.title}] ` : "";
        const snippet = r.content.slice(0, 250).replace(/\n/g, " ");
        meta.memories.push({ title: r.metadata?.title, snippet: r.content.slice(0, 100).replace(/\n/g, " ") });
        return `- ${title}${snippet}`;
      })
      .join("\n");
    blocks.push(`<user_memory>\nStored knowledge about this user - use it to personalize your response:\n${memBlock}\n</user_memory>`);
  }

  if (vaultHits.length) {
    const vaultBlock = vaultHits
      .map(v => {
        const typeTag = v.type ? `(${v.type}) ` : "";
        const title = v.title ?? v.key ?? "untitled";
        const preview = (v.preview ?? "").slice(0, 300).replace(/\n/g, " ");
        meta.vault.push({ title, type: v.type, preview: (v.preview ?? "").slice(0, 80).replace(/\n/g, " ") });
        return `- ${typeTag}**${title}**${preview ? ` - ${preview}` : ""}`;
      })
      .join("\n");
    blocks.push(`<user_vault>\nThe user already has these prior artifacts on closely related topics - build on them, don't repeat them:\n${vaultBlock}\n</user_vault>`);
  }

  const prompt = blocks.length === 0
    ? FINCH_BASE_PROMPT
    : `${FINCH_BASE_PROMPT}\n\n${blocks.join("\n\n")}`;

  return { prompt, meta };
}

function formatContextHeader(meta: ContextMeta): string {
  const total = meta.memories.length + meta.vault.length + (meta.hasProfile ? 1 : 0);
  if (total === 0) return "";

  const parts: string[] = [];
  if (meta.hasProfile) parts.push("profile");
  if (meta.memories.length) parts.push(`${meta.memories.length} memor${meta.memories.length === 1 ? "y" : "ies"}`);
  if (meta.vault.length) parts.push(`${meta.vault.length} vault entr${meta.vault.length === 1 ? "y" : "ies"}`);

  const lines: string[] = [];

  if (meta.memories.length > 0) {
    lines.push("**Memory:**");
    for (const m of meta.memories) {
      const label = m.title ? `[${m.title}] ` : "";
      lines.push(`- ${label}${m.snippet}${m.snippet.length >= 100 ? "…" : ""}`);
    }
  }
  if (meta.vault.length > 0) {
    if (lines.length) lines.push("");
    lines.push("**Vault:**");
    for (const v of meta.vault) {
      const typeTag = v.type ? `(${v.type}) ` : "";
      lines.push(`- ${typeTag}**${v.title}**${v.preview ? ` — ${v.preview}${v.preview.length >= 80 ? "…" : ""}` : ""}`);
    }
  }

  return [
    `<details><summary>🧠 Context loaded: ${parts.join(" · ")}</summary>`,
    ``,
    ...lines,
    ``,
    `</details>`,
    ``,
  ].join("\n");
}

type PriceQuote = {
  price: number;
  change24h: number;
  mcap: number;
  symbol: string;
  source: "coingecko" | "dexscreener" | "pyth";
};

// CoinGecko's /markets endpoint filters by coin *id*, not symbol - `ids=eth`
// returns [] while `ids=ethereum` returns Ethereum. Callers pass symbols far
// more often than ids (the tool descriptions invite it), so a bare id lookup
// silently missed on nearly every real call and the caller fell through to a
// DexScreener symbol search, which happily matched a junk pair with the same
// ticker. /search resolves symbol → id; it is only hit when the direct lookup
// misses, so the common case stays at one request.
async function resolveCgId(token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as { coins?: Array<{ id?: string; symbol?: string; market_cap_rank?: number | null }> };
    const coins = data.coins ?? [];
    if (!coins.length) return null;

    // Prefer an exact symbol match, highest market-cap rank first - that's the
    // real asset rather than one of the dozens of copycats sharing its ticker.
    const sym = token.toLowerCase();
    const ranked = (c: { market_cap_rank?: number | null }) => c.market_cap_rank ?? Number.MAX_SAFE_INTEGER;
    const exact = coins.filter((c) => c.symbol?.toLowerCase() === sym).sort((a, b) => ranked(a) - ranked(b));
    return (exact[0] ?? coins[0])?.id ?? null;
  } catch {
    return null;
  }
}

async function fetchCgMarkets(id: string, token: string): Promise<PriceQuote | null> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&order=market_cap_desc&per_page=1&page=1`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return null;
  const data = await res.json() as any[];
  const coin = data[0];
  if (!coin) return null;
  return {
    price:     coin.current_price ?? 0,
    change24h: coin.price_change_percentage_24h ?? 0,
    mcap:      coin.market_cap ?? 0,
    symbol:    coin.symbol?.toUpperCase() ?? token.toUpperCase(),
    source:    "coingecko",
  };
}

async function fetchCgPrice(token: string): Promise<PriceQuote | null> {
  try {
    const direct = await fetchCgMarkets(token.toLowerCase().replace(/ /g, "-"), token);
    if (direct) return direct;
    const id = await resolveCgId(token);
    return id ? await fetchCgMarkets(id, token) : null;
  } catch {
    return null;
  }
}

// DexScreener fallback when CoinGecko fails or doesn't have the token.
// Picks the highest-liquidity pair whose baseToken.symbol matches the query.
async function fetchDexscreenerPrice(token: string): Promise<PriceQuote | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) return null;

    const targetSym = token.toLowerCase();
    const matches = pairs.filter((p) =>
      typeof p.baseToken?.symbol === "string" &&
      p.baseToken.symbol.toLowerCase() === targetSym
    );
    const pool = (matches.length ? matches : pairs)
      .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    if (!pool) return null;

    const price = parseFloat(pool.priceUsd ?? "0");
    if (!isFinite(price) || price <= 0) return null;

    return {
      price,
      change24h: pool.priceChange?.h24 ?? 0,
      mcap:      pool.fdv ?? pool.marketCap ?? 0,
      symbol:    pool.baseToken?.symbol?.toUpperCase() ?? token.toUpperCase(),
      source:    "dexscreener",
    };
  } catch {
    return null;
  }
}

// Pyth Network price feed - institutional-grade oracle used by 50+ chains.
// Free HTTPS endpoint, no auth. Adds a 3rd source so single-API rate limits
// or outages don't break thesis/trade-plan generation. Pyth IDs are stable
// (https://pyth.network/developers/price-feed-ids).
const PYTH_FEED_IDS: Record<string, string> = {
  BTC:  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH:  "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL:  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  USDC: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  MATIC:"5de33a9112c2b700b8d30b8a3402c103578ccfa2765696471cc672bd5cf6ac52",
  AVAX: "93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
  LINK: "8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  BNB:  "2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
};

async function fetchPythPrice(token: string): Promise<PriceQuote | null> {
  try {
    const sym = token.toUpperCase();
    const id = PYTH_FEED_IDS[sym];
    if (!id) return null; // not all tokens are on Pyth
    const url = `https://hermes.pyth.network/api/latest_price_feeds?ids[]=${id}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json() as any[];
    const feed = data[0];
    if (!feed?.price) return null;
    // Pyth returns price scaled by 10^expo (e.g. price=4500_00000000, expo=-8).
    const raw = parseInt(feed.price.price, 10);
    const expo = feed.price.expo as number;
    const price = raw * Math.pow(10, expo);
    if (!isFinite(price) || price <= 0) return null;
    return {
      price,
      change24h: 0, // Pyth doesn't expose 24h change directly
      mcap: 0,
      symbol: sym,
      source: "pyth" as any,
    };
  } catch {
    return null;
  }
}

// Multi-source price quote: CoinGecko first, DexScreener fallback, Pyth third.
// Returns null only when ALL three sources fail. Also detects disagreement
// across sources > 5% - flagged for the caller via `inconsistent` flag,
// which downstream tools (market_thesis, trade_plan) surface to the user.
async function fetchVerifiedPrice(
  token: string,
): Promise<(PriceQuote & { inconsistent?: { sources: string[]; spreadPct: number; quotes: PriceQuote[] } }) | null> {
  // Fetch in parallel so latency = slowest of the three, not sum.
  const [cg, dex, pyth] = await Promise.all([
    fetchCgPrice(token),
    fetchDexscreenerPrice(token),
    fetchPythPrice(token),
  ]);

  const candidates = [cg, dex, pyth].filter((p): p is PriceQuote => !!p && p.price > 0);
  if (candidates.length === 0) return null;

  // Spread check across all valid sources
  const prices = candidates.map((c) => c.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spreadPct = min > 0 ? ((max - min) / min) * 100 : 0;

  // Primary: CoinGecko (id-resolved, has mcap + 24h), else Pyth, else
  // DexScreener. Pyth outranks DexScreener because it is keyed by a fixed feed
  // ID - it cannot resolve to the wrong asset, whereas the DexScreener path is
  // a ticker search and any copycat pair with enough liquidity can win it.
  // Pyth carries no mcap or 24h change, so those are borrowed from DexScreener
  // when it agrees closely enough on price to be describing the same asset.
  let primary: PriceQuote;
  if (cg && cg.price > 0) {
    primary = cg;
  } else if (pyth && pyth.price > 0) {
    const dexAgrees = dex && dex.price > 0 && Math.abs(dex.price - pyth.price) / pyth.price <= 0.05;
    primary = dexAgrees
      ? { ...pyth, change24h: dex!.change24h, mcap: dex!.mcap }
      : pyth;
  } else {
    primary = dex!;
  }

  if (candidates.length >= 2 && spreadPct > 5) {
    // Carry the individual quotes, not just the spread number. "17.4% spread
    // across coingecko/dexscreener/pyth" doesn't tell the caller which source
    // is the outlier; the per-source prices do, and a ticker collision is
    // obvious the moment you see them side by side.
    return {
      ...primary,
      inconsistent: { sources: candidates.map((c) => c.source), spreadPct, quotes: candidates },
    };
  }
  return primary;
}

// Market caps span $50k memecoins to $2T majors - a fixed unit renders one of
// those two ends unreadable ("$231778M", "$0M").
function fmtMcap(mcap: number): string {
  if (!mcap || mcap <= 0) return "unknown";
  if (mcap >= 1e12) return `$${(mcap / 1e12).toFixed(2)}T`;
  if (mcap >= 1e9)  return `$${(mcap / 1e9).toFixed(2)}B`;
  if (mcap >= 1e6)  return `$${(mcap / 1e6).toFixed(1)}M`;
  return `$${(mcap / 1e3).toFixed(0)}k`;
}

// Human-readable price across the same range: $1,919.92 vs $0.000004821.
function fmtPrice(n: number): string {
  return n >= 1
    ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `$${n.toPrecision(4)}`;
}

function spreadNote(priceData: PriceQuote & { inconsistent?: { spreadPct: number; quotes: PriceQuote[] } }): string {
  if (!priceData.inconsistent) return "";
  const each = priceData.inconsistent.quotes.map((q) => `${q.source} ${fmtPrice(q.price)}`).join(" · ");
  return ` | ⚠ sources disagree ${priceData.inconsistent.spreadPct.toFixed(1)}% — ${each}`;
}

export async function handleInsightTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name === "ask_finch") {
    const parsed = AskFinchSchema.safeParse(args);
    if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: question ${parsed.error.issues[0].message}` }], isError: true };

    const { question, messages = [] } = parsed.data;

    // Fetch enrichment + base prompt in parallel - enrichment hits free APIs
    // (DefiLlama, CoinGecko, HN, GitHub, arXiv, Wikipedia) based on detected
    // domain. Returns hasData=false if no domain matched or all APIs failed.
    const [{ prompt: base, meta }, enrichment] = await Promise.all([
      buildSystemPrompt(question),
      enrichQuery(question),
    ]);

    // Layered system prompt: persona → time anchor → live data (if any) →
    // strict guardrail tail. Time anchor blocks "Q2 catalysts in July" type
    // calendar hallucinations even when no enrichment ran.
    let systemPrompt = `${base}\n\n${todayContext()}`;

    if (enrichment.hasData) {
      systemPrompt += `\n\n${enrichment.context}`;
      systemPrompt += `\n\nCRITICAL: For any number, price, TVL, APY, or current-state claim, you MUST cite from the AUTHORITATIVE LIVE DATA block above. NEVER state a number not present in that block as if it were current. If the block doesn't cover what's asked, say so plainly - do not improvise.`;
    } else {
      // Price-shaped question with no live enrichment - force an honest answer
      // instead of letting the model recall a training-time number.
      const looksLikePriceQuestion = /\b(price|worth|trading at|cost|value|at \$|how much is|how many \$)\b/i.test(question)
        && /\b(btc|eth|sol|usdc|usdt|dai|matic|avax|link|uni|aave|ldo|bitcoin|ethereum|solana|base)\b/i.test(question);
      if (looksLikePriceQuestion) {
        systemPrompt += `\n\nCRITICAL: User is asking about a current price but no live data was retrieved. Reply honestly: "I don't have a live price quote right now - check CoinGecko or DexScreener directly." DO NOT state any specific price number. DO NOT recall a price from training data.`;
      }
    }

    if (!hasDirectLLMKey()) {
      return {
        content: [{
          type: "text",
          text:
            "ask_finch needs its own LLM key to reason server-side - set one of " +
            "BANKR_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROK_API_KEY as an " +
            "environment variable, then retry. If YOU (the calling model) already have " +
            "the context needed to answer this, just answer directly instead - that's " +
            "usually faster and doesn't need a key at all.",
        }],
        isError: true,
      };
    }

    const history = messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
    const answer = await callLLM(systemPrompt, question, 1024, history);

    // Signal gate - if the model returned thin/meta output, flag it so the
    // user knows to retry with more specific framing or use deep_research.
    const signal = checkSignal(answer);
    let finalAnswer = answer;
    if (!signal.ok && signal.reason) {
      finalAnswer = `${answer}\n\n_⚠️ ${signal.reason}. Consider rephrasing or using \`deep_research\` for grounded sources._`;
    }

    // syncToSupermemory (not a direct callConvex call) so this respects
    // local-memory mode too - otherwise every ask_finch exchange would keep
    // uploading to Convex regardless of the user's configured backend.
    syncToSupermemory(
      `Q: ${question.slice(0, 200)}\nA: ${finalAnswer.slice(0, 400)}`,
      { source: "ask_finch", addedAt: Date.now() },
    ).catch(() => {});

    const contextHeader = formatContextHeader(meta);
    return { content: [{ type: "text", text: contextHeader + finalAnswer }] };
  }

  if (name === "market_thesis") {
    const parsed = parseOrError(MarketThesisSchema, args);
    if (!parsed.ok) return parsed.error;

    const { token, context } = parsed.data;
    const priceData = await fetchVerifiedPrice(token);

    // Hard guard: without a verified live price, refuse to generate. Better
    // to fail loud than to write a thesis around a hallucinated number that
    // a user might trade on.
    if (!priceData) {
      return {
        content: [{
          type: "text",
          text: [
            `❌ **Cannot generate thesis for ${token.toUpperCase()}** - live price unavailable from CoinGecko or DexScreener.`,
            ``,
            `Reason: a bull/bear thesis grounded in a fabricated price is worse than no thesis. We don't write trade-shaped analysis without verified data.`,
            ``,
            `Try:`,
            `- Check CoinGecko or DexScreener directly to confirm the token symbol`,
            `- Retry in 30s (rate-limit) - both APIs are public/free`,
            `- For a less time-sensitive read, use \`deep_research\` instead`,
          ].join("\n"),
        }],
        isError: true,
      };
    }

    const inconsistencyNote = spreadNote(priceData);

    // The tool's real job is the verified price: three sources, cross-checked,
    // with a hard refusal above when they're missing or disagree. Writing the
    // thesis is model work — and the caller is a model that can also weigh the
    // user's stated context. Hand over grounded data plus the structure.
    const suggest = process.env.TRIGGER_SECRET_KEY
      ? `\n\n---\n💡 Use \`schedule_research\` for scheduled briefings on ${token.toUpperCase()}.`
      : "";

    return {
      content: [{
        type: "text",
        text: [
          `# ${token.toUpperCase()} — verified market data`,
          ``,
          `**Price:** ${fmtPrice(priceData.price)}`,
          `**24h:** ${priceData.change24h.toFixed(1)}%`,
          `**Market cap:** ${fmtMcap(priceData.mcap)}`,
          `**Source:** ${priceData.source}${inconsistencyNote}`,
          context ? `` : "",
          context ? `**User context:** ${context}` : "",
          ``,
          `---`,
          ``,
          `## Write the thesis from this`,
          ``,
          `### Bull Case`,
          `3-5 specific catalysts, narratives or technical factors. Be concrete — no vague "adoption".`,
          ``,
          `### Bear Case`,
          `3-5 specific risks, headwinds or red flags. Include on-chain, macro and competitive risks where they apply.`,
          ``,
          `### Net Verdict`,
          `**Conviction: X/10** — the deciding factor, the key risk to watch, your net lean (2-3 sentences).`,
          ``,
          `Anchor every claim to the verified price above. Do not invent figures — if you need data this ` +
            `tool did not supply, say so or fetch it with \`deep_research\`.`,
          suggest,
        ].filter(Boolean).join("\n"),
      }],
    };
  }

  if (name === "trade_plan") {
    const parsed = parseOrError(TradePlanSchema, args);
    if (!parsed.ok) return parsed.error;

    const { token, side = "long", portfolioSize, riskTolerance = "moderate", timeframe } = parsed.data;
    const priceData = await fetchVerifiedPrice(token);

    // Hard guard: trade plans without verified live price = entry/SL/TP
    // numbers anchored to nothing. Refuse to generate rather than feed the
    // LLM "use general knowledge" which it interprets as "make up a price".
    if (!priceData) {
      return {
        content: [{
          type: "text",
          text: [
            `❌ **Cannot build trade plan for ${token.toUpperCase()}** - live price unavailable from CoinGecko or DexScreener.`,
            ``,
            `Reason: entry, stop loss, and take profit levels anchored to a fabricated price are dangerous. We don't ship trade plans without verified data.`,
            ``,
            `Try:`,
            `- Confirm the token symbol on CoinGecko or DexScreener`,
            `- Retry in 30s if both APIs were briefly rate-limited`,
            `- Use \`get_token_data\` to verify the price is live first`,
          ].join("\n"),
        }],
        isError: true,
      };
    }

    const inconsistencyNote = spreadNote(priceData);

    // Everything below is arithmetic on the verified price - deterministic,
    // keyless, and impossible for the caller to get wrong by eyeballing. The
    // *judgement* (which level is the real invalidation, what the entry
    // trigger is) is model work and stays with the caller.
    const riskBands: Record<string, { label: string; min: number; max: number }> = {
      conservative: { label: "1-2% of portfolio",  min: 1, max: 2 },
      moderate:     { label: "2-5% of portfolio",  min: 2, max: 5 },
      aggressive:   { label: "5-10% of portfolio", min: 5, max: 10 },
    };
    const band = riskBands[riskTolerance];

    const fmt = fmtPrice;

    // Offsets are signed by direction: a long's stop sits below spot, a
    // short's above. Rendering them pre-signed stops the caller inverting
    // the plan on a short.
    const dir = side === "long" ? 1 : -1;
    const adverse = [3, 5, 8, 10, 15];
    const favourable = [5, 10, 20, 30, 50];

    const levelRows = [
      `| Move | Price | Use |`,
      `|---|---|---|`,
      ...adverse.map((p) => `| ${side === "long" ? "−" : "+"}${p}% | ${fmt(priceData.price * (1 - dir * p / 100))} | stop-loss candidate |`),
      ...favourable.map((p) => `| ${side === "long" ? "+" : "−"}${p}% | ${fmt(priceData.price * (1 + dir * p / 100))} | take-profit candidate |`),
    ].join("\n");

    const sizingLines = portfolioSize
      ? [
          `**Portfolio:** $${portfolioSize.toLocaleString()}`,
          `**Max position (${riskTolerance}):** $${(portfolioSize * band.min / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} – $${(portfolioSize * band.max / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} (${band.label})`,
          `**Max loss at a 10% stop:** $${(portfolioSize * band.max / 100 * 0.1).toLocaleString(undefined, { maximumFractionDigits: 0 })} (${(band.max * 0.1).toFixed(1)}% of portfolio)`,
        ]
      : [`**Max position (${riskTolerance}):** ${band.label} — pass \`portfolioSize\` for USD figures.`];

    const suggest = process.env.TRIGGER_SECRET_KEY
      ? `\n\n---\n💡 Use \`schedule_research\` for scheduled briefings on ${token.toUpperCase()}.`
      : "";

    return {
      content: [{
        type: "text",
        text: [
          `# ${token.toUpperCase()} ${side.toUpperCase()} — verified levels`,
          ``,
          `**Spot:** ${fmt(priceData.price)}`,
          `**24h:** ${priceData.change24h.toFixed(1)}%`,
          `**Market cap:** ${fmtMcap(priceData.mcap)}`,
          `**Source:** ${priceData.source}${inconsistencyNote}`,
          timeframe ? `**Timeframe:** ${timeframe}` : "",
          ``,
          ...sizingLines,
          ``,
          `## Levels off spot`,
          ``,
          levelRows,
          ``,
          `---`,
          ``,
          `## Write the plan from this`,
          ``,
          `### Entry`,
          `Ideal entry price or range, and the condition that must trigger it.`,
          ``,
          `### Risk Management`,
          `Stop loss (pick from the adverse levels above, justify why *that* one is the invalidation), ` +
            `position size, and the resulting max loss.`,
          ``,
          `### Targets`,
          `TP1/TP2/TP3 with the partial-exit % at each.`,
          ``,
          `### Risk/Reward`,
          `RR ratio computed from your chosen entry, stop and TP1. **If RR is below 1.5:1, say the trade is not worth taking** — do not dress up a bad ratio.`,
          ``,
          `### Thesis in one sentence`,
          ``,
          `### Invalidation`,
          `Exactly what kills the thesis, stated so it is checkable without judgement.`,
          ``,
          `Every price you quote must come from the table above or be derived from spot. Do not invent ` +
            `support/resistance levels this tool did not supply — if you want technicals, fetch them ` +
            `with \`get_token_data\` or \`rh_analyze\` first.${(priceData as any).inconsistent ? ` Sources disagree by ` +
            `${((priceData as any).inconsistent.spreadPct).toFixed(1)}% — widen the stop or say the quote is unreliable.` : ""}`,
          suggest,
        ].filter(Boolean).join("\n"),
      }],
    };
  }

  return null;
}
