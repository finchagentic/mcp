// Regression: a legacy XBRL tag must never outrank a live one.
//
// Issuers change the concept they report under. Apple abandoned `Revenues` at
// the ASC 606 transition, so querying that tag alone returns its pre-2019
// figures — which then render as the current picture, correctly formatted and
// years out of date. The failure is silent and company-dependent: HOOD and NVDA
// still use `Revenues`, so a spot check on either one proves nothing.

import { describe, it, expect, afterEach, vi } from "vitest";
import { handleEquityTool } from "../src/tools/equity.js";

const secOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const missing = () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response;

const TICKERS = { "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } };

const q = (start: string, end: string, val: number, fy: number, fp: string) => ({
  start,
  end,
  val,
  form: "10-Q",
  fy,
  fp,
});

/** The dead tag: real data, but it stops in 2018. */
const LEGACY_REVENUES = {
  units: {
    USD: [
      q("2018-04-01", "2018-06-30", 53_265_000_000, 2018, "Q3"),
      q("2018-07-01", "2018-09-29", 62_900_000_000, 2018, "Q4"),
    ],
  },
};

/** The live tag Apple actually reports under today. */
const LIVE_REVENUES = {
  units: {
    USD: [
      q("2024-12-29", "2025-03-29", 95_359_000_000, 2025, "Q2"),
      q("2025-12-28", "2026-03-28", 111_180_000_000, 2026, "Q2"),
    ],
  },
};

function stub({ legacy = LEGACY_REVENUES, live = LIVE_REVENUES }: { legacy?: unknown; live?: unknown } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("company_tickers.json")) return secOk(TICKERS);
      if (url.includes("/us-gaap/Revenues.json")) return legacy ? secOk(legacy) : missing();
      if (url.includes("RevenueFromContractWithCustomerExcludingAssessedTax")) return live ? secOk(live) : missing();
      return missing();
    })
  );
}

describe("stock_fundamentals — XBRL tag selection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers the tag whose data runs latest, not the first tag in the list", async () => {
    stub();
    const res = await handleEquityTool("stock_fundamentals", { ticker: "AAPL" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    expect(text).toContain("2026-03-28");
    expect(text).toContain("$111.18B");
    // The eight-year-old series must not appear at all.
    expect(text).not.toContain("2018-09-29");
    expect(text).not.toContain("$62900M");
  });

  it("names the tag behind the figures so they can be checked against EDGAR", async () => {
    stub();
    const res = await handleEquityTool("stock_fundamentals", { ticker: "AAPL" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    expect(text).toContain("XBRL concepts used");
    expect(text).toContain("RevenueFromContractWithCustomerExcludingAssessedTax");
  });

  it("still falls back to the legacy tag when it is the only one filed", async () => {
    stub({ live: null });
    const res = await handleEquityTool("stock_fundamentals", { ticker: "AAPL" });
    const text = res?.content[0]?.type === "text" ? res.content[0].text : "";

    // Old data is correct output for a company that filed nothing newer; the
    // rule is "freshest wins", not "never show old".
    expect(text).toContain("2018-09-29");
    expect(text).toContain("Revenue → `Revenues`");
  });
});
