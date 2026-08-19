// Market risk pre-screen (heuristic, DexScreener data only) — powers
// rh_analyze, rh_token_resolve and rh_mcp_list_stocks rendering.

import { RH_EXPLORER } from "./rh-mcp-constants.js";
import type { DexPair, ResolvedToken } from "./rh-mcp-dex.js";

export function fmtUsd(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  if (!isFinite(v)) return "0";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(2);
}
export function fmtPct(n: number | undefined | null): string {
  if (n == null || !isFinite(n)) return "n/a";
  return (n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
}

export function assessRisk(dex: DexPair): { score: number; tier: string; flags: string[] } {
  let score = 0;
  const flags: string[] = [];
  const liq = dex.liquidity?.usd ?? 0;

  if (liq < 10_000) { score += 40; flags.push(`🔴 Very low liquidity ($${fmtUsd(liq)}) — high slippage & rug risk`); }
  else if (liq < 25_000) { score += 28; flags.push(`🟠 Low liquidity ($${fmtUsd(liq)})`); }
  else if (liq < 100_000) { score += 15; flags.push(`🟡 Moderate liquidity ($${fmtUsd(liq)})`); }
  else { flags.push(`🟢 Liquidity $${fmtUsd(liq)}`); }

  if (dex.pairCreatedAt) {
    const ageH = (Date.now() - dex.pairCreatedAt) / 3_600_000;
    if (ageH < 24) { score += 25; flags.push(`🔴 Very new pair (${ageH.toFixed(0)}h old)`); }
    else if (ageH < 24 * 7) { score += 12; flags.push(`🟠 New pair (${(ageH / 24).toFixed(1)}d old)`); }
    else { flags.push(`🟢 Pair age ${(ageH / 24).toFixed(0)}d`); }
  } else {
    flags.push("⚪ Pair age unknown");
  }

  const vol = dex.volume?.h24 ?? 0;
  const ratio = liq > 0 ? vol / liq : 0;
  if (ratio > 20) { score += 15; flags.push(`🔴 24h volume ${ratio.toFixed(1)}× liquidity — possible wash/hype spike`); }
  else if (ratio > 5) { score += 6; flags.push(`🟠 High turnover (${ratio.toFixed(1)}× liq)`); }

  const buys = dex.txns?.h24?.buys ?? 0;
  const sells = dex.txns?.h24?.sells ?? 0;
  if (buys + sells < 10) { score += 8; flags.push(`🟠 Thin activity (${buys + sells} txns/24h)`); }
  else if (sells > buys * 2) { score += 10; flags.push(`🟠 Sell-heavy (${sells} sells vs ${buys} buys/24h) — distribution`); }

  const ch = dex.priceChange?.h24;
  if (ch != null && Math.abs(ch) > 50) { score += 8; flags.push(`🟠 Volatile: ${fmtPct(ch)} 24h`); }

  const hasSocials = ((dex.info?.socials?.length ?? 0) + (dex.info?.websites?.length ?? 0)) > 0;
  if (!hasSocials) { score += 6; flags.push("🟡 No website/socials listed on DexScreener"); }

  // ── Implausibility checks ────────────────────────────────────────────────
  // A launchpad whitelist ages badly — new platforms appear constantly. These
  // look instead at whether the numbers are internally coherent, which a
  // bundled or honeypot token cannot fake without giving up the illusion.

  // Exit ratio: notional value vs the pool that would have to absorb a sale.
  // A $35M "market cap" sitting on $17K of liquidity is not a market cap —
  // it is a quote nobody can realise.
  const fdv = dex.fdv ?? dex.marketCap ?? 0;
  if (fdv > 0 && liq > 0) {
    const exitRatio = fdv / liq;
    if (exitRatio > 500) {
      score += 22;
      flags.push(
        `🔴 FDV is ${exitRatio.toFixed(0)}× liquidity ($${fmtUsd(fdv)} vs $${fmtUsd(liq)}) — ` +
          `the quoted valuation cannot be exited; treat the price as notional`
      );
    } else if (exitRatio > 100) {
      score += 12;
      flags.push(`🟠 FDV ${exitRatio.toFixed(0)}× liquidity — thin float behind the headline value`);
    }
  }

  // Wash pattern: heavy volume relative to the pool, with buys and sells almost
  // perfectly matched. Organic trading is lopsided; round-tripping is not.
  if (buys > 40 && sells > 40 && liq > 0) {
    const symmetry = Math.abs(buys - sells) / (buys + sells); // 0 = perfectly matched
    if (symmetry < 0.06 && ratio > 3) {
      score += 15;
      flags.push(
        `🔴 Buy/sell almost perfectly matched (${buys}/${sells}) on ${ratio.toFixed(1)}× turnover — ` +
          `consistent with wash trading or a bundled wallet set`
      );
    }
  }

  // Implausibly uniform trade size: many transactions, negligible average value.
  const txCount = buys + sells;
  if (txCount > 100 && vol > 0) {
    const avgTrade = vol / txCount;
    if (avgTrade < 25) {
      score += 10;
      flags.push(
        `🟠 Average trade only $${avgTrade.toFixed(2)} across ${txCount} txns — ` +
          `bot-like churn rather than real participation`
      );
    }
  }

  // Buys with no exits at all is the clearest honeypot tell available here.
  if (buys > 10 && sells === 0) {
    score += 30;
    flags.push(`🔴 ${buys} buys and ZERO sells in 24h — nobody has exited; possible honeypot`);
  }

  score = Math.min(100, score);
  const tier = score >= 70 ? "🔴 EXTREME" : score >= 45 ? "🟠 HIGH" : score >= 25 ? "🟡 MEDIUM" : "🟢 LOWER";
  return { score, tier, flags };
}

export function renderResolveList(query: string, cands: DexPair[]): string {
  const rows = cands.slice(0, 8).map((p, i) =>
    `| ${i === 0 ? "⭐" : " "} | \`${p.baseToken.address}\` | $${fmtUsd(p.liquidity?.usd ?? 0)} | $${fmtUsd(p.volume?.h24 ?? 0)} | ${p.priceUsd ? "$" + p.priceUsd : "?"} |`
  );
  return [
    `## 🔎 RH resolve — "${query}" (${cands.length} match${cands.length === 1 ? "" : "es"})`,
    "",
    "| | Contract | Liquidity | Vol 24h | Price |",
    "|--|----------|-----------|---------|-------|",
    ...rows,
    "",
    `⭐ = highest liquidity. ⚠️ **Tickers can be spoofed** — several tokens may share "${query}". Trade using the exact contract address, never the ticker alone.`,
    "",
    `Next: \`rh_analyze\` the contract, then \`rh_mcp_estimate\` / \`rh_mcp_swap\` with the CA.`,
  ].join("\n");
}

export function renderResolveOne(address: string, dex: DexPair): string {
  const isBase = dex.baseToken.address.toLowerCase() === address.toLowerCase();
  const tok = isBase ? dex.baseToken : dex.quoteToken;
  return [
    `## 🔎 RH token — ${tok.symbol}${tok.name ? ` (${tok.name})` : ""}`,
    `\`${tok.address}\` · chain 4663`,
    "",
    `**Price**: ${dex.priceUsd ? "$" + dex.priceUsd : "?"} · **24h**: ${fmtPct(dex.priceChange?.h24)}`,
    `**Liquidity**: $${fmtUsd(dex.liquidity?.usd ?? 0)} · **Vol 24h**: $${fmtUsd(dex.volume?.h24 ?? 0)}`,
    `**Pair**: ${dex.dexId ?? "uniswap"} · ${RH_EXPLORER}/address/${dex.pairAddress}`,
    "",
    `Next: \`rh_analyze\` for a risk read, then \`rh_mcp_estimate\` / \`rh_mcp_swap\`.`,
  ].join("\n");
}

// structuredContent payload for rh_analyze - mirrors buildRhSafetyStructured:
// `tier` is the assessRisk label with its leading emoji stripped
// ("EXTREME"/"HIGH"/"MEDIUM"/"LOWER"), single source, no thresholds duplicated.
export function buildRhAnalysis(
  r: ResolvedToken,
  dex: DexPair,
  assessment: { score: number; tier: string; flags: string[] },
): Record<string, unknown> {
  return {
    address:      r.address,
    symbol:       r.symbol ?? null,
    name:         r.name ?? null,
    priceUsd:     dex.priceUsd ? Number(dex.priceUsd) : null,
    change1hPct:  dex.priceChange?.h1 ?? null,
    change24hPct: dex.priceChange?.h24 ?? null,
    liquidityUsd: dex.liquidity?.usd ?? null,
    volume24hUsd: dex.volume?.h24 ?? null,
    fdvUsd:       dex.fdv ?? null,
    marketCapUsd: dex.marketCap ?? null,
    buys24h:      dex.txns?.h24?.buys ?? null,
    sells24h:     dex.txns?.h24?.sells ?? null,
    pairAgeDays:  dex.pairCreatedAt ? Math.floor((Date.now() - dex.pairCreatedAt) / 86_400_000) : null,
    riskScore:    assessment.score,
    tier:         assessment.tier.replace(/^\S+\s+/, ""),
    flags:        assessment.flags,
  };
}

// structuredContent payload for rh_mcp_list_stocks - a machine-readable
// mirror of the human table (already filtered by the caller's query).
export function buildRhStocksList(
  rows: ReadonlyArray<{ address: string; symbol: string; name: string }>,
): Record<string, unknown> {
  return {
    count: rows.length,
    stocks: rows.map((s) => ({ symbol: s.symbol, name: s.name, address: s.address })),
  };
}

export function renderAnalysis(
  r: ResolvedToken,
  dex: DexPair,
  assessment: { score: number; tier: string; flags: string[] },
): string {
  const { score, tier, flags } = assessment;
  const ageLine = dex.pairCreatedAt
    ? `**Age**: ${((Date.now() - dex.pairCreatedAt) / 86_400_000).toFixed(1)}d`
    : "**Age**: unknown";
  return [
    `## 🔬 RH Token Analysis — ${r.symbol}${r.name ? ` (${r.name})` : ""}`,
    `\`${r.address}\` · chain 4663`,
    "",
    `**Price**: ${dex.priceUsd ? "$" + dex.priceUsd : "?"} · **24h**: ${fmtPct(dex.priceChange?.h24)} · **1h**: ${fmtPct(dex.priceChange?.h1)}`,
    `**Liquidity**: $${fmtUsd(dex.liquidity?.usd ?? 0)} · **Vol 24h**: $${fmtUsd(dex.volume?.h24 ?? 0)}`,
    `**FDV**: $${fmtUsd(dex.fdv ?? 0)} · **MCap**: $${fmtUsd(dex.marketCap ?? 0)}`,
    `**Txns 24h**: ${dex.txns?.h24?.buys ?? 0} buys / ${dex.txns?.h24?.sells ?? 0} sells · ${ageLine}`,
    "",
    `### Risk: ${tier} — ${score}/100`,
    ...flags.map((f) => `- ${f}`),
    "",
    `**Market data only (DexScreener).** For a full verdict also run:`,
    `- \`audit_contract\` — honeypot / mint authority / owner privileges`,
    `- \`deep_research\` or \`web_scrape\` — X/Twitter sentiment & narrative`,
    "",
    `**Pair chart**: ${RH_EXPLORER}/address/${dex.pairAddress}`,
    "",
    `_Heuristic pre-screen, not financial advice. Thin RH-chain liquidity = elevated rug risk. Verify the contract address before trading._`,
  ].join("\n");
}
