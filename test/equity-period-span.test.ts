// Regression: a quarter is not a year-to-date figure, and year-over-year must
// be matched by DATE.
//
// XBRL reports the same tag over several spans ending on the same day: a single
// quarter, the cumulative year-to-date, and the full year. Mixing them inflates
// a quarter by up to 4x while every label still reads "Q". Separately, taking
// the year-ago figure by counting back N rows lands on the wrong quarter as
// soon as one period is missing from the filings — which is common.

import { describe, it, expect, afterEach, vi } from "vitest";
import { handleEquityTool } from "../src/tools/equity.js";

const secOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const missing = () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response;

const TICKERS = { "0": { cik_str: 1783879, ticker: "HOOD", title: "Robinhood Markets, Inc." } };

const fact = (start: string, end: string, val: number, form: string, fy: number, fp: string) => ({
  start,
  end,
  val,
  form,
  fy,
  fp,
});

/**
 * Three rows end 2026-03-31; only the 90-day one is a quarter.
 *
 * The cumulative rows deliberately come FIRST. Dedupe keys by period end, so
 * with the span filter removed it keeps whichever row it met first — an
 * ordering that would let a quarter survive by luck rather than by rule. Listing
 * the year-to-date ahead of the quarter makes the span filter the only thing
 * that can produce a correct answer.
 */
const MIXED_SPANS = {
  units: {
    USD: [
      fact("2025-01-01", "2025-03-31", 800_000_000, "10-Q", 2025, "Q1"), // year-ago quarter
      fact("2025-04-01", "2026-03-31", 4_000_000_000, "10-K", 2026, "FY"), // full year
      fact("2025-10-01", "2026-03-31", 1_900_000_000, "10-Q", 2026, "Q1"), // year-to-date
      fact("2026-01-01", "2026-03-31", 1_000_000_000, "10-Q", 2026, "Q1"), // quarter
    ],
  },
};

function stub(units: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return secOk(TICKERS);
      if (url.includes("/us-gaap/Revenues.json")) return secOk(units);
      return missing();
    })
  );
}

async function run() {
  const res = await handleEquityTool("stock_fundamentals", { ticker: "HOOD" });
  return res?.content[0]?.type === "text" ? res.content[0].text : "";
}

describe("stock_fundamentals — period spans", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the single quarter and excludes the year-to-date figure ending the same day", async () => {
    stub(MIXED_SPANS);
    const text = await run();

    const quarterly = text.split("## Annual & balance sheet")[0];
    expect(quarterly).toContain("$1.00B"); // the true quarter
    expect(quarterly).not.toContain("$1.90B"); // YTD must never appear as a quarter
    expect(quarterly).not.toContain("$4.00B"); // nor the full year
  });

  it("reports the full year under annual, not under quarterly", async () => {
    stub(MIXED_SPANS);
    const text = await run();

    const annual = text.split("## Annual & balance sheet")[1] ?? "";
    expect(annual).toContain("$4.00B");
  });

  it("computes YoY against the same quarter a year earlier", async () => {
    stub(MIXED_SPANS);
    const text = await run();

    // 800M → 1.00B is +25.0%. Comparing against the YTD row would give -47%.
    expect(text).toContain("YoY (2025-03-31 → 2026-03-31): +25.0%");
  });

  it("skips YoY rather than comparing against the wrong quarter when the year-ago period is absent", async () => {
    stub({
      units: {
        USD: [
          fact("2025-07-01", "2025-09-30", 800_000_000, "10-Q", 2025, "Q3"), // two quarters off
          fact("2026-01-01", "2026-03-31", 1_000_000_000, "10-Q", 2026, "Q1"),
        ],
      },
    });
    const text = await run();

    expect(text).toContain("$1.00B");
    expect(text).not.toContain("YoY");
  });

  it("does not double-count a quarter that appears in two filings as its own comparative", async () => {
    stub({
      units: {
        USD: [
          fact("2025-01-01", "2025-03-31", 800_000_000, "10-Q", 2025, "Q1"),
          fact("2025-01-01", "2025-03-31", 800_000_000, "10-Q", 2026, "Q1"), // restated copy
          fact("2026-01-01", "2026-03-31", 1_000_000_000, "10-Q", 2026, "Q1"),
        ],
      },
    });
    const text = await run();

    const rows = text.split("\n").filter((l) => l.includes("2025-03-31") && l.includes("$800M"));
    expect(rows).toHaveLength(1);
    expect(text).toContain("+25.0%"); // not 0.0% against the duplicate
  });
});

describe("stock_fundamentals — per-share discontinuities", () => {
  afterEach(() => vi.unstubAllGlobals());

  // NVDA's annual EPS runs $11.93 -> $2.94 across the 10-for-1 of June 2024,
  // which reads as a 75% earnings collapse in a year revenue grew 114%. XBRL
  // files per-share figures as-reported and never restates them, so the series
  // is only safe to compare if the break is named.
  it("flags a split-shaped break and derives the ratio from net income", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("company_tickers.json")) return secOk(TICKERS);
        if (url.includes("/us-gaap/EarningsPerShareDiluted.json")) {
          return secOk({
            units: {
              "USD/shares": [
                fact("2023-01-30", "2024-01-28", 11.93, "10-K", 2024, "FY"),
                fact("2024-01-29", "2025-01-26", 2.94, "10-K", 2025, "FY"),
              ],
            },
          });
        }
        if (url.includes("/us-gaap/NetIncomeLoss.json")) {
          return secOk({
            units: {
              USD: [
                fact("2023-01-30", "2024-01-28", 29_760_000_000, "10-K", 2024, "FY"),
                fact("2024-01-29", "2025-01-26", 72_880_000_000, "10-K", 2025, "FY"),
              ],
            },
          });
        }
        return missing();
      })
    );

    const text = await run();

    expect(text).toContain("not split-adjusted");
    // 2.449x income on 0.246x EPS implies ~10x the shares — the real ratio.
    expect(text).toMatch(/9\.9|10\.0/);
    expect(text).toContain("stock_events");
  });

  it("stays silent when EPS and net income move together", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("company_tickers.json")) return secOk(TICKERS);
        if (url.includes("/us-gaap/EarningsPerShareDiluted.json")) {
          return secOk({
            units: {
              "USD/shares": [
                fact("2024-01-01", "2024-12-31", 1.56, "10-K", 2024, "FY"),
                fact("2025-01-01", "2025-12-31", 2.05, "10-K", 2025, "FY"),
              ],
            },
          });
        }
        if (url.includes("/us-gaap/NetIncomeLoss.json")) {
          return secOk({
            units: {
              USD: [
                fact("2024-01-01", "2024-12-31", 1_410_000_000, "10-K", 2024, "FY"),
                fact("2025-01-01", "2025-12-31", 1_880_000_000, "10-K", 2025, "FY"),
              ],
            },
          });
        }
        return missing();
      })
    );

    expect(await run()).not.toContain("not split-adjusted");
  });
});
