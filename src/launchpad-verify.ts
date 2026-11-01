// Independent verification of the backend's POST /launchpad/prepare response.
// Pure (no network): the on-chain predictToken comparison is done by the caller with `verifyPredictedToken`.
// Anything that deviates from what WE compute from the user's own arguments is refused, and nothing is signed.

import { startTickForFdv, buildRecipients, assertRecipients, type Recipient } from "./launchpad-math.js";

export type LaunchChain = "base" | "robinhood";
export type LaunchQuote = "eth" | "usdg";

export const FACTORY = "0x815542E8b392389A1389E22E588E4B62A67Ade72";
export const LOCKER = "0xcd1680D26922fcd9CabFbb8a56bA40C333fD842a";
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const USDG_RH = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const CHAIN_ID: Record<LaunchChain, number> = { base: 8453, robinhood: 4663 };
export const QUOTES: Record<LaunchChain, Partial<Record<LaunchQuote, { address: string; decimals: number; symbol: string }>>> = {
  base: { eth: { address: NATIVE, decimals: 18, symbol: "ETH" } },
  robinhood: {
    eth: { address: NATIVE, decimals: 18, symbol: "ETH" },
    usdg: { address: USDG_RH, decimals: 6, symbol: "USDG" },
  },
};
export const MAX_LP_FEE = 30_000;

export interface LaunchRequest {
  chain: LaunchChain;
  name: string;      // already trimmed
  symbol: string;    // already trimmed + upper-cased
  quote: LaunchQuote;
  startingMarketCap: number;
  feePct: 0 | 1 | 3;
  feeTo: "creator" | "burn";
}

export interface VerifiedLaunch {
  chain: LaunchChain;
  factory: string;
  locker: string;
  quote: { address: string; decimals: number };
  startTick: number;
  lpFee: number;
  salt: string;
  predictedToken: string;
  metadataURI: string;
  recipients: Recipient[];
  agentFunded: boolean;
  budgetWallet: string | null;
  name: string;
  symbol: string;
}

export class LaunchVerificationError extends Error {
  constructor(msg: string) {
    super(`Refusing to sign — the Finch backend's launch parameters failed independent verification: ${msg} Nothing was signed or sent.`);
    this.name = "LaunchVerificationError";
  }
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const eq = (a: unknown, b: string) => typeof a === "string" && ADDR.test(a) && a.toLowerCase() === b.toLowerCase();
const bad = (m: string): never => { throw new LaunchVerificationError(m); };

export function quoteFor(chain: LaunchChain, quote: LaunchQuote) {
  const q = QUOTES[chain]?.[quote];
  if (!q) throw new Error(`Quote "${quote}" is not available on ${chain}. ${chain === "base" ? "Base supports eth only." : "Robinhood supports eth and usdg."}`);
  return q;
}

/** What the fee split WILL be for these arguments (the caller's wallet is the creator). Used for preview. */
export function describeSplit(feePct: number, feeTo: "creator" | "burn"): string {
  if (feePct === 0) return "no trading fee (0%): nothing is routed to anyone, the AI founder gets no self-funding";
  if (feeTo === "burn") return "trading fees are BURNED (100% to the dead address): the AI founder gets no self-funding";
  return "trading fees split 90% AI founder budget wallet / 10% you (your local wallet) / 0% Finch (permanent, written into the locker at launch)";
}

export function expectedBudgetRouting(req: Pick<LaunchRequest, "feePct" | "feeTo">): boolean {
  return req.feePct !== 0 && req.feeTo !== "burn";
}

/** Verify a prepare response against the user's own arguments. Returns the exact params to launch with. */
export function verifyPrepareResponse(resp: any, req: LaunchRequest, me: string): VerifiedLaunch {
  if (!resp || typeof resp !== "object") bad("empty response.");
  if (!ADDR.test(me)) throw new Error("Local wallet address is invalid.");
  const q = quoteFor(req.chain, req.quote);

  if (resp.chain !== req.chain) bad(`chain is ${JSON.stringify(resp.chain)}, expected ${req.chain}.`);
  if (!eq(resp.launcher, me)) bad(`launcher ${JSON.stringify(resp.launcher)} is not your local wallet ${me}.`);
  if (!eq(resp.factory, FACTORY)) bad(`factory ${JSON.stringify(resp.factory)} is not the known LaunchFactory ${FACTORY}.`);
  if (!eq(resp.locker, LOCKER)) bad(`locker ${JSON.stringify(resp.locker)} is not the known LaunchLocker ${LOCKER}.`);
  if (!resp.quote || !eq(resp.quote.address, q.address) || resp.quote.decimals !== q.decimals) {
    bad(`quote ${JSON.stringify(resp.quote)} does not match ${req.quote} on ${req.chain}.`);
  }
  if (resp.name !== req.name) bad("name differs from what you asked for.");
  if (resp.symbol !== req.symbol) bad("symbol differs from what you asked for.");

  const expectedTick = startTickForFdv(req.startingMarketCap, q.decimals);
  if (!Number.isInteger(resp.startTick) || resp.startTick !== expectedTick) {
    bad(`startTick ${JSON.stringify(resp.startTick)} != locally computed ${expectedTick} (starting market cap ${req.startingMarketCap} ${q.symbol}).`);
  }
  const expectedLpFee = req.feePct * 10_000;
  if (!Number.isInteger(resp.lpFee) || resp.lpFee !== expectedLpFee || resp.lpFee > MAX_LP_FEE) {
    bad(`lpFee ${JSON.stringify(resp.lpFee)} != expected ${expectedLpFee} (${req.feePct}%).`);
  }
  if (typeof resp.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(resp.salt)) bad("salt is not a bytes32.");
  if (typeof resp.predictedToken !== "string" || !ADDR.test(resp.predictedToken)) bad("predictedToken is not an address.");

  // metadataURI must live on the Finch backend under /launchpad/meta/<launcher>/<key> (no foreign host, no userinfo).
  if (typeof resp.metadataURI !== "string" || resp.metadataURI.length > 300) bad("metadataURI missing or too long.");
  let u: URL;
  try { u = new URL(resp.metadataURI); } catch { return bad("metadataURI is not a valid URL."); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) bad("metadataURI must be a plain https URL.");
  if (!new RegExp(`^/launchpad/meta/${me.toLowerCase()}/[0-9a-fA-Fx]{8,80}$`).test(u.pathname)) bad("metadataURI path is not /launchpad/meta/<your wallet>/<key>.");
  const metaHost = u.host.toLowerCase();
  const allowedHost = (process.env.FINCH_LAUNCHPAD_META_HOST ?? new URL(process.env.FINCH_CONVEX_URL ?? "https://valuable-fish-533.convex.site").host).toLowerCase();
  if (metaHost !== allowedHost) bad(`metadataURI host ${metaHost} is not the Finch backend host ${allowedHost}.`);

  // Recipients: EXACTLY the split the user's arguments imply. Anything else (extra recipient, wrong bps/order,
  // a payout that is neither the returned budget wallet nor the local wallet) is refused.
  const routes = expectedBudgetRouting(req);
  let budget: string | null = null;
  if (routes) {
    const bw = resp.budgetWallet;
    if (typeof bw !== "string" || !ADDR.test(bw)) bad("budgetWallet missing/invalid but these arguments route fees to the AI founder.");
    if (/^0x0{40}$/.test(bw) || eq(bw, me) || eq(bw, FACTORY) || eq(bw, LOCKER) || eq(bw, resp.predictedToken) || eq(bw, "0x000000000000000000000000000000000000dEaD")) {
      bad("budgetWallet is a forbidden address (zero/dead/you/factory/locker/token).");
    }
    budget = bw;
  } else if (resp.budgetWallet !== null && resp.budgetWallet !== undefined) {
    bad("backend returned a budgetWallet but these arguments must not route fees to an agent.");
  }
  const expected = buildRecipients({ feePct: req.feePct, feeTo: req.feeTo, creator: me, budgetWallet: budget });
  if (resp.agentFunded !== expected.agentFunded) bad(`agentFunded=${JSON.stringify(resp.agentFunded)}, expected ${expected.agentFunded}.`);
  if (!Array.isArray(resp.recipients)) bad("recipients missing.");
  const got: Recipient[] = resp.recipients;
  if (got.length !== expected.recipients.length) bad(`recipients has ${got.length} entries, expected ${expected.recipients.length}.`);
  expected.recipients.forEach((e, i) => {
    const g = got[i];
    if (!g || typeof g !== "object" || Object.keys(g).sort().join() !== "bps,payout") bad(`recipient #${i} has an unexpected shape.`);
    if (!eq(g.payout, e.payout) || g.bps !== e.bps) {
      bad(`recipient #${i} is ${JSON.stringify(g)}, expected ${e.bps} bps to ${e.payout}.`);
    }
  });
  if (expected.recipients.length > 0) assertRecipients(got);

  return {
    chain: req.chain,
    factory: FACTORY, locker: LOCKER,
    quote: { address: q.address, decimals: q.decimals },
    startTick: expectedTick, lpFee: expectedLpFee,
    salt: resp.salt, predictedToken: resp.predictedToken,
    metadataURI: resp.metadataURI,
    // Build the signed params from OUR expected list (identical to the response by the checks above).
    recipients: expected.recipients.map((r) => ({ payout: r.payout, bps: r.bps })),
    agentFunded: expected.agentFunded, budgetWallet: budget,
    name: req.name, symbol: req.symbol,
  };
}

/** On-chain predictToken(...) result must equal the backend's predictedToken. */
export function verifyPredictedToken(onChain: string, predicted: string): void {
  if (!eq(onChain, predicted)) bad(`factory.predictToken() on-chain returned ${onChain}, backend claimed ${predicted}.`);
}
