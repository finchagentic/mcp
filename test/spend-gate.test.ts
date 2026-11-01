import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  gateSpend, gateUnattended, markTrusted, isTrusted, resetQuotes, effectivePolicy, setKillSwitch,
  spentLast24h, weiSpentLast24h, parseUsdMicros, usdMicrosFor, assertSanePrice, savePolicy,
} from "../src/spend-gate.js";
import { writePrivateJson, readJsonStrict, ensurePrivateDir, hardenDir } from "../src/secure-fs.js";

const ENV_KEYS = ["HOME", "FINCH_ALLOW_SPEND", "FINCH_SPEND_DISABLED", "FINCH_MAX_SPEND_USD_PER_CALL", "FINCH_MAX_SPEND_USD_PER_DAY", "FINCH_SPEND_ALLOWLIST"];
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "finch-gate-"));
  process.env.HOME = home;
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  resetQuotes();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(home, { recursive: true, force: true });
});

const P = { to: "0x" + "a".repeat(40), amount: "5" };
const base = (over: any = {}) => ({
  tool: "t", chainId: 8453, params: P, recipient: P.to, usd: async () => parseUsdMicros("5"), summary: "s", ...over,
});
const enable = () => { process.env.FINCH_ALLOW_SPEND = "1"; };

async function previewThenExec(over: any = {}) {
  const pre: any = await gateSpend(base(over));
  expect(pre.ok).toBe(false);
  const quoteId = pre.result.structuredContent.quoteId;
  expect(quoteId).toBeTruthy();
  return gateSpend(base({ ...over, confirm: true, quoteId }));
}

describe("spend gate", () => {
  it("is default-deny without FINCH_ALLOW_SPEND=1, even with confirm:true", async () => {
    const r: any = await gateSpend(base({ confirm: true, quoteId: "q_x" }));
    expect(r.ok).toBe(false);
    expect(r.result.structuredContent.reason).toBe("spend_disabled");
    expect(r.result.isError).toBe(true);
  });

  it("confirm:true alone never spends; it issues a quote instead", async () => {
    enable();
    const r: any = await gateSpend(base({ confirm: true }));
    expect(r.ok).toBe(false);
    expect(r.result.structuredContent.status).toBe("preview");
    expect(spentLast24h()).toBe(0n);
  });

  it("a preview-issued quoteId executes exactly once", async () => {
    enable();
    const pre: any = await gateSpend(base());
    const quoteId = pre.result.structuredContent.quoteId;
    const ok: any = await gateSpend(base({ confirm: true, quoteId }));
    expect(ok.ok).toBe(true);
    const again: any = await gateSpend(base({ confirm: true, quoteId }));
    expect(again.ok).toBe(false);
  });

  it("quoteId is bound to the exact params and tool", async () => {
    enable();
    const pre: any = await gateSpend(base());
    const quoteId = pre.result.structuredContent.quoteId;
    const changed: any = await gateSpend(base({ params: { ...P, amount: "6" }, confirm: true, quoteId }));
    expect(changed.ok).toBe(false);
    const otherTool: any = await gateSpend(base({ tool: "other", confirm: true, quoteId }));
    expect(otherTool.ok).toBe(false);
  });

  it("enforces the per-call cap", async () => {
    enable(); process.env.FINCH_MAX_SPEND_USD_PER_CALL = "4";
    const r: any = await gateSpend(base());
    expect(r.result.structuredContent.reason).toBe("per_call_cap");
  });

  it("enforces the rolling daily cap using the ledger", async () => {
    enable(); process.env.FINCH_MAX_SPEND_USD_PER_DAY = "12";
    expect(((await previewThenExec()) as any).ok).toBe(true);
    expect(((await previewThenExec()) as any).ok).toBe(true);
    expect(spentLast24h()).toBe(10_000_000n);
    const third: any = await gateSpend(base());
    expect(third.result.structuredContent.reason).toBe("daily_cap");
  });

  it("released reservations are not counted; committed ones are", async () => {
    enable();
    const r: any = await previewThenExec();
    r.reservation.release();
    expect(spentLast24h()).toBe(0n);
    const r2: any = await previewThenExec();
    r2.reservation.commit("0xabc");
    expect(spentLast24h()).toBe(5_000_000n);
  });

  it("fails closed when the USD value is unknown or pricing throws", async () => {
    enable();
    const a: any = await gateSpend(base({ usd: async () => null }));
    expect(a.result.structuredContent.reason).toBe("unpriced");
    const b: any = await gateSpend(base({ usd: async () => { throw new Error("boom"); } }));
    expect(b.result.structuredContent.reason).toBe("unpriced");
  });

  it("kill switch (env and file) blocks everything and is checked before enable", async () => {
    enable();
    process.env.FINCH_SPEND_DISABLED = "1";
    expect(((await gateSpend(base())) as any).result.structuredContent.reason).toBe("kill_switch");
    delete process.env.FINCH_SPEND_DISABLED;
    setKillSwitch(true);
    expect(((await gateSpend(base())) as any).result.structuredContent.reason).toBe("kill_switch");
    expect(((await gateUnattended("x", 1n, 1n)) as any).result.structuredContent.reason).toBe("kill_switch");
    setKillSwitch(false);
    expect(((await previewThenExec()) as any).ok).toBe(true);
  });

  it("recipient allowlist (env) blocks unlisted recipients", async () => {
    enable();
    process.env.FINCH_SPEND_ALLOWLIST = "0x" + "b".repeat(40);
    const r: any = await gateSpend(base());
    expect(r.result.structuredContent.reason).toBe("recipient_not_allowed");
    process.env.FINCH_SPEND_ALLOWLIST = P.to.toUpperCase().replace("0X", "0x");
    expect(((await previewThenExec()) as any).ok).toBe(true);
  });

  it("policy.json can only tighten: env ceiling wins, file narrows, disjoint allowlists block all", async () => {
    enable();
    process.env.FINCH_MAX_SPEND_USD_PER_CALL = "50";
    savePolicy({ version: 1, maxPerCallUsd: "1000", maxPerDayUsd: "10" });
    let p = effectivePolicy();
    expect(p.perCall).toBe(50_000_000n);
    expect(p.perDay).toBe(10_000_000n);
    process.env.FINCH_SPEND_ALLOWLIST = "0x" + "b".repeat(40);
    savePolicy({ version: 1, allowlist: ["0x" + "c".repeat(40)] });
    p = effectivePolicy();
    expect(p.allowlist).toEqual(["0x" + "0".repeat(40)]);
    expect(((await gateSpend(base({ recipient: "0x" + "b".repeat(40) }))) as any).result.structuredContent.reason).toBe("recipient_not_allowed");
  });

  it("refuses to spend with a corrupt policy file", async () => {
    enable();
    ensurePrivateDir(path.join(home, ".finch"));
    fs.writeFileSync(path.join(home, ".finch", "policy.json"), "{not json");
    expect(((await gateSpend(base())) as any).result.structuredContent.reason).toBe("policy_error");
  });

  it("ledger is bigint-exact for values beyond 2^53 and stored as strings with 0600", async () => {
    enable(); process.env.FINCH_MAX_SPEND_USD_PER_CALL = "100000000000000"; process.env.FINCH_MAX_SPEND_USD_PER_DAY = "900000000000000";
    const big = parseUsdMicros("12345678901234.123457"); // > 2^53 micros
    const wei = 123456789012345678901234567n;
    const r: any = await previewThenExec({ usd: async () => big, wei });
    expect(r.ok).toBe(true);
    expect(spentLast24h()).toBe(big);
    expect(weiSpentLast24h()).toBe(wei);
    const f = path.join(home, ".finch", "spend-ledger.json");
    const raw = readJsonStrict<any>(f, null);
    expect(typeof raw.entries[0].usdMicros).toBe("string");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("arming gate needs enable + quoteId but writes no ledger entry", async () => {
    enable();
    const r: any = await previewThenExec({ arming: true, usd: undefined });
    expect(r.ok).toBe(true);
    expect(r.reservation).toBeNull();
    expect(spentLast24h()).toBe(0n);
    delete process.env.FINCH_ALLOW_SPEND;
    expect(((await gateSpend(base({ arming: true, usd: undefined }))) as any).result.structuredContent.reason).toBe("spend_disabled");
  });

  it("unattended gate: needs enable, enforces caps, skipCaps only skips caps", async () => {
    expect(((await gateUnattended("x", 1n, 1n)) as any).result.structuredContent.reason).toBe("spend_disabled");
    expect(((await gateUnattended("x", 1n, 1n, { skipCaps: true })) as any).result.structuredContent.reason).toBe("spend_disabled");
    enable(); process.env.FINCH_MAX_SPEND_USD_PER_DAY = "10";
    const a: any = await gateUnattended("x", 6_000_000n, 1n);
    expect(a.ok).toBe(true);
    const b: any = await gateUnattended("x", 6_000_000n, 1n);
    expect(b.result.structuredContent.reason).toBe("daily_cap");
    expect(((await gateUnattended("x", 999_000_000n, 0n, { skipCaps: true })) as any).ok).toBe(true);
  });

  it("markTrusted objects are trusted; parsed JSON look-alikes are not", () => {
    const t = markTrusted({ confirm: true });
    expect(isTrusted(t)).toBe(true);
    expect(isTrusted({ ...t })).toBe(false);
    expect(isTrusted(JSON.parse(JSON.stringify(t)))).toBe(false);
    expect(isTrusted({ trusted: true })).toBe(false);
  });

  it("price sanity rejects absurd ETH/USD and USD math is exact", () => {
    expect(() => assertSanePrice(0.01)).toThrow();
    expect(() => assertSanePrice(NaN)).toThrow();
    expect(() => assertSanePrice(1e9)).toThrow();
    expect(assertSanePrice(3000)).toBe(3000);
    expect(usdMicrosFor(10n ** 18n, 18, 3000)).toBe(3_000_000_000n);
    expect(() => parseUsdMicros("-1")).toThrow();
    expect(() => parseUsdMicros("1e3")).toThrow();
  });
});

describe("secure-fs", () => {
  it("creates 0700 dirs and 0600 atomic files, leaving no tmp files", () => {
    const d = path.join(home, "x", "y");
    const f = path.join(d, "a.json");
    writePrivateJson(f, { a: 1 });
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(d)).toEqual(["a.json"]);
  });
  it("backup option keeps previous content in .bak (0600)", () => {
    const f = path.join(home, "b.json");
    writePrivateJson(f, { v: 1 });
    writePrivateJson(f, { v: 2 }, { backup: true });
    expect(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).v).toBe(1);
    expect(fs.statSync(f + ".bak").mode & 0o777).toBe(0o600);
  });
  it("readJsonStrict: fallback only when absent; throws on corrupt", () => {
    const f = path.join(home, "c.json");
    expect(readJsonStrict(f, { d: 1 })).toEqual({ d: 1 });
    fs.writeFileSync(f, "{oops");
    expect(() => readJsonStrict(f, {})).toThrow();
  });
  it("hardenDir tightens existing loose files and dirs", () => {
    const d = path.join(home, "loose");
    fs.mkdirSync(path.join(d, "sub"), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(d, "sub", "k"), "x", { mode: 0o644 });
    expect(hardenDir(d)).toBe(1);
    expect(fs.statSync(path.join(d, "sub", "k")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
  });
});
