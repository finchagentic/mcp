// Regression: the day-change must be measured against the PREVIOUS SESSION.
//
// Yahoo's `meta.chartPreviousClose` is the close before the requested range
// begins, not the previous close. Reading it off a multi-day range turns a
// multi-day move into a headline one-day move, and the output looks entirely
// normal while being wrong for every ticker. Locked here because nothing in the
// shape of the response reveals the error — only the arithmetic does.

import { describe, it, expect, afterEach, vi } from "vitest";
import { handleEquityTool } from "../src/tools/equity.js";

const secOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const missing = () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response;

/** Epoch seconds for a US session close, safely mid-day in UTC terms. */
const day = (d: string) => Math.floor(Date.parse(`${d}T20:00:00Z`) / 1000);

const TICKERS = { "0": { cik_str: 1783879, ticker: "HOOD", title: "Robinhood Markets, Inc." } };

/**
 * The real 2026-07-22 numbers. HOOD traded at $106.71 against a genuine prior
 * close of $106.36 — up 0.33%. `chartPreviousClose` reports $115.54, the close
 * six sessions earlier, which renders as -7.64%.
 */
const CHART = {
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: 106.71,
          chartPreviousClose: 115.54,
          regularMarketTime: day("2026-07-22"),
          currency: "USD",
        },
        timestamp: ["2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21", "2026-07-22"].map(day),
        indicators: { quote: [{ close: [106.02, 99.96, 99.28, 106.36, 106.71] }] },
      },
    ],
  },
};

function stub(chart: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return secOk(TICKERS);
      if (url.includes("finance.yahoo.com")) return secOk(chart);
      return missing(); // no XBRL facts — the quote line is what is under test
    })
  );
}

describe("stock_fundamentals — day change", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures against the previous session, not the start of the requested range", async () => {
    stub(CHART);
    const res = await handleEquityTool("stock_fundamentals", { ticker: "HOOD" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    expect(text).toContain("+0.33%");
    expect(text).toContain("106.36");
    // The trap value must not survive anywhere in the output.
    expect(text).not.toContain("115.54");
    expect(text).not.toContain("-7.6");
  });

  it("dates the comparison so a stale basis is visible rather than implied", async () => {
    stub(CHART);
    const res = await handleEquityTool("stock_fundamentals", { ticker: "HOOD" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    expect(text).toContain("vs 2026-07-21 close");
  });

  it("skips the still-forming bar for the current session", async () => {
    // Only one completed session exists before today; it must be the reference.
    stub({
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: 50,
              chartPreviousClose: 999,
              regularMarketTime: day("2026-07-22"),
              currency: "USD",
            },
            timestamp: [day("2026-07-21"), day("2026-07-22")],
            indicators: { quote: [{ close: [40, 50] }] },
          },
        ],
      },
    });
    const res = await handleEquityTool("stock_fundamentals", { ticker: "HOOD" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    expect(text).toContain("+25.00%"); // 40 → 50, not 50 vs 999
    expect(text).not.toContain("999");
  });

  it("omits the quote rather than guessing when no completed session is present", async () => {
    stub({
      chart: {
        result: [
          {
            meta: { regularMarketPrice: 50, chartPreviousClose: 999, regularMarketTime: day("2026-07-22"), currency: "USD" },
            timestamp: [day("2026-07-22")],
            indicators: { quote: [{ close: [50] }] },
          },
        ],
      },
    });
    const res = await handleEquityTool("stock_fundamentals", { ticker: "HOOD" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    expect(text).toContain("Live quote unavailable");
    expect(text).not.toContain("999");
  });
});
