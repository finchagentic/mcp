import { describe, it, expect } from "vitest";
import * as mine from "../src/launchpad-math.js";
// The backend source of truth (sibling repo). Parity = identical output on every input, including identical throws.
import * as be from "../../finchagentic/convex/_launchMath.js";
import * as beR from "../../finchagentic/convex/_launchRecipients.js";

function run<T>(f: () => T): { v?: T; e?: string } {
  try { return { v: f() }; } catch (e: any) { return { e: String(e.message) }; }
}

describe("startTickForFdv parity with backend", () => {
  const fdvs = [0, -1, NaN, Infinity, 1e-30, 1e-9, 0.001, 0.5, 1, 2, 3.7, 5, 10, 25, 50, 123.456, 1000, 5_000, 10_000, 25_000, 100_000, 1e6, 1e9, 1e12, 1e15, 1e20, 1e30];
  const decs = [6, 8, 18];
  it("identical result (or identical error) over a large grid", () => {
    let n = 0;
    for (const f of fdvs) for (const d of decs) {
      expect(run(() => mine.startTickForFdv(f, d)), `fdv=${f} dec=${d}`).toEqual(run(() => be.startTickForFdv(f, d)));
      n++;
    }
    // 500 pseudo-random log-uniform values
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const f = Math.pow(10, -6 + rnd() * 22);
      const d = decs[i % 3];
      expect(run(() => mine.startTickForFdv(f, d))).toEqual(run(() => be.startTickForFdv(f, d)));
      n++;
    }
    expect(n).toBeGreaterThan(550);
  });
  it("constants match", () => {
    expect(mine.TICK_SPACING).toBe(be.TICK_SPACING);
    expect(mine.DEFAULT_SUPPLY_WEI).toBe(be.DEFAULT_SUPPLY_WEI);
  });
  it("known vectors", () => {
    expect(mine.startTickForFdv(10, 18)).toBe(be.startTickForFdv(10, 18));
    expect(mine.startTickForFdv(10_000, 6)).toBe(be.startTickForFdv(10_000, 6));
  });
});

describe("buildRecipients parity with backend", () => {
  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";
  it("identical over the full option grid", () => {
    let n = 0;
    for (const feePct of [0, 1, 3])
      for (const feeTo of ["creator", "burn"] as const)
        for (const budgetWallet of [null, A, B, "0x0000000000000000000000000000000000000000", "nonsense"])
          for (const creator of [A, B, "0x0000000000000000000000000000000000000000"])
            for (const forceCreatorOnly of [undefined, false, true]) {
              const o = { feePct, feeTo, creator, budgetWallet, forceCreatorOnly };
              expect(run(() => mine.buildRecipients(o)), JSON.stringify(o)).toEqual(run(() => beR.buildRecipients(o)));
              n++;
            }
    expect(n).toBe(3 * 2 * 5 * 3 * 3);
  });
  it("assertRecipients parity on bad lists", () => {
    const lists: any[] = [
      [], [{ payout: A, bps: 10_000 }], [{ payout: A, bps: 5000 }, { payout: A, bps: 5000 }],
      [{ payout: A, bps: 9000 }], [{ payout: A, bps: 9000 }, { payout: B, bps: 1001 }],
      [{ payout: A, bps: 0 }, { payout: B, bps: 10_000 }], [{ payout: A, bps: 1.5 }, { payout: B, bps: 9998.5 }],
      Array.from({ length: 8 }, (_, i) => ({ payout: "0x" + String(i + 1).repeat(40), bps: 1250 })),
    ];
    for (const l of lists) expect(run(() => mine.assertRecipients(l))).toEqual(run(() => beR.assertRecipients(l)));
  });
  it("constants match", () => {
    expect([mine.AGENT_BPS, mine.CREATOR_BPS, mine.BPS_TOTAL, mine.MAX_RECIPIENTS, mine.DEAD]).toEqual([beR.AGENT_BPS, beR.CREATOR_BPS, beR.BPS_TOTAL, beR.MAX_RECIPIENTS, beR.DEAD]);
  });
});
