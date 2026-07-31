// Central registry of MCP tool `outputSchema` declarations (spec 2025-06-18).
//
// A tool that declares an outputSchema SHOULD also return `structuredContent`
// conforming to it (its handler does; the human-readable `content` text stays
// for backward compatibility). Keeping every schema in one file - rather than
// inline on each tool definition across ~25 modules - makes the machine-readable
// surface reviewable in one place, mirrors how annotations.ts centralises
// behavioural hints, and lets a new tool opt in by adding one entry here plus a
// structuredContent return in its handler (no tool-definition edit needed).
//
// Attached to the listed tools by withAnnotations() (annotations.ts) at
// tools/list time. Only tools whose handler genuinely emits matching
// structuredContent belong here.

type JSONSchema = Record<string, unknown>;

const number_null = { type: ["number", "null"] };
const string_null = { type: ["string", "null"] };

export const OUTPUT_SCHEMAS: Record<string, JSONSchema> = {
  // ── market ────────────────────────────────────────────────────────────────
  get_token_data: {
    type: "object",
    properties: {
      symbol: string_null,
      name: string_null,
      priceUsd: number_null,
      change24hPct: number_null,
      marketCapUsd: number_null,
      marketCapRank: number_null,
      volume24hUsd: number_null,
      high24hUsd: number_null,
      low24hUsd: number_null,
      athUsd: number_null,
      athChangePct: number_null,
      source: { type: "string" },
    },
    required: ["symbol", "name", "source"],
  },
  get_base_token_data: {
    type: "object",
    properties: {
      address: { type: "string" },
      symbol: string_null,
      name: string_null,
      priceUsd: number_null,
      change1hPct: number_null,
      change6hPct: number_null,
      change24hPct: number_null,
      volume24hUsd: number_null,
      liquidityUsd: number_null,
      marketCapUsd: number_null,
      fdvUsd: number_null,
      pairAgeDays: number_null,
      listedOnCoingecko: { type: "boolean" },
      coingeckoId: string_null,
      source: { type: "string" },
    },
    required: ["address", "source", "listedOnCoingecko"],
  },
  compare_tokens: {
    type: "object",
    properties: {
      count: { type: "number" },
      unknown: { type: "array", items: { type: "string" } },
      tokens: {
        type: "array",
        items: {
          type: "object",
          properties: {
            symbol: string_null,
            name: string_null,
            priceUsd: number_null,
            change24hPct: number_null,
            change7dPct: number_null,
            marketCapUsd: number_null,
            marketCapRank: number_null,
            volume24hUsd: number_null,
            athChangePct: number_null,
          },
        },
      },
    },
    required: ["count", "tokens"],
  },

  // ── scanner ───────────────────────────────────────────────────────────────
  score_token: {
    type: "object",
    properties: {
      address: { type: "string" },
      symbol: { type: "string" },
      priceUsd: { type: "number" },
      liquidityUsd: { type: "number" },
      score: { type: "number", description: "0–100 dip-reversal score" },
      pattern: { type: ["string", "null"], description: "DEEP-REVERSAL | REVERSAL | DIP-BUY | SHALLOW-DIP, or null when gates failed" },
      passed: { type: "boolean", description: "false when hard gates failed" },
      gateFailures: { type: "array", items: { type: "string" } },
      breakdown: { type: "object", additionalProperties: true },
    },
    required: ["address", "symbol", "score", "passed"],
  },
  check_token: {
    type: "object",
    properties: {
      address: { type: "string" },
      verdict: { type: "string", enum: ["DANGER", "CAUTION", "SAFE"] },
      rugScore: { type: "number", description: "0–100, higher = riskier" },
      isHoneypot: { type: "boolean" },
      isMintable: { type: "boolean" },
      isFreezeAuth: { type: "boolean" },
      isOpenSource: { type: "boolean" },
      lpLockedPct: { type: "number" },
      buyTax: { type: "number" },
      sellTax: { type: "number" },
      holderCount: number_null,
    },
    required: ["address", "verdict", "rugScore"],
  },

  // ── wallet ────────────────────────────────────────────────────────────────
  get_wallet_balance: {
    type: "object",
    properties: {
      address: { type: "string" },
      chain: { type: "string" },
      ethBalance: { type: "number" },
      usdcBalance: { type: "number" },
      ethPriceUsd: number_null,
      ethValueUsd: number_null,
    },
    required: ["address", "chain", "ethBalance", "usdcBalance"],
  },

  // ── Robinhood Chain ─────────────────────────────────────────────────────────
  rh_safety_check: {
    type: "object",
    properties: {
      address: { type: "string" },
      symbol: string_null,
      name: string_null,
      riskScore: { type: "number", description: "0–100, higher = riskier" },
      tier: { type: "string", enum: ["DANGER", "CAUTION", "SOME RISK", "LOOKS OK"] },
      verified: { type: ["boolean", "null"] },
      contractName: string_null,
      reputation: string_null,
      holdersCount: number_null,
      creator: string_null,
      launchpad: { type: ["object", "null"], additionalProperties: true },
      flags: { type: "array", items: { type: "string" } },
    },
    required: ["address", "riskScore", "tier", "flags"],
  },
  rh_analyze: {
    type: "object",
    properties: {
      address: { type: "string" },
      symbol: string_null,
      name: string_null,
      priceUsd: number_null,
      change1hPct: number_null,
      change24hPct: number_null,
      liquidityUsd: number_null,
      volume24hUsd: number_null,
      fdvUsd: number_null,
      marketCapUsd: number_null,
      buys24h: number_null,
      sells24h: number_null,
      pairAgeDays: number_null,
      riskScore: { type: "number", description: "0–100, higher = riskier" },
      tier: { type: "string", enum: ["EXTREME", "HIGH", "MEDIUM", "LOWER"] },
      flags: { type: "array", items: { type: "string" } },
    },
    required: ["address", "riskScore", "tier", "flags"],
  },
  rh_mcp_list_stocks: {
    type: "object",
    properties: {
      count: { type: "number" },
      stocks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            name: { type: "string" },
            address: { type: "string" },
          },
          required: ["symbol", "name", "address"],
        },
      },
    },
    required: ["count", "stocks"],
  },

  // ── Base ────────────────────────────────────────────────────────────────────
  base_mcp_resolve: {
    type: "object",
    properties: {
      input: { type: "string" },
      address: string_null,
      name: string_null,
      resolved: { type: "boolean" },
    },
    required: ["input", "resolved"],
  },

  // ── SEC equities ────────────────────────────────────────────────────────────
  stock_fundamentals: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      companyName: string_null,
      cik: string_null,
      quote: {
        type: ["object", "null"],
        additionalProperties: true,
        description: "{ price, currency, prevClose, prevDate } - null when a live quote wasn't available",
      },
      quarterly: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } },
        description: "Per-concept arrays of { end, val, form, fy, fp } facts, most recent last",
      },
      annual: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "object", additionalProperties: true } },
        description: "Per-concept arrays of { end, val, form, fy, fp } facts, most recent last",
      },
    },
    required: ["ticker", "quarterly", "annual"],
  },
  stock_events: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      companyName: string_null,
      signalOnly: { type: "boolean" },
      count: { type: "number" },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            filingDate: { type: "string" },
            reportDate: string_null,
            codes: { type: "array", items: { type: "string" } },
            hasSignal: { type: "boolean" },
            url: { type: "string" },
          },
          required: ["filingDate", "codes", "hasSignal", "url"],
        },
      },
    },
    required: ["ticker", "count", "events"],
  },
  stock_insider: {
    type: "object",
    properties: {
      ticker: { type: "string" },
      companyName: string_null,
      filingsParsed: { type: "number" },
      skippedOtherIssuer: { type: "number" },
      buys: { type: "object", additionalProperties: true, description: "{ count, shares, valueUsd } of open-market discretionary buys" },
      sells: { type: "object", additionalProperties: true, description: "{ count, shares, valueUsd } of open-market discretionary sells" },
      netBuyValueUsd: { type: "number", description: "buys value − sells value (discretionary only)" },
      automaticCount: { type: "number", description: "non-discretionary txns (grants, RSU tax, option exercises)" },
      transactions: {
        type: "array",
        description: "Up to 12 most-recent discretionary transactions",
        items: { type: "object", additionalProperties: true },
      },
    },
    required: ["ticker", "buys", "sells", "transactions"],
  },

  // ── GitHub ──────────────────────────────────────────────────────────────────
  github_list_repos: {
    type: "object",
    properties: {
      username: string_null,
      count: { type: "number" },
      repos: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "repos"],
  },
  github_list_prs: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      state: { type: "string" },
      count: { type: "number" },
      prs: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["owner", "repo", "count", "prs"],
  },
  github_get_pr: {
    type: "object",
    properties: {
      number: { type: "number" },
      title: { type: "string" },
      state: { type: "string" },
      draft: { type: "boolean" },
      author: string_null,
      head: string_null,
      base: string_null,
      additions: { type: "number" },
      deletions: { type: "number" },
      changedFiles: { type: "number" },
      url: { type: "string" },
      files: { type: "array", items: { type: "object", additionalProperties: true } },
      reviewCount: { type: "number" },
      commentCount: { type: "number" },
    },
    required: ["number", "title", "state", "files"],
  },
  github_list_issues: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      state: { type: "string" },
      count: { type: "number" },
      issues: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["owner", "repo", "count", "issues"],
  },
  github_get_issue: {
    type: "object",
    properties: {
      number: { type: "number" },
      title: { type: "string" },
      state: { type: "string" },
      author: string_null,
      labels: { type: "array", items: { type: "string" } },
      assignees: { type: "array", items: { type: "string" } },
      commentCount: { type: "number" },
      url: { type: "string" },
      createdAt: string_null,
    },
    required: ["number", "title", "state"],
  },
  github_get_file: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      path: { type: "string" },
      ref: string_null,
      isFile: { type: "boolean" },
      sizeBytes: number_null,
      sha: string_null,
      url: string_null,
      language: { type: "string" },
      truncated: { type: "boolean" },
      content: { type: "string" },
    },
    required: ["owner", "repo", "path", "isFile"],
  },
  github_get_commits: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      branch: string_null,
      path: string_null,
      count: { type: "number" },
      commits: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["owner", "repo", "count", "commits"],
  },
  github_search_code: {
    type: "object",
    properties: {
      query: { type: "string" },
      totalCount: { type: "number" },
      count: { type: "number" },
      results: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["query", "count", "results"],
  },

  // ── chronicle ───────────────────────────────────────────────────────────────
  chronicle_list: {
    type: "object",
    properties: {
      type: string_null,
      count: { type: "number" },
      entries: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "entries"],
  },
  chronicle_search: {
    type: "object",
    properties: {
      query: { type: "string" },
      type: string_null,
      count: { type: "number" },
      entries: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["query", "count", "entries"],
  },
  chronicle_stats: {
    type: "object",
    properties: {
      days: { type: "number" },
      totalEvents: { type: "number" },
      activeDays: { type: "number" },
      avgPerDay: { type: "number" },
      byType: { type: "array", items: { type: "object", additionalProperties: true } },
      busiestDays: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["days", "totalEvents", "byType"],
  },

  // ── automation / monitor / packet ───────────────────────────────────────────
  list_automations: {
    type: "object",
    properties: {
      count: { type: "number" },
      automations: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "automations"],
  },
  get_automation_runs: {
    type: "object",
    properties: {
      automationId: { type: "string" },
      count: { type: "number" },
      runs: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["automationId", "count", "runs"],
  },
  list_monitors: {
    type: "object",
    properties: {
      count: { type: "number" },
      monitors: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "monitors"],
  },
  packet_list: {
    type: "object",
    properties: {
      count: { type: "number" },
      packets: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "packets"],
  },

  // ── vault ───────────────────────────────────────────────────────────────────
  vault_list: {
    type: "object",
    properties: {
      type: string_null,
      count: { type: "number" },
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            title: string_null,
            type: string_null,
            version: { type: "number" },
            size: number_null,
            updatedAt: number_null,
            isPinned: { type: "boolean" },
          },
          required: ["key"],
        },
      },
    },
    required: ["count", "entries"],
  },
  vault_search: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "number" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            title: string_null,
            type: string_null,
            score: number_null,
            preview: string_null,
          },
          required: ["key"],
        },
      },
    },
    required: ["query", "count", "results"],
  },

  // ── memory ──────────────────────────────────────────────────────────────────
  memory_search: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "number" },
      memories: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["query", "count", "memories"],
  },
  memory_context: {
    type: "object",
    properties: {
      topic: { type: "string" },
      count: { type: "number" },
      memories: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["topic", "count", "memories"],
  },
  memory_profile: {
    type: "object",
    properties: {
      space: string_null,
      total: { type: "number" },
      status: { type: "string" },
    },
    required: ["total", "status"],
  },
  memory_list: {
    type: "object",
    properties: {
      tag: string_null,
      count: { type: "number" },
      memories: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "memories"],
  },

  // ── agents ──────────────────────────────────────────────────────────────────
  list_agents: {
    type: "object",
    properties: {
      count: { type: "number" },
      agents: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "agents"],
  },
  agent_ledger: {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "number" },
      versions: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["name", "count", "versions"],
  },
  agent_runs: {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "number" },
      runs: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["name", "count", "runs"],
  },

  // ── scanner / orders / wallet ────────────────────────────────────────────────
  scan_market: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["dips", "momentum"] },
      scanned: { type: "number" },
      count: { type: "number" },
      results: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["mode", "scanned", "count", "results"],
  },
  rh_orders_list: {
    type: "object",
    properties: {
      count: { type: "number" },
      orders: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "orders"],
  },
  get_wallet_address: {
    type: "object",
    properties: {
      address: { type: "string" },
      chain: { type: "string" },
      chainId: { type: "number" },
    },
    required: ["address", "chain", "chainId"],
  },

  // ── market overview / history / defi yields ─────────────────────────────────
  market_overview: {
    type: "object",
    properties: {
      fearGreedValue: number_null,
      fearGreedClass: string_null,
      totalMarketCapUsd: number_null,
      marketCap24hChangePct: number_null,
      btcDominancePct: number_null,
      ethDominancePct: number_null,
      defiTvlUsd: number_null,
      activeCoins: number_null,
      trending: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["trending"],
  },
  token_history: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      days: { type: "number" },
      currentPriceUsd: number_null,
      openPrice: { type: "number" },
      closePrice: { type: "number" },
      periodChangePct: number_null,
      periodHighUsd: { type: "number" },
      periodLowUsd: { type: "number" },
      candles: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["symbol", "days", "candles"],
  },
  get_defi_yields: {
    type: "object",
    properties: {
      token: string_null,
      minApy: { type: "number" },
      count: { type: "number" },
      pools: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["count", "pools"],
  },
};
