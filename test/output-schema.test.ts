import { describe, it, expect } from "vitest";
import { ALL_TOOLS } from "../src/server.js";
import { withAnnotations } from "../src/annotations.js";
import { OUTPUT_SCHEMAS } from "../src/output-schemas.js";
import { buildScoreStructured, assessTokenSecurity } from "../src/tools/scanner.js";
import { buildTokenSnapshot, buildBaseTokenSnapshot, buildTokenComparison, buildMarketOverview, buildTokenHistory } from "../src/tools/market.js";
import { buildDefiYields } from "../src/tools/defi.js";
import { buildWalletBalance } from "../src/tools/wallet.js";
import { buildRhSafetyStructured, buildRhAnalysis, buildRhStocksList } from "../src/tools/rh-mcp.js";
import { buildBasenameResolution } from "../src/tools/base-mcp.js";
import { buildStockEvents } from "../src/tools/events.js";
import { buildInsiderSummary } from "../src/tools/insider.js";
import {
  buildRepoList, buildPrList, buildPrDetail, buildIssueList,
  buildIssueDetail, buildCommitList, buildCodeSearch,
} from "../src/tools/github.js";
import { buildChronicleList, buildChronicleSearch, buildChronicleStats } from "../src/tools/chronicle.js";
import { buildAutomationList, buildAutomationRuns } from "../src/tools/automation.js";
import { buildMonitorList } from "../src/tools/monitor.js";
import { buildPacketList } from "../src/tools/packets.js";
import { buildMemorySearch, buildMemoryContext, buildMemoryProfile, buildMemoryList } from "../src/tools/memory.js";
import { buildAgentLedger, buildAgentRuns } from "../src/tools/agents.js";
import { buildScanResults } from "../src/tools/scanner.js";
import { buildOrdersList } from "../src/tools/rh-orders.js";

// Minimal JSON-Schema conformance check - enough to prove a structuredContent
// payload matches its tool's declared outputSchema, without pulling in a full
// validator. Checks: required keys present, no undeclared keys, and each value
// matches the declared `type` (which may be a union like ["number","null"]).
function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // string | number | boolean | object
}

function conforms(payload: Record<string, unknown>, schema: any): string[] {
  const errors: string[] = [];
  const props = schema.properties ?? {};
  for (const req of schema.required ?? []) {
    if (!(req in payload)) errors.push(`missing required key: ${req}`);
  }
  for (const [key, value] of Object.entries(payload)) {
    const spec = props[key];
    if (!spec) {
      errors.push(`undeclared key: ${key}`);
      continue;
    }
    const allowed = Array.isArray(spec.type) ? spec.type : [spec.type];
    const actual = jsonType(value);
    if (!allowed.includes(actual)) {
      errors.push(`key ${key}: got ${actual}, want ${allowed.join("|")}`);
    }
  }
  return errors;
}

// outputSchema is attached from the central registry by withAnnotations (the
// tools/list path), not stored inline on the tool definition - so resolve
// against the annotated list, exactly as an MCP client sees it.
const ANNOTATED_TOOLS = withAnnotations(ALL_TOOLS);

function toolByName(name: string) {
  const t = ANNOTATED_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

describe("outputSchema declarations", () => {
  const STRUCTURED_TOOLS = [
    "get_token_data",
    "score_token",
    "check_token",
    "get_base_token_data",
    "get_wallet_balance",
    "rh_safety_check",
    "base_mcp_resolve",
    "rh_analyze",
    "rh_mcp_list_stocks",
    "compare_tokens",
    "stock_events",
    "stock_insider",
    "github_list_repos",
    "github_list_prs",
    "github_get_pr",
    "github_list_issues",
    "github_get_issue",
    "github_get_file",
    "github_get_commits",
    "github_search_code",
    "chronicle_list",
    "chronicle_search",
    "chronicle_stats",
    "list_automations",
    "get_automation_runs",
    "list_monitors",
    "packet_list",
    "memory_search",
    "memory_context",
    "memory_profile",
    "memory_list",
    "agent_ledger",
    "agent_runs",
    "scan_market",
    "rh_orders_list",
    "get_wallet_address",
    "market_overview",
    "token_history",
    "get_defi_yields",
  ];

  it("declares a well-formed object outputSchema on each structured tool", () => {
    for (const name of STRUCTURED_TOOLS) {
      const schema = (toolByName(name) as any).outputSchema;
      expect(schema, `${name} has no outputSchema`).toBeTruthy();
      expect(schema.type, `${name} outputSchema.type`).toBe("object");
      const propKeys = Object.keys(schema.properties ?? {});
      expect(propKeys.length, `${name} outputSchema has no properties`).toBeGreaterThan(0);
      // required must be a subset of declared properties
      for (const req of schema.required ?? []) {
        expect(propKeys, `${name} requires undeclared prop ${req}`).toContain(req);
      }
    }
  });

  it("every OUTPUT_SCHEMAS entry targets a real, registered tool", () => {
    const declared = new Set(ALL_TOOLS.map((t) => t.name));
    const unknown = Object.keys(OUTPUT_SCHEMAS).filter((n) => !declared.has(n));
    expect(unknown, "output-schemas.ts references tools not in ALL_TOOLS").toEqual([]);
  });

  it("withAnnotations attaches the registry schema to the tool (as clients see it)", () => {
    for (const name of Object.keys(OUTPUT_SCHEMAS)) {
      const tool = ANNOTATED_TOOLS.find((t) => t.name === name);
      expect((tool as any)?.outputSchema, `${name} outputSchema not attached`).toBe(OUTPUT_SCHEMAS[name]);
    }
  });
});

describe("structuredContent conforms to outputSchema", () => {
  it("get_token_data / buildTokenSnapshot", () => {
    const cg = {
      symbol: "eth",
      name: "Ethereum",
      current_price: 3421.5,
      price_change_percentage_24h: -1.8,
      market_cap: 411_000_000_000,
      market_cap_rank: 2,
      total_volume: 18_000_000_000,
      high_24h: 3500,
      low_24h: 3380,
      ath: 4878,
      ath_change_percentage: -29.8,
    };
    const payload = buildTokenSnapshot(cg);
    expect(payload.symbol).toBe("ETH");
    expect(payload.source).toBe("coingecko");
    const schema = (toolByName("get_token_data") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("get_token_data tolerates missing fields (nulls stay schema-valid)", () => {
    const payload = buildTokenSnapshot({ symbol: "new", name: "NewCoin" });
    expect(payload.priceUsd).toBeNull();
    const schema = (toolByName("get_token_data") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("score_token / buildScoreStructured", () => {
    const c = { symbol: "TKN", priceUsd: 0.00042, liquidity: 120_000 } as any;
    const result = {
      score: 72,
      passed: true,
      pattern: "REVERSAL",
      gateFailures: [],
      breakdown: { dropDepth: { value: -8.1, points: 20 } },
      buyPressure5m: 61,
    } as any;
    const payload = buildScoreStructured("0xabc", c, result);
    expect(payload.score).toBe(72);
    expect(payload.address).toBe("0xabc");
    const schema = (toolByName("score_token") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("check_token / assessTokenSecurity - honeypot is DANGER", () => {
    const sec = assessTokenSecurity({
      is_honeypot: "1",
      is_mintable: "1",
      sell_tax: "0",
      buy_tax: "0",
      lp_holders: [],
      holder_count: "12",
    });
    expect(sec.verdict).toBe("DANGER");
    expect(sec.rugScore).toBeGreaterThanOrEqual(60);
    expect(sec.isHoneypot).toBe(true);
    expect(sec.holderCount).toBe(12);
    const schema = (toolByName("check_token") as any).outputSchema;
    expect(conforms({ address: "0xdead", ...sec }, schema)).toEqual([]);
  });

  it("check_token / assessTokenSecurity - clean token is SAFE", () => {
    const sec = assessTokenSecurity({
      is_honeypot: "0",
      is_mintable: "0",
      transfer_pausable: "0",
      is_open_source: "1",
      sell_tax: "0",
      buy_tax: "0",
      lp_holders: [{ is_locked: 1, percent: "0.95" }], // 95% locked
      holder_count: "5000",
    });
    expect(sec.verdict).toBe("SAFE");
    expect(sec.rugScore).toBe(0);
    expect(sec.lpLockedPct).toBeCloseTo(95, 5);
    const schema = (toolByName("check_token") as any).outputSchema;
    expect(conforms({ address: "0xgood", ...sec }, schema)).toEqual([]);
  });

  it("get_base_token_data / buildBaseTokenSnapshot", () => {
    const pair = {
      baseToken: { symbol: "NOEL", name: "Noel" },
      priceUsd: "0.0031",
      priceChange: { h1: 2, h6: -4, h24: 11 },
      volume: { h24: 50_000 },
      liquidity: { usd: 120_000 },
      marketCap: 3_100_000,
      fdv: 4_000_000,
      pairCreatedAt: 1_700_000_000_000, // fixed epoch → pairAgeDays is a number
    };
    const payload = buildBaseTokenSnapshot("0xabc", pair, null);
    expect(payload.symbol).toBe("NOEL");
    expect(payload.listedOnCoingecko).toBe(false);
    expect(typeof payload.pairAgeDays).toBe("number");
    const schema = (toolByName("get_base_token_data") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("get_wallet_balance / buildWalletBalance computes ETH value", () => {
    const payload = buildWalletBalance("0xwallet", 1.5, 200, 2000);
    expect(payload.ethValueUsd).toBe(3000);
    expect(payload.chain).toBe("base-mainnet");
    const schema = (toolByName("get_wallet_balance") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);

    // no price → value is null, still schema-valid
    const noPrice = buildWalletBalance("0xwallet", 1.5, 200, null);
    expect(noPrice.ethValueUsd).toBeNull();
    expect(conforms(noPrice, schema)).toEqual([]);
  });

  it("rh_safety_check / buildRhSafetyStructured strips the tier emoji", () => {
    const r = { address: "0xtok", symbol: "TKN", name: "Token" } as any;
    const safety = {
      verified: true,
      contractName: null,
      reputation: "ok",
      holdersCount: 500,
      creator: "0xdead",
      launchpad: null,
    } as any;
    const assessment = { score: 12, tier: "🟢 LOOKS OK", flags: ["🟢 Contract verified"] };
    const payload = buildRhSafetyStructured(r, safety, assessment);
    expect(payload.tier).toBe("LOOKS OK");
    expect(payload.riskScore).toBe(12);
    const schema = (toolByName("rh_safety_check") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("base_mcp_resolve / buildBasenameResolution", () => {
    const fwd = buildBasenameResolution("jesse.base.eth", { address: "0xabc", name: "jesse.base.eth" });
    expect(fwd.resolved).toBe(true);
    expect(fwd.address).toBe("0xabc");
    const schema = (toolByName("base_mcp_resolve") as any).outputSchema;
    expect(conforms(fwd, schema)).toEqual([]);

    // unresolved input still conforms (address/name null, resolved false)
    const miss = buildBasenameResolution("nope.base.eth", {});
    expect(miss.resolved).toBe(false);
    expect(miss.address).toBeNull();
    expect(conforms(miss, schema)).toEqual([]);
  });

  it("rh_analyze / buildRhAnalysis strips the tier emoji", () => {
    const r = { address: "0xtok", symbol: "TKN", name: "Token" } as any;
    const dex = {
      priceUsd: "0.0031",
      priceChange: { h1: 1.2, h24: -5 },
      liquidity: { usd: 90_000 },
      volume: { h24: 12_000 },
      fdv: 500_000,
      marketCap: 300_000,
      txns: { h24: { buys: 40, sells: 30 } },
      pairCreatedAt: 1_700_000_000_000,
    } as any;
    const assessment = { score: 48, tier: "🟠 HIGH", flags: ["🟠 thin float"] };
    const payload = buildRhAnalysis(r, dex, assessment);
    expect(payload.tier).toBe("HIGH");
    expect(payload.riskScore).toBe(48);
    expect(payload.priceUsd).toBe(0.0031);
    const schema = (toolByName("rh_analyze") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("rh_mcp_list_stocks / buildRhStocksList", () => {
    const rows = [
      { address: "0x1", symbol: "AAPL", name: "Apple" },
      { address: "0x2", symbol: "TSLA", name: "Tesla" },
    ];
    const payload = buildRhStocksList(rows);
    expect(payload.count).toBe(2);
    expect((payload.stocks as any[])[0]).toEqual({ symbol: "AAPL", name: "Apple", address: "0x1" });
    const schema = (toolByName("rh_mcp_list_stocks") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("compare_tokens / buildTokenComparison", () => {
    const data = [
      { symbol: "btc", name: "Bitcoin", current_price: 95000, price_change_percentage_24h: 1.2, price_change_percentage_7d_in_currency: 5, market_cap: 1.9e12, market_cap_rank: 1, total_volume: 4e10, ath_change_percentage: -10 },
      { symbol: "eth", name: "Ethereum", current_price: 3400, price_change_percentage_24h: -0.5, market_cap: 4.1e11, market_cap_rank: 2, total_volume: 1.8e10, ath_change_percentage: -30 },
    ];
    const payload = buildTokenComparison(data, ["FOO"]);
    expect(payload.count).toBe(2);
    expect((payload.tokens as any[])[0].symbol).toBe("BTC");
    expect((payload.tokens as any[])[1].change7dPct).toBeNull(); // eth had no 7d field
    const schema = (toolByName("compare_tokens") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);
  });

  it("stock_events / buildStockEvents", () => {
    const events = [
      { date: "2026-07-01", reportDate: "2026-06-28", codes: ["2.02", "9.01"], hasSignal: true, url: "https://sec.gov/x" },
      { date: "2026-06-15", codes: ["5.02"], hasSignal: true, url: "https://sec.gov/y" },
    ];
    const payload = buildStockEvents("HOOD", "Robinhood Markets", true, events);
    expect(payload.count).toBe(2);
    expect((payload.events as any[])[0].filingDate).toBe("2026-07-01");
    expect((payload.events as any[])[1].reportDate).toBeNull(); // missing → null
    const schema = (toolByName("stock_events") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);

    // empty window still conforms
    const empty = buildStockEvents("HOOD", "Robinhood Markets", false, []);
    expect(empty.count).toBe(0);
    expect(conforms(empty, schema)).toEqual([]);
  });

  it("stock_insider / buildInsiderSummary aggregates buys/sells and net", () => {
    const buys = [
      { owner: "Jane", role: "CEO", date: "2026-07-02", shares: 1000, price: 20, value: 20000, heldAfter: 5000, acquired: true, planned: false },
    ];
    const sells = [
      { owner: "Bob", role: "Director", date: "2026-07-01", shares: 500, price: 22, value: 11000, heldAfter: 100, acquired: false, planned: true },
    ];
    const automatic = [
      { owner: "Al", role: "CFO", date: "2026-06-30", shares: 200, price: 21, value: 4200, heldAfter: null, acquired: false, planned: false },
    ];
    const payload = buildInsiderSummary("NVDA", "NVIDIA", 15, 2, buys, sells, automatic);
    expect((payload.buys as any).valueUsd).toBe(20000);
    expect((payload.sells as any).valueUsd).toBe(11000);
    expect(payload.netBuyValueUsd).toBe(9000);
    expect(payload.automaticCount).toBe(1);
    expect((payload.transactions as any[]).length).toBe(2); // discretionary only
    const schema = (toolByName("stock_insider") as any).outputSchema;
    expect(conforms(payload, schema)).toEqual([]);

    // no-transaction case still conforms
    const none = buildInsiderSummary("NVDA", "NVIDIA", 15, 0, [], [], []);
    expect(none.netBuyValueUsd).toBe(0);
    expect(conforms(none, schema)).toEqual([]);
  });

  it("github builders conform to their schemas", () => {
    const repos = buildRepoList("octocat", [
      { full_name: "octocat/hello", description: "d", language: "TS", stargazers_count: 5, forks_count: 1, private: false, updated_at: "2026-01-01T00:00:00Z", html_url: "u" },
    ]);
    expect((repos.repos as any[])[0].fullName).toBe("octocat/hello");
    expect(conforms(repos, (toolByName("github_list_repos") as any).outputSchema)).toEqual([]);

    const prs = buildPrList("o", "r", "open", [{ number: 1, title: "t", user: { login: "a" }, head: { ref: "f" }, base: { ref: "main" }, html_url: "u" }]);
    expect(prs.count).toBe(1);
    expect(conforms(prs, (toolByName("github_list_prs") as any).outputSchema)).toEqual([]);

    const pr = buildPrDetail({ number: 2, title: "t", state: "open", user: { login: "a" }, head: { ref: "f" }, base: { ref: "main" }, additions: 3, deletions: 1, changed_files: 2, html_url: "u" }, [{ filename: "x", status: "modified", additions: 3, deletions: 1 }], [], []);
    expect(pr.changedFiles).toBe(2);
    expect(conforms(pr, (toolByName("github_get_pr") as any).outputSchema)).toEqual([]);

    const issues = buildIssueList("o", "r", "open", [{ number: 4, title: "t", user: { login: "a" }, labels: [{ name: "bug" }], comments: 2, html_url: "u" }]);
    expect(conforms(issues, (toolByName("github_list_issues") as any).outputSchema)).toEqual([]);

    const issue = buildIssueDetail({ number: 4, title: "t", state: "open", user: { login: "a" }, labels: [{ name: "bug" }], assignees: [{ login: "z" }], html_url: "u", created_at: "2026-01-01" }, [{}]);
    expect((issue.labels as string[])[0]).toBe("bug");
    expect(conforms(issue, (toolByName("github_get_issue") as any).outputSchema)).toEqual([]);

    const commits = buildCommitList("o", "r", "main", undefined, [{ sha: "abc", commit: { message: "fix: x\n\nbody", author: { name: "a", date: "2026-01-01" } }, html_url: "u" }]);
    expect((commits.commits as any[])[0].message).toBe("fix: x");
    expect(conforms(commits, (toolByName("github_get_commits") as any).outputSchema)).toEqual([]);

    const search = buildCodeSearch("q", 42, [{ path: "src/x.ts", repository: { full_name: "o/r" }, html_url: "u" }]);
    expect(search.totalCount).toBe(42);
    expect(conforms(search, (toolByName("github_search_code") as any).outputSchema)).toEqual([]);
  });

  it("chronicle / automation / monitor / packet builders conform", () => {
    const entries = [{ title: "t", detail: "d", type: "trade", ts: 1_700_000_000_000 }];
    expect(conforms(buildChronicleList("trade", entries), (toolByName("chronicle_list") as any).outputSchema)).toEqual([]);
    expect(conforms(buildChronicleSearch("q", undefined, entries), (toolByName("chronicle_search") as any).outputSchema)).toEqual([]);
    const stats = buildChronicleStats(30, entries);
    expect(stats.totalEvents).toBe(1);
    expect(conforms(stats, (toolByName("chronicle_stats") as any).outputSchema)).toEqual([]);

    const autos = buildAutomationList([{ _id: "a1", name: "DCA", status: "active", triggerType: "cron", actionType: "swap", totalRuns: 3 }]);
    expect((autos.automations as any[])[0].id).toBe("a1");
    expect(conforms(autos, (toolByName("list_automations") as any).outputSchema)).toEqual([]);
    const runs = buildAutomationRuns("a1", [{ status: "success", triggeredAt: 1, amountUsd: 5, txHash: "0x", error: null }]);
    expect(conforms(runs, (toolByName("get_automation_runs") as any).outputSchema)).toEqual([]);

    const mons = buildMonitorList([{ id: "s1", externalId: "e1", cron: "0 9 * * *", nextRun: 1 }], { e1: { topic: "eth", label: "ETH" } });
    expect((mons.monitors as any[])[0].label).toBe("ETH");
    expect(conforms(mons, (toolByName("list_monitors") as any).outputSchema)).toEqual([]);

    const packets = buildPacketList([{ title: "daily", content: JSON.stringify({ steps: [1, 2, 3] }), isPublic: true, tags: ["packet", "research"] }]);
    expect((packets.packets as any[])[0].steps).toBe(3);
    expect((packets.packets as any[])[0].tags).toEqual(["research"]);
    expect(conforms(packets, (toolByName("packet_list") as any).outputSchema)).toEqual([]);
  });

  it("memory builders conform", () => {
    const decayed = [{ id: "m1", content: "note", metadata: { title: "T" }, _decayedScore: 0.9, _ageDays: 12, _pinned: false, semanticRank: 0, lexicalRank: null }];
    const s = buildMemorySearch("q", decayed);
    expect((s.memories as any[])[0].id).toBe("m1");
    expect(conforms(s, (toolByName("memory_search") as any).outputSchema)).toEqual([]);

    const ctx = buildMemoryContext("topic", [{ content: "c", metadata: { title: "T" } }]);
    expect(conforms(ctx, (toolByName("memory_context") as any).outputSchema)).toEqual([]);

    const prof = buildMemoryProfile({ space: "sp", total: 42, status: "ok" });
    expect(prof.total).toBe(42);
    expect(conforms(prof, (toolByName("memory_profile") as any).outputSchema)).toEqual([]);

    const list = buildMemoryList("crypto", [{ id: "m2", content: "x", metadata: {} }]);
    expect((list.memories as any[])[0].title).toBeNull();
    expect(conforms(list, (toolByName("memory_list") as any).outputSchema)).toEqual([]);
  });

  it("agents / scanner / orders builders conform", () => {
    const ledger = buildAgentLedger("Scout", [{ version: 2, commitMsg: "m", createdAt: 1 }]);
    expect(conforms(ledger, (toolByName("agent_ledger") as any).outputSchema)).toEqual([]);

    const runs = buildAgentRuns("Scout", [{ startedAt: 1, status: "success", workflow: "w", durationMs: 1200, toolCallCount: 5 }]);
    expect(conforms(runs, (toolByName("agent_runs") as any).outputSchema)).toEqual([]);

    const scan = buildScanResults("dips", 40, [{ symbol: "TKN", mint: "0x", score: 72, pattern: "REVERSAL", liquidity: 120000, priceChange1h: -8, buyPressure5m: 61, volume1h: 5000 }]);
    expect((scan.results as any[])[0].address).toBe("0x");
    expect(conforms(scan, (toolByName("scan_market") as any).outputSchema)).toEqual([]);

    const orders = buildOrdersList([{ id: "o1", type: "dca", status: "active", token: { symbol: "NVDA", address: "0xabc" }, dca: { totalBuys: 10 } }]);
    expect((orders.orders as any[])[0].symbol).toBe("NVDA");
    expect(conforms(orders, (toolByName("rh_orders_list") as any).outputSchema)).toEqual([]);
  });

  it("market_overview / token_history / defi_yields builders conform", () => {
    const ov = buildMarketOverview(
      { total_market_cap: { usd: 3.5e12 }, market_cap_change_percentage_24h_usd: 1.1, market_cap_percentage: { btc: 52, eth: 17 }, total_value_locked: { usd: 1.2e11 }, active_cryptocurrencies: 12000 },
      { value: "63", value_classification: "Greed" },
      [{ item: { symbol: "PEPE", name: "Pepe", market_cap_rank: 30 } }],
    );
    expect(ov.fearGreedValue).toBe(63);
    expect((ov.trending as any[])[0].symbol).toBe("PEPE");
    expect(conforms(ov, (toolByName("market_overview") as any).outputSchema)).toEqual([]);

    const hist = buildTokenHistory("BTC", 7, { current_price: 95000 }, 90000, 95000, 96000, 89000, [[1_700_000_000_000, 90000, 91000, 89500, 90500]]);
    expect(hist.periodChangePct).toBeCloseTo(5.56, 1);
    expect((hist.candles as any[])[0].close).toBe(90500);
    expect(conforms(hist, (toolByName("token_history") as any).outputSchema)).toEqual([]);

    const yields = buildDefiYields("usdc", 3, [{ symbol: "USDC", project: "aave", apy: 5.2, tvlUsd: 4e8, chain: "Base" }]);
    expect(yields.token).toBe("USDC");
    expect((yields.pools as any[])[0].apyPct).toBe(5.2);
    expect(conforms(yields, (toolByName("get_defi_yields") as any).outputSchema)).toEqual([]);
  });
});
