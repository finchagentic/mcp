import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handlePolicyTool, applyPolicyChange } from "../src/tools/policy.js";
import { effectivePolicy, isKilled, resetQuotes, gateSpend, parseUsdMicros } from "../src/spend-gate.js";
import { filterTools } from "../src/tool-filter.js";
import { ALL_TOOLS } from "../src/server.js";

const KEYS = ["HOME", "FINCH_ALLOW_SPEND", "FINCH_SPEND_DISABLED", "FINCH_MAX_SPEND_USD_PER_CALL", "FINCH_MAX_SPEND_USD_PER_DAY", "FINCH_SPEND_ALLOWLIST", "FINCH_TOOLS", "FINCH_PRESET"];
let saved: Record<string, string | undefined>; let home: string;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "finch-pol-")); process.env.HOME = home;
  for (const k of KEYS.slice(1)) delete process.env[k];
  resetQuotes();
});
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } fs.rmSync(home, { recursive: true, force: true }); });

describe("wallet_policy", () => {
  it("show reports defaults and default-deny", async () => {
    const r: any = await handlePolicyTool("wallet_policy", {});
    expect(r.structuredContent).toMatchObject({ spendEnabled: false, killed: false, maxPerCallUsd: "100.00", maxPerDayUsd: "500.00" });
  });
  it("can tighten caps, but not raise them above the current/operator ceiling", async () => {
    process.env.FINCH_MAX_SPEND_USD_PER_CALL = "50";
    expect(((await handlePolicyTool("wallet_policy", { action: "set", maxPerCallUsd: "20" })) as any).isError).toBe(false);
    expect(effectivePolicy().perCall).toBe(20_000_000n);
    const up: any = await handlePolicyTool("wallet_policy", { action: "set", maxPerCallUsd: "30" });
    expect(up.isError).toBe(true);
    expect(effectivePolicy().perCall).toBe(20_000_000n);
    expect(((await handlePolicyTool("wallet_policy", { action: "set", maxPerDayUsd: "9999" })) as any).isError).toBe(true);
  });
  it("tightened cap is enforced by the gate", async () => {
    process.env.FINCH_ALLOW_SPEND = "1";
    await handlePolicyTool("wallet_policy", { action: "set", maxPerCallUsd: "1" });
    const g: any = await gateSpend({ tool: "t", chainId: 1, params: {}, usd: async () => parseUsdMicros("5"), summary: "s" });
    expect(g.result.structuredContent.reason).toBe("per_call_cap");
  });
  it("allowlist can only narrow; cannot add, cannot empty", async () => {
    const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);
    process.env.FINCH_SPEND_ALLOWLIST = `${A},${B}`;
    expect(applyPolicyChange({ allowlist: [A] }).isError).toBe(false);
    expect(effectivePolicy().allowlist).toEqual([A]);
    expect(applyPolicyChange({ allowlist: [A, C] }).isError).toBe(true);
    expect(applyPolicyChange({ allowlist: [] }).isError).toBe(true);
    expect(applyPolicyChange({ allowlist: ["nope"] }).isError).toBe(true);
    expect(effectivePolicy().allowlist).toEqual([A]);
  });
  it("kill engages the switch and no tool action can release it", async () => {
    await handlePolicyTool("wallet_policy", { action: "kill" });
    expect(isKilled()).toBe(true);
    for (const args of [{ action: "set", maxPerCallUsd: "1" }, { action: "show" }, { action: "unkill" }, { action: "kill", release: true }]) await handlePolicyTool("wallet_policy", args);
    expect(isKilled()).toBe(true);
  });
});

describe("approvals tools", () => {
  it("approvals_revoke validates input and never executes without a matching quoteId", async () => {
    const bad: any = await handlePolicyTool("approvals_revoke", { chain: "base", token: "x", spender: "y" });
    expect(bad.isError).toBe(true);
    const args = { chain: "base", token: "0x" + "1".repeat(40), spender: "0x" + "2".repeat(40) };
    const pre: any = await handlePolicyTool("approvals_revoke", args);
    expect(pre.structuredContent).toMatchObject({ executed: false, status: "preview" });
    const forged: any = await handlePolicyTool("approvals_revoke", { ...args, confirm: true, quoteId: "q_forged" });
    expect(forged.structuredContent.status).toBe("preview");
    const swapped: any = await handlePolicyTool("approvals_revoke", { ...args, spender: "0x" + "3".repeat(40), confirm: true, quoteId: pre.structuredContent.quoteId });
    expect(swapped.structuredContent.status).toBe("preview");
  });
});

describe("registration + presets", () => {
  it("tools are registered", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const n of ["wallet_policy", "approvals_list", "approvals_revoke"]) expect(names).toContain(n);
  });
  it("new presets expose the right slices", () => {
    process.env.FINCH_TOOLS = "solana-trader";
    const st = filterTools(ALL_TOOLS).map((t) => t.name);
    expect(st).toContain("sol_swap"); expect(st).toContain("wallet_policy");
    expect(st).not.toContain("rh_mcp_swap"); expect(st).not.toContain("base_mcp_send");
    process.env.FINCH_TOOLS = "launcher";
    const l = filterTools(ALL_TOOLS).map((t) => t.name);
    expect(l).toContain("launchpad_launch_token"); expect(l).toContain("approvals_revoke"); expect(l).not.toContain("sol_swap");
    process.env.FINCH_TOOLS = "research";
    expect(filterTools(ALL_TOOLS).map((t) => t.name)).toContain("deep_research");
  });
});
