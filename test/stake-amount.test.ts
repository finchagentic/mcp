import { describe, it, expect } from "vitest";
import { parseStakeAmount } from "../src/tools/stake.js";

const FINCH = (n: number) => BigInt(n) * 10n ** 18n;

describe("parseStakeAmount", () => {
  const balance = FINCH(1000); // 1000 FINCH available

  it("'all' and 'max' resolve to the full balance", () => {
    expect(parseStakeAmount("all", balance)).toBe(balance);
    expect(parseStakeAmount("max", balance)).toBe(balance);
    expect(parseStakeAmount("ALL", balance)).toBe(balance);
  });

  it("'all'/'max' reject a zero balance rather than staking 0", () => {
    expect(() => parseStakeAmount("all", 0n)).toThrow(/0 FINCH/);
  });

  it("percentage resolves proportionally, including fractional percentages", () => {
    expect(parseStakeAmount("50%", balance)).toBe(FINCH(500));
    expect(parseStakeAmount("100%", balance)).toBe(balance);
    expect(parseStakeAmount("1%", balance)).toBe(FINCH(10));
    // 0.5% of 1000 FINCH = 5 FINCH, exercises the fractional-percent path
    expect(parseStakeAmount("0.5%", balance)).toBe(FINCH(5));
  });

  it("rejects out-of-range percentages", () => {
    expect(() => parseStakeAmount("0%", balance)).toThrow();
    expect(() => parseStakeAmount("101%", balance)).toThrow();
    expect(() => parseStakeAmount("-5%", balance)).toThrow();
  });

  it("k/m shorthand resolves to the right magnitude", () => {
    expect(parseStakeAmount("100k", balance)).toBe(FINCH(100_000));
    expect(parseStakeAmount("1m", balance)).toBe(FINCH(1_000_000));
    expect(parseStakeAmount("1.5m", balance)).toBe(FINCH(1_500_000));
  });

  it("plain numbers and the 'value N' phrasing both parse literally", () => {
    expect(parseStakeAmount("100000", balance)).toBe(FINCH(100_000));
    expect(parseStakeAmount("value 100000", balance)).toBe(FINCH(100_000));
    expect(parseStakeAmount("250.5", balance)).toBe(ethersParse("250.5"));
  });

  it("rejects garbage input with a clear message rather than silently defaulting", () => {
    expect(() => parseStakeAmount("abc", balance)).toThrow(/Could not parse/);
    expect(() => parseStakeAmount("", balance)).toThrow(/Could not parse/);
    expect(() => parseStakeAmount("-100", balance)).toThrow(/Could not parse/);
    // Scientific notation must not silently coerce into something else - it
    // matches none of the accepted shapes, so it should be rejected outright.
    expect(() => parseStakeAmount("1e10", balance)).toThrow(/Could not parse/);
  });

  function ethersParse(s: string): bigint {
    // Mirrors ethers.parseUnits(s, 18) without importing ethers into the test
    // just for this one assertion.
    const [whole, frac = ""] = s.split(".");
    const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
    return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
  }
});
