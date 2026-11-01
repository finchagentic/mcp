// Pure launchpad helpers shared by the launchpad_* MCP tools.
//
// startTickForFdv and buildRecipients are byte-for-byte ports of the backend's
// convex/_launchMath.ts and convex/_launchRecipients.ts. They are re-implemented here (instead of trusting the
// backend's prepare response) so the MCP can independently check what it is about to sign: the fee split is
// written into the LaunchLocker forever, so a wrong value is a wrong token forever. test/launchpad-parity.test.ts
// runs both implementations on many inputs and requires identical output.

export const TICK_SPACING = 200;
export const DEFAULT_SUPPLY_WEI = 10n ** 27n; // 1B tokens, 18 decimals
const MIN_USABLE = -Math.floor(887_272 / TICK_SPACING) * TICK_SPACING;
const MAX_USABLE = Math.floor(887_272 / TICK_SPACING) * TICK_SPACING;

/** startTick for a target FDV in whole quote units. Snapped DOWN to the spacing. Throws on nonsense input. */
export function startTickForFdv(fdv: number, quoteDecimals: number, supplyWei: bigint = DEFAULT_SUPPLY_WEI): number {
  if (!(fdv > 0) || !Number.isFinite(fdv)) throw new Error("Starting market cap must be a positive number.");
  const tokensPerQuote = Number(supplyWei) / 1e18 / fdv;
  const rawRatio = tokensPerQuote * Math.pow(10, 18 - quoteDecimals);
  const tick = Math.floor(Math.log(rawRatio) / Math.log(1.0001) / TICK_SPACING) * TICK_SPACING;
  if (!Number.isFinite(tick) || tick <= MIN_USABLE || tick > MAX_USABLE) {
    throw new Error("Starting market cap is outside the supported range.");
  }
  return tick;
}

export const BPS_TOTAL = 10_000;
export const MAX_RECIPIENTS = 7;
export const AGENT_BPS = 9_000;
export const CREATOR_BPS = 1_000;
export const DEAD = "0x000000000000000000000000000000000000dEaD";

export interface Recipient { payout: string; bps: number }

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Throws unless the list satisfies every rule the LaunchLocker enforces (plus a few of ours). */
export function assertRecipients(r: Recipient[]): void {
  if (r.length === 0 || r.length > MAX_RECIPIENTS) throw new Error("Bad recipients: count out of range.");
  let total = 0;
  const seen = new Set<string>();
  for (const x of r) {
    if (!ADDR.test(x.payout)) throw new Error("Bad recipients: invalid address.");
    if (/^0x0{40}$/.test(x.payout)) throw new Error("Bad recipients: zero address.");
    if (!Number.isInteger(x.bps) || x.bps <= 0 || x.bps > BPS_TOTAL) throw new Error("Bad recipients: bps must be a positive integer.");
    const k = x.payout.toLowerCase();
    if (seen.has(k)) throw new Error("Bad recipients: duplicate payout address.");
    seen.add(k);
    total += x.bps;
  }
  if (total !== BPS_TOTAL) throw new Error(`Bad recipients: bps must sum to ${BPS_TOTAL}, got ${total}.`);
}

/** Port of the backend's buildRecipients. */
export function buildRecipients(opts: {
  feePct: number;
  feeTo: "creator" | "burn";
  creator: string;
  budgetWallet: string | null;
  forceCreatorOnly?: boolean;
}): { recipients: Recipient[]; agentFunded: boolean } {
  const { feePct, feeTo, creator, budgetWallet, forceCreatorOnly } = opts;
  if (feePct === 0) return { recipients: [], agentFunded: false };
  if (feeTo === "burn") return { recipients: [{ payout: DEAD, bps: BPS_TOTAL }], agentFunded: false };
  if (forceCreatorOnly) {
    const only = [{ payout: creator, bps: BPS_TOTAL }];
    assertRecipients(only);
    return { recipients: only, agentFunded: false };
  }
  if (!budgetWallet) throw new Error("Agent budget wallet is required to route fees to the agent.");
  const r: Recipient[] = [
    { payout: budgetWallet, bps: AGENT_BPS },
    { payout: creator, bps: CREATOR_BPS },
  ];
  assertRecipients(r);
  return { recipients: r, agentFunded: true };
}
