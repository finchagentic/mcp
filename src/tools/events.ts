// Material events from SEC Form 8-K.
//
// Companies must file an 8-K within four business days of a material event, and
// each one is tagged with standardised item codes. The codes are where the
// signal lives — and where it hides, because "Item 5.02" means nothing to a
// reader who has not memorised the schedule. This decodes them.
//
// The item codes come straight from the submissions index, so building a
// timeline costs one request rather than one per filing.

import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";

const SEC_UA = "Finch MCP research (contact: support@finchagentic.com)";

/** 8-K item codes. `signal` marks the ones that usually move a thesis. */
const ITEMS: Record<string, { label: string; signal: boolean }> = {
  "1.01": { label: "Entered a material agreement", signal: true },
  "1.02": { label: "Terminated a material agreement", signal: true },
  "1.03": { label: "Bankruptcy or receivership", signal: true },
  "2.01": { label: "Completed an acquisition or disposal of assets", signal: true },
  "2.02": { label: "Results of operations — earnings release", signal: true },
  "2.03": { label: "Took on debt or an off-balance-sheet obligation", signal: true },
  "2.04": { label: "Debt acceleration or default triggered", signal: true },
  "2.05": { label: "Restructuring / exit costs (often layoffs or closures)", signal: true },
  "2.06": { label: "Material impairment (asset written down)", signal: true },
  "3.01": { label: "Delisting notice or listing-rule failure", signal: true },
  "3.02": { label: "Unregistered equity sale — dilution", signal: true },
  "3.03": { label: "Material change to shareholder rights", signal: true },
  "4.01": { label: "Changed auditors", signal: true },
  "4.02": { label: "Prior financials no longer reliable — restatement", signal: true },
  "5.01": { label: "Change in control of the company", signal: true },
  "5.02": { label: "Executive or director appointed, departed, or compensated", signal: true },
  "5.03": { label: "Amended charter or bylaws / changed fiscal year", signal: false },
  "5.05": { label: "Amended the code of ethics", signal: false },
  "5.07": { label: "Shareholder vote results", signal: false },
  "7.01": { label: "Regulation FD disclosure (investor-facing statement)", signal: false },
  "8.01": { label: "Other events the company chose to report", signal: false },
  "9.01": { label: "Exhibits attached (accompanies other items)", signal: false },
};

export const EVENT_TOOLS: Tool[] = [
  {
    name: "stock_events",
    description:
      "Timeline of a US company's material events from SEC Form 8-K, with the item codes decoded " +
      "into plain language — earnings releases, executive departures, debt raises, dilution, " +
      "restatements, impairments, layoffs. Companies must file within four business days, so this " +
      "is the fastest authoritative record of what actually happened. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US ticker symbol, e.g. 'HOOD', 'NVDA'" },
        limit: { type: "number", description: "How many recent 8-K filings (default 15, max 40)" },
        signalOnly: {
          type: "boolean",
          description: "Only show filings carrying a thesis-relevant item (skips routine votes/exhibits)",
        },
      },
      required: ["ticker"],
    },
  },
];

const Schema = z.object({
  ticker: z.string().min(1).max(10),
  limit: z.number().int().min(1).max(40).optional(),
  signalOnly: z.boolean().optional(),
});

// Pure map to the stock_events structuredContent payload.
export function buildStockEvents(
  ticker: string,
  companyName: string | null,
  signalOnly: boolean,
  events: ReadonlyArray<{ date: string; reportDate?: string; codes: string[]; hasSignal: boolean; url: string }>,
): Record<string, unknown> {
  return {
    ticker,
    companyName,
    signalOnly,
    count: events.length,
    events: events.map((e) => ({
      filingDate: e.date,
      reportDate: e.reportDate ?? null,
      codes:      e.codes,
      hasSignal:  e.hasSignal,
      url:        e.url,
    })),
  };
}

async function secFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": SEC_UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function handleEventTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "stock_events") return null;

  const parsed = Schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
  }
  const ticker = parsed.data.ticker.trim().toUpperCase();
  const limit = parsed.data.limit ?? 15;
  const signalOnly = parsed.data.signalOnly === true;

  const tickersRaw = await secFetch("https://www.sec.gov/files/company_tickers.json");
  if (!tickersRaw) {
    return { content: [{ type: "text", text: "SEC ticker index unavailable — try again shortly." }], isError: true };
  }
  const hit = Object.values<any>(JSON.parse(tickersRaw)).find((x) => String(x.ticker).toUpperCase() === ticker);
  if (!hit) {
    return {
      content: [{ type: "text", text: `No SEC filer found for **${ticker}**. US-listed SEC filers only.` }],
      isError: true,
    };
  }
  const cik = String(hit.cik_str).padStart(10, "0");

  const subsRaw = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!subsRaw) {
    return { content: [{ type: "text", text: `Could not load SEC filings for ${ticker}.` }], isError: true };
  }
  const subs = JSON.parse(subsRaw);
  const r = subs.filings?.recent;
  if (!r?.form) {
    return { content: [{ type: "text", text: `No filing index for ${ticker}.` }], isError: true };
  }

  type Ev = { date: string; reportDate?: string; codes: string[]; url: string; hasSignal: boolean };
  const events: Ev[] = [];
  const cikNum = String(Number(cik));

  for (let i = 0; i < r.form.length && events.length < limit; i++) {
    if (r.form[i] !== "8-K") continue;
    const codes = String(r.items?.[i] ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const hasSignal = codes.some((c) => ITEMS[c]?.signal);
    if (signalOnly && !hasSignal) continue;
    const acc = String(r.accessionNumber[i]).replace(/-/g, "");
    events.push({
      date: r.filingDate[i],
      reportDate: r.reportDate?.[i],
      codes,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${r.primaryDocument[i]}`,
      hasSignal,
    });
  }

  if (!events.length) {
    return {
      content: [{
        type: "text",
        text:
          `# ${subs.name} (${ticker}) — material events\n\n` +
          (signalOnly
            ? `No 8-K filings with thesis-relevant items in the recent window. Re-run without \`signalOnly\` to see routine filings.`
            : `No 8-K filings found.`),
      }],
      structuredContent: buildStockEvents(ticker, subs.name ?? null, !!signalOnly, events),
    };
  }

  const lines: string[] = [
    `# ${subs.name} (${ticker}) — material events`,
    ``,
    `**${events.length}** Form 8-K filing(s) from SEC EDGAR${signalOnly ? " (thesis-relevant only)" : ""}. ` +
      `Companies must file within four business days of the event.`,
    ``,
  ];

  for (const e of events) {
    const decoded = e.codes.map((c) => ({ code: c, ...(ITEMS[c] ?? { label: "Unclassified item", signal: false }) }));
    const headline = decoded.find((d) => d.signal) ?? decoded[0];
    lines.push(
      `### ${e.hasSignal ? "🔔" : "▫️"} ${e.date}${e.reportDate && e.reportDate !== e.date ? ` _(event ${e.reportDate})_` : ""}`,
      `**${headline?.label ?? "8-K filed"}**`,
      ...decoded
        .filter((d) => d !== headline)
        .map((d) => `- ${d.signal ? "🔔 " : ""}Item ${d.code} — ${d.label}`),
      `${e.url}`,
      ``
    );
  }

  lines.push(
    `---`,
    ``,
    `## How to read this`,
    ``,
    `- 🔔 marks items that usually move a thesis. ▫️ items (shareholder votes, exhibit lists, ` +
      `Reg FD statements) are filed constantly and are mostly noise.`,
    `- **Item 5.02 is ambiguous by design** — it covers a resignation, a firing, a new hire and a ` +
      `pay change with the same code. Open the filing before concluding which one it was.`,
    `- **4.02 is the loudest code here**: prior financial statements can no longer be relied on. ` +
      `Treat any fundamentals you already pulled as suspect until the restatement lands.`,
    `- An 8-K states that something happened, not whether it was good. The filing text carries the ` +
      `detail; the item code only tells you where to look.`,
    ``,
    `_Source: SEC EDGAR Form 8-K. Not investment advice._`
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: buildStockEvents(ticker, subs.name ?? null, !!signalOnly, events),
  };
}
