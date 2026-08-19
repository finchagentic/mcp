// Onchain safety scan (Blockscout + DexScreener; free, no LLM) — powers
// rh_safety_check.

import { RH_BLOCKSCOUT_V2, RH_EXPLORER } from "./rh-mcp-constants.js";
import type { DexPair, ResolvedToken } from "./rh-mcp-dex.js";

export interface RhSafety {
  verified: boolean | null;
  contractName: string | null;
  reputation: string | null;
  holdersCount: number | null;
  creator: string | null;
  launchpad: RhLaunchpad | null;
}

// Factory address → launchpad. Keyed lowercase. Only put an entry here once the
// factory has been read off-chain on 4663 — a wrong mapping silently mislabels
// every token a factory ever deployed.
// Observed empirically by sampling recent deployments, not taken from docs.
// Add an entry only after seeing the factory actually deploy a live token.
const LAUNCHPAD_FACTORIES: Record<string, { label: string; note?: string }> = {
  "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": {
    label: "Pons",
    note: "PonsLaunchFactory — the dominant launchpad on this chain",
  },
  "0x1b37d3a72082029c44b35b604ea473617580b69a": {
    label: "Doppler (Whetstone)",
    note: "Bankr routes launches through Doppler — a Doppler factory alone does not prove a Bankr launch",
  },
  "0x120caef934797423479fcd0c5d71d36b0282736e": {
    label: "Unverified factory (MemeSoft tokens)",
    note: "Deploys contracts named MemeSoft; operator not yet identified — treat as unbranded",
  },
};

// Fallback when the factory address is unknown but its contract is verified and named.
const LAUNCHPAD_NAME_HINTS: Array<[RegExp, string]> = [
  [/pons/i, "Pons"],
  [/doppler/i, "Doppler (Whetstone)"],
  [/bankr/i, "Bankr"],
  [/\bnox\b|noxa/i, "Noxa"],
  [/clanker/i, "Clanker"],
  [/virtuals?/i, "Virtuals"],
  [/flap/i, "Flap"],
  [/memesoft/i, "MemeSoft"],
];

export interface RhLaunchpad {
  label: string;
  factory: string | null;
  factoryName: string | null;
  confidence: "confirmed" | "likely" | "unknown" | "self-deployed";
  note?: string;
}

async function detectLaunchpad(creator: string | null): Promise<RhLaunchpad | null> {
  if (!creator) return null;

  const known = LAUNCHPAD_FACTORIES[creator.toLowerCase()];
  if (known) {
    return { label: known.label, factory: creator, factoryName: null, confidence: "confirmed", note: known.note };
  }

  let isContract = false;
  let factoryName: string | null = null;
  try {
    const r = await fetch(`${RH_BLOCKSCOUT_V2}/addresses/${creator}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const c: any = await r.json();
      isContract = c?.is_contract === true;
      factoryName = c?.name ?? null;
    }
  } catch {
    /* fall through to unknown */
  }

  if (!isContract) {
    return { label: "None — self-deployed", factory: creator, factoryName: null, confidence: "self-deployed" };
  }

  const hit = factoryName ? LAUNCHPAD_NAME_HINTS.find(([re]) => re.test(factoryName!)) : undefined;
  if (hit) return { label: hit[1], factory: creator, factoryName, confidence: "likely" };

  return { label: "Unrecognized factory", factory: creator, factoryName, confidence: "unknown" };
}

export async function blockscoutSafety(address: string): Promise<RhSafety> {
  const out: RhSafety = {
    verified: null,
    contractName: null,
    reputation: null,
    holdersCount: null,
    creator: null,
    launchpad: null,
  };
  try {
    const r = await fetch(`${RH_BLOCKSCOUT_V2}/tokens/${address}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const t: any = await r.json();
      out.reputation = t?.reputation ?? null;
      out.holdersCount = t?.holders_count != null ? Number(t.holders_count) : null;
    }
  } catch {
    /* ignore */
  }
  // Use /addresses/{ca} (~1KB) NOT /smart-contracts/{ca} — the latter ships the
  // entire Solidity source and intermittently returns a truncated body on HTTP 200,
  // which silently nulled contractName and skipped the launchpad/privilege flags.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${RH_BLOCKSCOUT_V2}/addresses/${address}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (r.ok) {
        const c: any = await r.json();
        out.verified = c?.is_verified ?? null;
        out.contractName = c?.name ?? null;
        out.creator = c?.creator_address_hash ?? null;
        break;
      }
      if (r.status === 404) {
        out.verified = false; // address has no contract record
        break;
      }
    } catch {
      /* retry once */
    }
  }
  out.launchpad = await detectLaunchpad(out.creator);
  return out;
}

export function assessSafety(
  safety: RhSafety,
  dex: DexPair | null
): { score: number; tier: string; flags: string[] } {
  let score = 0;
  const flags: string[] = [];

  if (safety.verified === false) { score += 20; flags.push("🔴 Contract NOT verified on explorer"); }
  else if (safety.verified === true) { flags.push("🟢 Contract verified"); }
  else { flags.push("⚪ Verification unknown"); }

  const rep = (safety.reputation ?? "").toLowerCase();
  if (rep && rep !== "ok" && rep !== "neutral") { score += 30; flags.push(`🔴 Explorer reputation: "${safety.reputation}"`); }
  else if (rep) { flags.push(`🟢 Explorer reputation: ${safety.reputation}`); }

  if (safety.holdersCount != null) {
    if (safety.holdersCount < 25) { score += 25; flags.push(`🔴 Very few holders (${safety.holdersCount}) — high concentration / rug risk`); }
    else if (safety.holdersCount < 200) { score += 12; flags.push(`🟠 Few holders (${safety.holdersCount})`); }
    else { flags.push(`🟢 Holders: ${safety.holdersCount.toLocaleString()}`); }
  } else {
    flags.push("⚪ Holder count unavailable");
  }

  const nm = (safety.contractName ?? "").toLowerCase();
  if (/mint|burn|blacklist|pausable|pause|ownable|\btax\b|\bfee\b/.test(nm)) {
    score += 14;
    flags.push(`🟠 Contract name implies owner privileges ("${safety.contractName}") — possible mint/burn/blacklist/tax; verify source before trusting`);
  }

  // On Robinhood Chain essentially every token ships through a launchpad
  // (Pons, Bankr/Doppler, Flap, Virtuals…), so a launchpad deploy is the NORM,
  // not a red flag — scoring it as risk penalised every normal token and made
  // the number stop discriminating. The anomaly here is the opposite: a token
  // deployed straight from an EOA answers to no launchpad rules, and the
  // deployer keeps full control of supply and liquidity.
  const lp = safety.launchpad;
  if (lp?.confidence === "confirmed" || lp?.confidence === "likely") {
    flags.push(
      `🟢 Launched via ${lp.label}${lp.confidence === "likely" ? " (probable)" : ""} — standard for this chain` +
        (lp.note ? ` · ${lp.note}` : "")
    );
  } else if (lp?.confidence === "unknown") {
    score += 10;
    flags.push(
      `🟠 Deployed by an unrecognized factory (\`${lp.factory}\`) — not a known launchpad on this chain; verify who runs it`
    );
  } else if (lp?.confidence === "self-deployed") {
    score += 18;
    flags.push(
      `🔴 Self-deployed from an EOA (\`${lp.factory}\`) — no launchpad rules apply. ` +
        `Unusual on this chain: the deployer retains full control over supply and liquidity`
    );
  }

  if (dex) {
    const buys = dex.txns?.h24?.buys ?? 0;
    const sells = dex.txns?.h24?.sells ?? 0;
    if (buys > 5 && sells === 0) { score += 30; flags.push(`🔴 Honeypot suspicion: ${buys} buys but 0 sells in 24h — may be unsellable`); }
    else if (sells > 0) { flags.push(`🟢 Sellable: ${sells} sell(s) in 24h — holders can exit`); }
  }

  score = Math.min(100, score);
  const tier = score >= 60 ? "🔴 DANGER" : score >= 35 ? "🟠 CAUTION" : score >= 15 ? "🟡 SOME RISK" : "🟢 LOOKS OK";
  return { score, tier, flags };
}

// structuredContent payload for rh_safety_check. `tier` is the assessSafety
// label with its leading emoji stripped so consumers get a clean enum
// ("DANGER"/"CAUTION"/"SOME RISK"/"LOOKS OK") - single source, no threshold
// logic duplicated here.
export function buildRhSafetyStructured(
  r: ResolvedToken,
  safety: RhSafety,
  assessment: { score: number; tier: string; flags: string[] },
): Record<string, unknown> {
  return {
    address:      r.address,
    symbol:       r.symbol ?? null,
    name:         r.name ?? null,
    riskScore:    assessment.score,
    tier:         assessment.tier.replace(/^\S+\s+/, ""),
    verified:     safety.verified,
    contractName: safety.contractName,
    reputation:   safety.reputation,
    holdersCount: safety.holdersCount,
    creator:      safety.creator,
    launchpad:    safety.launchpad,
    flags:        assessment.flags,
  };
}

export function renderSafety(
  r: ResolvedToken,
  safety: RhSafety,
  assessment: { score: number; tier: string; flags: string[] },
): string {
  const { score, tier, flags } = assessment;
  return [
    `## 🛡️ RH Safety Check — ${r.symbol}${r.name ? ` (${r.name})` : ""}`,
    `\`${r.address}\` · chain 4663${safety.contractName ? ` · contract \`${safety.contractName}\`` : ""}`,
    "",
    `### Safety: ${tier} — ${score}/100 risk`,
    ...flags.map((f) => `- ${f}`),
    "",
    `**Onchain data only (Blockscout + DexScreener) — no LLM, no paid API.**`,
    `For market/liquidity read run \`rh_analyze\`; for X/narrative add \`web_search\` or \`deep_research\`.`,
    `**Explorer**: ${RH_EXPLORER}/token/${r.address}`,
    "",
    `_Heuristic — not a full audit. A verified, high-holder, sellable token can still dump. Verify the CA._`,
  ].join("\n");
}
