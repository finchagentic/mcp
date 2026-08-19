// Insider transactions from SEC Form 4. Two traps handled: (1) filings
// where the company is REPORTING OWNER of another issuer are filtered via
// `issuerTradingSymbol`; (2) code F (tax withholding on RSU vests, no real
// signal) is separated from P/S (actual buy/sell decisions).

import { z } from "zod";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";

const SEC_UA = "Finch MCP research (contact: support@finchagentic.com)";

/** SEC Form 4 transaction codes. Only P and S are discretionary market trades. */
const TX_CODES: Record<string, { label: string; discretionary: boolean }> = {
  P: { label: "Open-market purchase", discretionary: true },
  S: { label: "Open-market sale", discretionary: true },
  A: { label: "Grant / award", discretionary: false },
  M: { label: "Option exercise", discretionary: false },
  F: { label: "Tax withholding on vesting", discretionary: false },
  G: { label: "Gift", discretionary: false },
  C: { label: "Conversion", discretionary: false },
  X: { label: "Option exercise (in/out of money)", discretionary: false },
  D: { label: "Disposition to issuer", discretionary: false },
};

export const INSIDER_TOOLS: Tool[] = [
  {
    name: "stock_insider",
    description:
      "Parse recent SEC Form 4 insider transactions for a US-listed company, straight from EDGAR. " +
      "Separates DISCRETIONARY trades (open-market buys/sells — the ones that carry signal) from " +
      "automatic ones (RSU tax withholding, grants, option exercises) that are routinely misreported " +
      "as 'insider selling'. Also verifies each filing is about the ticker you asked for, since a " +
      "company's feed includes its own stakes in other issuers. No API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US ticker symbol, e.g. 'HOOD', 'NVDA'" },
        limit: { type: "number", description: "How many recent Form 4 filings to parse (default 15, max 40)" },
      },
      required: ["ticker"],
    },
  },
];

const Schema = z.object({
  ticker: z.string().min(1).max(10),
  limit: z.number().int().min(1).max(40).optional(),
});

type Tx = {
  owner: string;
  role: string;
  date: string;
  code: string;
  shares: number;
  price: number;
  value: number;
  heldAfter: number | null;
  acquired: boolean;
  planned: boolean;
};

// Fields the structured builder reads (a structural subset of Tx).
export type InsiderTx = {
  owner: string;
  role: string;
  date: string;
  shares: number;
  price: number;
  value: number;
  heldAfter: number | null;
  acquired: boolean;
  planned: boolean;
};

// Pure map to the stock_insider structuredContent payload - aggregates the
// same discretionary/automatic split the text report shows.
export function buildInsiderSummary(
  ticker: string,
  companyName: string | null,
  filingsParsed: number,
  skippedOtherIssuer: number,
  buys: ReadonlyArray<InsiderTx>,
  sells: ReadonlyArray<InsiderTx>,
  automatic: ReadonlyArray<InsiderTx>,
): Record<string, unknown> {
  const sumV = (arr: ReadonlyArray<InsiderTx>) => arr.reduce((s, t) => s + t.value, 0);
  const sumS = (arr: ReadonlyArray<InsiderTx>) => arr.reduce((s, t) => s + t.shares, 0);
  const discretionary = [...buys, ...sells].sort((a, b) => b.date.localeCompare(a.date));
  return {
    ticker,
    companyName,
    filingsParsed,
    skippedOtherIssuer,
    buys:  { count: buys.length,  shares: sumS(buys),  valueUsd: sumV(buys) },
    sells: { count: sells.length, shares: sumS(sells), valueUsd: sumV(sells) },
    netBuyValueUsd: sumV(buys) - sumV(sells),
    automaticCount: automatic.length,
    transactions: discretionary.slice(0, 12).map((t) => ({
      date:      t.date,
      owner:     t.owner,
      role:      t.role,
      acquired:  t.acquired,
      planned:   t.planned,
      shares:    t.shares,
      priceUsd:  t.price,
      valueUsd:  t.value,
      heldAfter: t.heldAfter,
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

const tag = (xml: string, t: string): string | null => {
  const m = xml.match(new RegExp(`<${t}>([^<]*)</${t}>`));
  return m ? m[1].trim() : null;
};
/** Most Form 4 fields wrap their content in <value>, some do not. */
const tagVal = (xml: string, t: string): string | null => {
  const m = xml.match(new RegExp(`<${t}>\\s*<value>([^<]*)</value>`, "s"));
  return m ? m[1].trim() : tag(xml, t);
};

function fmtUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(a / 1e3).toFixed(0)}K`;
  return `$${a.toFixed(0)}`;
}

export async function handleInsiderTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "stock_insider") return null;

  const parsed = Schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
  }
  const ticker = parsed.data.ticker.trim().toUpperCase();
  const limit = parsed.data.limit ?? 15;

  const tickersRaw = await secFetch("https://www.sec.gov/files/company_tickers.json");
  if (!tickersRaw) return { content: [{ type: "text", text: "SEC ticker index unavailable — try again shortly." }], isError: true };
  const hit = Object.values<any>(JSON.parse(tickersRaw)).find((x) => String(x.ticker).toUpperCase() === ticker);
  if (!hit) {
    return {
      content: [{ type: "text", text: `No SEC filer found for **${ticker}**. US-listed SEC filers only.` }],
      isError: true,
    };
  }
  const cik = String(hit.cik_str).padStart(10, "0");

  const subsRaw = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!subsRaw) return { content: [{ type: "text", text: `Could not load SEC filings for ${ticker}.` }], isError: true };
  const subs = JSON.parse(subsRaw);
  const r = subs.filings?.recent;
  if (!r?.form) return { content: [{ type: "text", text: `No filing index for ${ticker}.` }], isError: true };

  const candidates: Array<{ acc: string; doc: string; date: string }> = [];
  for (let i = 0; i < r.form.length && candidates.length < limit; i++) {
    if (r.form[i] !== "4") continue;
    candidates.push({
      acc: String(r.accessionNumber[i]).replace(/-/g, ""),
      // primaryDocument points at the XSL-rendered view; the raw XML sits
      // beside it without that prefix.
      doc: String(r.primaryDocument[i]).replace(/^xsl[^/]*\//, ""),
      date: r.filingDate[i],
    });
  }

  if (!candidates.length) {
    return { content: [{ type: "text", text: `No Form 4 filings found for **${ticker}**.` }] };
  }

  const cikNum = String(Number(cik));
  const txs: Tx[] = [];
  let skippedOtherIssuer = 0;

  const docs = await Promise.all(
    candidates.map((c) => secFetch(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${c.acc}/${c.doc}`))
  );

  docs.forEach((xml, idx) => {
    if (!xml) return;
    // Guard 1: is this filing actually about the ticker we asked for?
    const issuerSym = tag(xml, "issuerTradingSymbol")?.toUpperCase();
    if (issuerSym && issuerSym !== ticker) {
      skippedOtherIssuer++;
      return;
    }

    const owner = tag(xml, "rptOwnerName") ?? "(unnamed)";
    // A 10b5-1 plan is scheduled in advance, so the sale date carries no view on
    // the price — reporting it as a discretionary decision would misread it.
    const planned = tag(xml, "aff10b5One") === "1" || /10b5-1/i.test(xml);
    const officerTitle = tag(xml, "officerTitle");
    const isDir = tag(xml, "isDirector") === "1";
    const isTen = tag(xml, "isTenPercentOwner") === "1";
    // `officerTitle` is present but empty for non-officers, and `??` only falls
    // back on null/undefined — so directors and 10% owners rendered as "()",
    // dropping the one field that says how much weight the trade carries.
    const role = officerTitle?.trim() || (isDir ? "Director" : isTen ? "10% owner" : "Insider");

    // A filing can carry several transactions; parse each block separately.
    const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];
    for (const b of blocks) {
      const code = tag(b, "transactionCode") ?? "?";
      const shares = Number(tagVal(b, "transactionShares") ?? 0);
      const price = Number(tagVal(b, "transactionPricePerShare") ?? 0);
      const acquired = (tagVal(b, "transactionAcquiredDisposedCode") ?? "") === "A";
      const heldAfterRaw = tagVal(b, "sharesOwnedFollowingTransaction");
      if (!shares) continue;
      txs.push({
        owner,
        role,
        date: tagVal(b, "transactionDate") ?? candidates[idx].date,
        code,
        shares,
        price,
        value: shares * price,
        heldAfter: heldAfterRaw ? Number(heldAfterRaw) : null,
        acquired,
        planned,
      });
    }
  });

  if (!txs.length) {
    return {
      content: [{
        type: "text",
        text:
          `# ${subs.name} (${ticker}) — insider activity\n\n` +
          `Parsed ${candidates.length} Form 4 filings but found no share transactions for ${ticker}` +
          (skippedOtherIssuer ? `; ${skippedOtherIssuer} were about a different issuer.` : `.`),
      }],
      structuredContent: buildInsiderSummary(ticker, subs.name ?? null, candidates.length, skippedOtherIssuer, [], [], []),
    };
  }

  txs.sort((a, b) => b.date.localeCompare(a.date));
  const discretionary = txs.filter((t) => TX_CODES[t.code]?.discretionary);
  const buys = discretionary.filter((t) => t.acquired);
  const sells = discretionary.filter((t) => !t.acquired);
  const automatic = txs.filter((t) => !TX_CODES[t.code]?.discretionary);

  const sum = (arr: Tx[]) => arr.reduce((s, t) => s + t.value, 0);

  const lines: string[] = [
    `# ${subs.name} (${ticker}) — insider activity`,
    ``,
    `Parsed **${candidates.length}** recent Form 4 filings from SEC EDGAR` +
      (skippedOtherIssuer ? ` (${skippedOtherIssuer} skipped — filed about a different issuer)` : ""),
    ``,
    `## Discretionary trades — the ones that carry signal`,
    ``,
    `| | Count | Shares | Value |`,
    `|---|---|---|---|`,
    `| 🟢 Open-market **buys** | ${buys.length} | ${buys.reduce((s, t) => s + t.shares, 0).toLocaleString()} | ${fmtUsd(sum(buys))} |`,
    `| 🔴 Open-market **sells** | ${sells.length} | ${sells.reduce((s, t) => s + t.shares, 0).toLocaleString()} | ${fmtUsd(sum(sells))} |`,
    ``,
  ];

  if (discretionary.length) {
    lines.push(`### Detail`, ``);
    for (const t of discretionary.slice(0, 12)) {
      lines.push(
        `- **${t.date}** · ${t.owner} _(${t.role})_ — ${t.acquired ? "🟢 bought" : "🔴 sold"} ` +
          `${t.planned ? "[10b5-1 plan] " : ""}` +
          `${t.shares.toLocaleString()} @ $${t.price.toFixed(2)} = **${fmtUsd(t.value)}**` +
          (t.heldAfter ? ` · holds ${t.heldAfter.toLocaleString()} after` : "")
      );
    }
    lines.push(``);
  } else {
    lines.push(`_No open-market buys or sells in this window._`, ``);
  }

  if (automatic.length) {
    const byCode: Record<string, { n: number; value: number }> = {};
    for (const t of automatic) {
      const k = t.code;
      byCode[k] = { n: (byCode[k]?.n ?? 0) + 1, value: (byCode[k]?.value ?? 0) + t.value };
    }
    lines.push(
      `## Automatic / non-discretionary — **not** a trading signal`,
      ``,
      ...Object.entries(byCode).map(
        ([code, v]) =>
          `- **${code}** ${TX_CODES[code]?.label ?? "Other"} — ${v.n} transaction(s), ${fmtUsd(v.value)}`
      ),
      ``,
      `These are grants vesting, options exercising, and shares withheld for tax. They happen on a ` +
        `schedule, not on a view. Headlines that call code F "insider selling" are describing payroll.`,
      ``
    );
  }

  lines.push(
    `---`,
    ``,
    `## How to read this`,
    ``,
    `- **Open-market buys are the rarer, stronger signal.** Insiders sell for many reasons — ` +
      `diversification, tax, a house. They buy for one.`,
    `- Weigh the trade against what the person still holds. Selling 5% of a stake differs from exiting.`,
    `- Check role: a CEO or CFO purchase reads differently from a director's.`,
    `- This window covers the last ${candidates.length} Form 4 filings only — it is not the full history, ` +
      `and Form 4s are filed within two business days, so very recent activity may not appear yet.`,
    ``,
    `_Source: SEC EDGAR Form 4. Not investment advice._`
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: buildInsiderSummary(ticker, subs.name ?? null, candidates.length, skippedOtherIssuer, buys, sells, automatic),
  };
}
