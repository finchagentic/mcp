// Public-company fundamentals from primary sources.
//
// Financials come from SEC EDGAR XBRL — the numbers as filed in 10-Q/10-K, not
// a vendor's re-typing of them. No API key, no rate-limit tier, and if a figure
// here is wrong it is wrong in the filing itself.
//
// The tool computes what is mechanical (margins, YoY growth, quarter vs YTD)
// and hands the result to the caller's model to interpret. It does not write
// the analysis: the caller has the user's thesis, risk tolerance and context,
// and is a stronger analyst than anything this module could embed.

import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";

// ── Structured output builder (schema in output-schemas.ts) ─────────────────
export function buildStockFundamentals(
  ticker: string,
  companyName: string | null,
  cik: string | null,
  quote: { price: number; currency: string; prevClose: number; prevDate: string } | null,
  quarterly: Record<string, unknown[]>,
  annual: Record<string, unknown[]>,
): Record<string, unknown> {
  return { ticker, companyName, cik, quote, quarterly, annual };
}

const SEC_UA = "Finch MCP research (contact: support@finchagentic.com)";
const SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json";
const SEC_CONCEPT = (cik: string, tag: string) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`;

/**
 * Concepts pulled per company. Order drives the report layout.
 *
 * Each concept lists several candidate XBRL tags because issuers do not agree
 * on which one to use, and a company can stop using one mid-history. Apple
 * abandoned `Revenues` at the ASC 606 transition and reports under
 * `RevenueFromContractWithCustomer…`; querying only `Revenues` returns its
 * pre-2019 figures, which then render as the current picture — stale by years,
 * and indistinguishable from correct output. The tag with the most recent data
 * wins, so a legacy series can never outrank a live one.
 */
const CONCEPTS: Array<{ key: string; tags: string[]; label: string; kind: "flow" | "stock" | "pershare" }> = [
  {
    key: "revenue",
    label: "Revenue",
    kind: "flow",
    tags: [
      "Revenues",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueNet",
    ],
  },
  { key: "netIncome", label: "Net income", kind: "flow", tags: ["NetIncomeLoss"] },
  { key: "opIncome", label: "Operating income", kind: "flow", tags: ["OperatingIncomeLoss"] },
  { key: "eps", label: "EPS (diluted)", kind: "pershare", tags: ["EarningsPerShareDiluted"] },
  { key: "assets", label: "Total assets", kind: "stock", tags: ["Assets"] },
  { key: "liabilities", label: "Total liabilities", kind: "stock", tags: ["Liabilities"] },
  {
    key: "equity",
    label: "Shareholders' equity",
    kind: "stock",
    tags: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  },
  {
    key: "cash",
    label: "Cash & equivalents",
    kind: "stock",
    tags: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
  },
];

export const EQUITY_TOOLS: Tool[] = [
  {
    name: "stock_fundamentals",
    description:
      "Fetch a public company's financials straight from SEC EDGAR XBRL (as filed in 10-Q/10-K) " +
      "plus a live quote. Returns revenue, operating and net income, diluted EPS, balance sheet, " +
      "computed margins and YoY growth — with quarterly figures correctly separated from " +
      "year-to-date ones. US-listed issuers only. No API key needed. " +
      "You do the analysis: the numbers and a review rubric come back, not a written opinion.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US ticker symbol, e.g. 'HOOD', 'COIN', 'AAPL'" },
        periods: { type: "number", description: "How many recent periods per metric (default 6, max 12)" },
      },
      required: ["ticker"],
    },
  },
];

const Schema = z.object({
  ticker: z.string().min(1).max(10),
  periods: z.number().int().min(1).max(12).optional(),
});

type Fact = { end: string; start?: string; val: number; form: string; fy?: number; fp?: string };

function fmtMoney(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(2)}`;
}

/**
 * XBRL reports the same tag as both a quarterly and a cumulative figure for the
 * same period end. Treating them as one series silently triples a quarter, so
 * classify by the reported span before anything else touches the numbers.
 */
function spanKind(f: Fact): "quarter" | "ytd" | "annual" | "point" {
  if (!f.start) return "point";
  const days = Math.round((Date.parse(f.end) - Date.parse(f.start)) / 86_400_000);
  if (days <= 110) return "quarter";
  if (days <= 300) return "ytd";
  return "annual";
}

async function secJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function resolveCik(ticker: string): Promise<{ cik: string; name: string } | null> {
  const data = await secJson(SEC_TICKERS);
  if (!data) return null;
  const up = ticker.trim().toUpperCase();
  const hit = Object.values<any>(data).find((x) => String(x.ticker).toUpperCase() === up);
  if (!hit) return null;
  return { cik: String(hit.cik_str).padStart(10, "0"), name: hit.title };
}

/**
 * Live quote. Best-effort — fundamentals stand on their own without it.
 *
 * `meta.chartPreviousClose` is the close BEFORE THE REQUESTED RANGE BEGINS, not
 * the previous session. Reading it off a multi-day range reports a multi-day
 * move as a one-day move: on 2026-07-22 HOOD sat at $106.71 against a genuine
 * prior close of $106.36 (+0.33%), but a `range=5d` request returns $115.54 —
 * the close six sessions back — for a headline of -7.6% that never happened.
 *
 * `regularMarketPreviousClose` is absent from this endpoint, so the previous
 * close is taken from the daily bar series instead: walk back past today's
 * still-forming bar and use the last completed session. That is derived from
 * the data rather than from a field whose meaning shifts with the query.
 */
async function liveQuote(
  ticker: string
): Promise<{ price: number; prevClose: number; prevDate: string; currency: string } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) }
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    const r = j?.chart?.result?.[0];
    const m = r?.meta;
    if (!m?.regularMarketPrice) return null;

    const stamps: number[] = r?.timestamp ?? [];
    const closes: Array<number | null> = r?.indicators?.quote?.[0]?.close ?? [];
    const bars = stamps
      .map((t, i) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter((b): b is { day: string; close: number } => typeof b.close === "number");

    // The bar covering the quote's own timestamp is today's, still forming.
    const today = new Date((m.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);
    const completed = bars.filter((b) => b.day !== today);
    const prev = completed[completed.length - 1];
    if (!prev) return null;

    return { price: m.regularMarketPrice, prevClose: prev.close, prevDate: prev.day, currency: m.currency ?? "USD" };
  } catch {
    return null;
  }
}

export async function handleEquityTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "stock_fundamentals") return null;

  const parsed = Schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `Invalid input: ${parsed.error.issues[0].message}` }], isError: true };
  }
  const ticker = parsed.data.ticker.trim().toUpperCase();
  const periods = parsed.data.periods ?? 6;

  const company = await resolveCik(ticker);
  if (!company) {
    return {
      content: [{
        type: "text",
        text:
          `No SEC filer found for **${ticker}**. This covers US-listed issuers that file with the SEC — ` +
          `foreign private issuers, private companies and ETFs may be absent. Check the symbol.`,
      }],
      isError: true,
    };
  }

  // SEC asks for no more than 10 requests a second, and the candidate tags push
  // the count past that if they all go out at once.
  const jobs = CONCEPTS.flatMap((c) => c.tags.map((tag) => ({ key: c.key, tag })));
  const raw: any[] = [];
  for (let i = 0; i < jobs.length; i += 6) {
    raw.push(...(await Promise.all(jobs.slice(i, i + 6).map((j) => secJson(SEC_CONCEPT(company.cik, j.tag))))));
  }
  const quote = await liveQuote(ticker);

  // Per concept, keep the candidate tag whose reported periods run latest.
  const chosen = new Map<string, { tag: string; facts: Fact[]; latest: string }>();
  jobs.forEach((j, i) => {
    const data = raw[i];
    if (!data?.units) return;
    const unitKey = Object.keys(data.units)[0];
    const facts: Fact[] = (data.units[unitKey] ?? []).filter((f: Fact) => f.form === "10-Q" || f.form === "10-K");
    if (!facts.length) return;
    const latest = facts.reduce((m: string, f: Fact) => (f.end > m ? f.end : m), "");
    const prev = chosen.get(j.key);
    if (!prev || latest > prev.latest) chosen.set(j.key, { tag: j.tag, facts, latest });
  });

  const lines: string[] = [
    `# ${company.name} (${ticker}) — as filed with the SEC`,
    ``,
    `CIK ${company.cik} · source: SEC EDGAR XBRL (10-Q / 10-K)`,
  ];

  if (quote) {
    const chg = ((quote.price - quote.prevClose) / quote.prevClose) * 100;
    lines.push(
      ``,
      // The prior close is dated, so a stale or holiday-shifted comparison is
      // visible in the output rather than silently read as a one-day move.
      `**Live quote:** ${quote.currency} ${quote.price.toFixed(2)} ` +
        `(${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% vs ${quote.prevDate} close ${quote.prevClose.toFixed(2)})`
    );
  } else {
    lines.push(``, `_Live quote unavailable — fundamentals below are unaffected._`);
  }

  const quarterly: Record<string, Fact[]> = {};
  const annual: Record<string, Fact[]> = {};

  const usedTags: string[] = [];

  CONCEPTS.forEach((c) => {
    const pick = chosen.get(c.key);
    if (!pick) return;
    usedTags.push(`${c.label} → \`${pick.tag}\``);
    const facts = pick.facts;
    // A period appears in more than one filing — the current 10-Q also carries
    // last year's comparative. Without deduping by period end the same quarter
    // is listed twice and the YoY lookup lands on a duplicate instead of the
    // year-ago quarter, silently reporting ~0% growth.
    const dedupe = (rows: Fact[]): Fact[] => {
      const byEnd = new Map<string, Fact>();
      for (const f of rows) {
        const prev = byEnd.get(f.end);
        // Prefer the original filing (earliest fy) so the label matches the period.
        if (!prev || (f.fy ?? 0) < (prev.fy ?? 0)) byEnd.set(f.end, f);
      }
      return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
    };

    if (c.kind === "stock") {
      annual[c.key] = dedupe(facts).slice(-periods);
    } else {
      quarterly[c.key] = dedupe(facts.filter((f) => spanKind(f) === "quarter")).slice(-periods);
      annual[c.key] = dedupe(facts.filter((f) => spanKind(f) === "annual")).slice(-periods);
    }
  });

  const render = (tag: string, label: string, kind: string, rows: Fact[]) => {
    if (!rows?.length) return;
    lines.push(``, `### ${label}`);
    for (const f of rows) {
      const v = kind === "pershare" ? `$${f.val.toFixed(2)}` : fmtMoney(f.val);
      lines.push(`- ${f.end} — **${v}**${f.fy ? ` _(${f.form} FY${f.fy}${f.fp && f.fp !== "FY" ? " " + f.fp : ""})_` : ""}`);
    }
    // YoY against the same quarter a year earlier, matched by DATE rather than
    // by position — periods are often missing, so counting back N rows can
    // silently compare against the wrong quarter.
    if (kind === "flow" && rows.length >= 2) {
      const latest = rows[rows.length - 1];
      const target = new Date(latest.end);
      target.setFullYear(target.getFullYear() - 1);
      const yearAgo = rows.find(
        (r) => Math.abs(Date.parse(r.end) - target.getTime()) < 20 * 86_400_000
      );
      if (yearAgo?.val && yearAgo.end !== latest.end) {
        const g = ((latest.val - yearAgo.val) / Math.abs(yearAgo.val)) * 100;
        lines.push(`- **YoY (${yearAgo.end} → ${latest.end}): ${g >= 0 ? "+" : ""}${g.toFixed(1)}%**`);
      }
    }
  };

  lines.push(``, `---`, ``, `## Quarterly (each figure is a single quarter, not year-to-date)`);
  for (const c of CONCEPTS) {
    if (c.kind === "stock") continue;
    render(c.key, c.label, c.kind, quarterly[c.key]);
  }

  lines.push(``, `---`, ``, `## Annual & balance sheet`);
  for (const c of CONCEPTS) render(c.key, c.label + (c.kind === "stock" ? " (period end)" : " — annual"), c.kind, annual[c.key]);

  // Per-share figures are filed as-reported for their period and are NOT
  // restated for later splits. NVDA's annual EPS runs $11.93 → $2.94 across the
  // 10-for-1 of June 2024, which reads as a 75% earnings collapse in the same
  // year revenue grew 114%. The split is discoverable — it is an 8-K item 5.03 —
  // but only if the reader thinks to look, so the discontinuity is named here
  // instead of left as a trap. Detected by direction: a per-share series moving
  // hard against net income over the same periods is a share-count event, not
  // an earnings event.
  const splitWarnings: string[] = [];
  for (const [label, eps, profit] of [
    ["quarterly", quarterly["eps"], quarterly["netIncome"]],
    ["annual", annual["eps"], annual["netIncome"]],
  ] as const) {
    for (let i = 1; i < (eps?.length ?? 0); i++) {
      const [prev, cur] = [eps![i - 1], eps![i]];
      if (!prev.val || !cur.val || prev.val <= 0 || cur.val <= 0) continue;
      const epsChange = (cur.val - prev.val) / prev.val;
      const ni = profit?.find((f) => f.end === cur.end);
      const niPrev = profit?.find((f) => f.end === prev.end);
      if (!ni?.val || !niPrev?.val || niPrev.val <= 0) continue;
      const niChange = (ni.val - niPrev.val) / niPrev.val;
      // EPS down hard while profit held or grew (or the mirror image).
      if ((epsChange < -0.4 && niChange > -0.1) || (epsChange > 0.6 && niChange < 0.1)) {
        // Shares = income / EPS, so the implied share-count change is
        // (income ratio) x (EPS ratio inverted). The raw EPS ratio alone
        // conflates the split with the earnings move and understates it —
        // NVDA's 10-for-1 reads as 4:1 until the income growth is divided out.
        const shareRatio = (ni.val / niPrev.val) * (prev.val / cur.val);
        const asSplit =
          shareRatio >= 1.5
            ? `${shareRatio.toFixed(1)}-for-1`
            : shareRatio <= 0.67
              ? `1-for-${(1 / shareRatio).toFixed(1)} reverse`
              : null;
        splitWarnings.push(
          `- **${label} EPS ${prev.end} → ${cur.end}**: $${prev.val.toFixed(2)} → $${cur.val.toFixed(2)} ` +
            `(${(epsChange * 100).toFixed(0)}%) while net income moved ${(niChange * 100).toFixed(0)}%. ` +
            `Implied share count ×${shareRatio.toFixed(2)}${asSplit ? ` — consistent with a ${asSplit} split` : ""}, ` +
            `not an earnings change. Confirm with \`stock_events\` (8-K item 5.03) before comparing these two periods.`
        );
      }
    }
  }
  if (splitWarnings.length) {
    lines.push(
      ``,
      `---`,
      ``,
      `## ⚠️ Per-share figures are not split-adjusted`,
      ``,
      ...splitWarnings,
      ``,
      `Revenue, income and balance-sheet lines are unaffected — only per-share values are.`
    );
  }

  // Margins, computed rather than asserted.
  const rev = quarterly["revenue"]?.slice(-1)[0];
  const ni = quarterly["netIncome"]?.slice(-1)[0];
  const oi = quarterly["opIncome"]?.slice(-1)[0];
  if (rev?.val) {
    lines.push(``, `---`, ``, `## Computed margins — latest quarter (${rev.end})`);
    if (oi) lines.push(`- Operating margin: **${((oi.val / rev.val) * 100).toFixed(1)}%**`);
    if (ni) lines.push(`- Net margin: **${((ni.val / rev.val) * 100).toFixed(1)}%**`);
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## How to analyse this`,
    ``,
    `**Trajectory** — is revenue growth accelerating or decelerating? Compare the last 4 quarters ` +
      `sequentially, then against the same quarter a year earlier. Say which, and by how much.`,
    ``,
    `**Quality of earnings** — is net income tracking operating income, or driven by items below ` +
      `the operating line? A widening gap deserves an explanation.`,
    ``,
    `**Balance sheet** — equity vs liabilities trend, and whether cash covers near-term obligations.`,
    ``,
    `**What these numbers cannot tell you** — guidance, competitive position, regulatory exposure, ` +
      `insider activity, and anything after the last filing date above. Say so explicitly rather ` +
      `than inferring it. For sentiment and post-filing developments, run \`deep_research\`.`,
    ``,
    `Cite the period end for every figure you use. Do not annualise a quarter without labelling it ` +
      `as your own extrapolation. If a metric is missing above, the company did not file that tag — ` +
      `do not substitute an estimate.`,
    ``,
    // Issuers tag the same concept differently, so naming the tag behind each
    // series makes the figures checkable against EDGAR rather than trusted.
    `_XBRL concepts used: ${usedTags.join(" · ")}_`,
    ``,
    `_Figures are as filed with the SEC. Not investment advice._`
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: buildStockFundamentals(ticker, company.name ?? null, company.cik ?? null, quote, quarterly, annual),
  };
}
