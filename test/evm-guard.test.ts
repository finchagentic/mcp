import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  validateSwapTx, assertAllowedSpender, buildErc20Transfer, verifyErc20Transfer, resolveSlippagePct, isAllowedSpender, simulateTx,
} from "../src/evm-guard.js";
import { buildSendTx } from "../src/tools/defi.js";

const RH = 4663;
const BASE = 8453;
const UR_RH = "0x8876789976decbfcbbbe364623c63652db8c0904";
const WALLET = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const coder = ethers.AbiCoder.defaultAbiCoder();
const iface = new ethers.Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

function urCall(cmds: number[], inputs: string[]): string {
  return iface.encodeFunctionData("execute", [ethers.hexlify(Uint8Array.from(cmds)), inputs, 9999999999n]);
}
const sweep = (to: string) => coder.encode(["address", "address", "uint256"], [ethers.ZeroAddress, to, 0n]);
const wrap = (to: string, amt: bigint) => coder.encode(["address", "uint256"], [to, amt]);

describe("spender / target allowlist", () => {
  it("allows Permit2 and the RH Universal Router, rejects others", () => {
    expect(() => assertAllowedSpender(RH, "0x000000000022D473030F116dDEE9F6B43aC78BA3")).not.toThrow();
    expect(() => assertAllowedSpender(RH, UR_RH)).not.toThrow();
    expect(() => assertAllowedSpender(RH, ATTACKER)).toThrow(/allowlist/);
    expect(isAllowedSpender(RH, "0x6fF5693b99212Da76ad316178A184AB56D299b43")).toBe(false); // Base router is not valid on RH
  });
  it("operator can extend via env only", () => {
    process.env.FINCH_EXTRA_ROUTERS = ATTACKER;
    expect(isAllowedSpender(RH, ATTACKER)).toBe(true);
    delete process.env.FINCH_EXTRA_ROUTERS;
    expect(isAllowedSpender(RH, ATTACKER)).toBe(false);
  });
});

describe("validateSwapTx", () => {
  const good = urCall([0x0b, 0x04], [wrap("0x0000000000000000000000000000000000000002", 5n), sweep(WALLET)]);
  it("accepts a benign UR execute paying the wallet with value within bound", () => {
    expect(() => validateSwapTx({ to: UR_RH, data: good, value: "5" }, { chainId: RH, wallet: WALLET, maxValueWei: 5n })).not.toThrow();
  });
  it("rejects value above the authorised amount", () => {
    expect(() => validateSwapTx({ to: UR_RH, data: good, value: "6" }, { chainId: RH, wallet: WALLET, maxValueWei: 5n })).toThrow(/exceeds/);
  });
  it("rejects a non-allowlisted target", () => {
    expect(() => validateSwapTx({ to: ATTACKER, data: good, value: "0" }, { chainId: RH, wallet: WALLET, maxValueWei: 5n })).toThrow(/known router/);
  });
  it("rejects a SWEEP to an attacker", () => {
    const bad = urCall([0x0b, 0x04], [wrap("0x0000000000000000000000000000000000000002", 5n), sweep(ATTACKER)]);
    expect(() => validateSwapTx({ to: UR_RH, data: bad, value: "5" }, { chainId: RH, wallet: WALLET, maxValueWei: 5n })).toThrow(/not the wallet/);
  });
  it("rejects a raw TRANSFER command and unknown commands", () => {
    const t = urCall([0x05], [coder.encode(["address", "address", "uint256"], [ethers.ZeroAddress, ATTACKER, 1n])]);
    expect(() => validateSwapTx({ to: UR_RH, data: t, value: "0" }, { chainId: RH, wallet: WALLET, maxValueWei: 0n })).toThrow(/allowlist/);
  });
  it("rejects token-level selectors (approve) sent to a router", () => {
    const data = new ethers.Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [ATTACKER, ethers.MaxUint256]);
    expect(() => validateSwapTx({ to: UR_RH, data, value: "0" }, { chainId: RH, wallet: WALLET, maxValueWei: 0n })).toThrow(/not a swap/);
  });
  it("rejects absurd gas", () => {
    expect(() => validateSwapTx({ to: UR_RH, data: good, value: "0", gas: "99999999" }, { chainId: RH, wallet: WALLET, maxValueWei: 0n })).toThrow(/gas/);
  });
  it("Base: 0x AllowanceHolder is allowed (opaque calldata), random is not", () => {
    expect(() => validateSwapTx({ to: "0x0000000000001fF3684f28c67538d4D072C22734", data: "0x1fff991f00", value: "0" }, { chainId: BASE, wallet: WALLET, maxValueWei: 0n })).not.toThrow();
    expect(() => validateSwapTx({ to: ATTACKER, data: "0x1fff991f00", value: "0" }, { chainId: BASE, wallet: WALLET, maxValueWei: 0n })).toThrow();
  });
});

describe("simulateTx", () => {
  it("propagates simulation failure", async () => {
    await expect(simulateTx(async () => { throw new Error("execution reverted"); }, WALLET, { to: UR_RH, data: "0x00" })).rejects.toThrow(/refusing to broadcast/);
    await expect(simulateTx(async () => "0x", WALLET, { to: UR_RH, data: "0x00" })).resolves.toBeUndefined();
  });
});

describe("ERC-20 transfer built locally", () => {
  const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  it("encodes and verifies recipient/amount", () => {
    const tx = buildErc20Transfer(TOKEN, ATTACKER, 1_000_000n);
    expect(tx.to).toBe(TOKEN);
    expect(tx.value).toBe("0");
    expect(() => verifyErc20Transfer(tx, TOKEN, ATTACKER, 1_000_000n)).not.toThrow();
    expect(() => verifyErc20Transfer(tx, TOKEN, WALLET, 1_000_000n)).toThrow(/mismatch/);
    expect(() => verifyErc20Transfer(tx, TOKEN, ATTACKER, 1n)).toThrow(/mismatch/);
    expect(() => verifyErc20Transfer({ ...tx, value: "1" }, TOKEN, ATTACKER, 1_000_000n)).toThrow(/zero native/);
  });
  it("buildSendTx: USDC and ETH", async () => {
    const u = await buildSendTx("USDC", ATTACKER, "1.5");
    expect(u.amountWei).toBe(1_500_000n);
    expect(u.tx.to).toBe(TOKEN);
    const e = await buildSendTx("ETH", ATTACKER, "0.1");
    expect(e.tx).toMatchObject({ to: ATTACKER, data: "0x", value: "100000000000000000" });
    await expect(buildSendTx("NOPE", ATTACKER, "1")).rejects.toThrow(/Unknown token/);
  });
});

describe("slippage policy", () => {
  it("default 1, cap 5", () => {
    expect(resolveSlippagePct(undefined)).toBe(1);
    expect(resolveSlippagePct(5)).toBe(5);
    expect(() => resolveSlippagePct(5.1)).toThrow();
    expect(() => resolveSlippagePct(0)).toThrow();
    expect(() => resolveSlippagePct(-1)).toThrow();
  });
});

describe("no unlimited approvals anywhere in source", () => {
  it("MaxUint256 / uint160 max approvals are gone from tools and wallet", () => {
    const files = ["src/tools/rh-mcp-swap.ts", "src/tools/rh-mcp.ts", "src/wallet.ts", "src/tools/defi.ts"];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src, f).not.toMatch(/approve\([^)]*MaxUint256/);
      expect(src, f).not.toMatch(/max160/);
    }
  });
});
