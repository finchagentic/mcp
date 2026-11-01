import { describe, it, expect, vi, beforeEach } from "vitest";

const callConvex = vi.fn();
vi.mock("../src/convex.js", () => ({ callConvex: (...a: any[]) => callConvex(...a) }));
vi.mock("../src/wallet.js", () => ({ getOrCreateWallet: async () => ({ address: "0x" + "1".repeat(40) }) }));
vi.mock("../src/tools/rh-mcp-provider.js", () => ({ rhProviderAsync: async () => { throw new Error("rpc down"); } }));

describe("tier gate", () => {
  beforeEach(() => { vi.resetModules(); callConvex.mockReset(); delete process.env.FINCH_API_KEY; delete process.env.FINCH_SESSION_TOKEN; });

  it("a made-up non-empty API key does NOT unlock premium tools", async () => {
    process.env.FINCH_API_KEY = "finch_sk_garbage";
    callConvex.mockRejectedValue(new Error("401"));
    const { getTier } = await import("../src/token-gate.js");
    expect(await getTier()).toBe("basic");
  });
  it("a backend-accepted key unlocks", async () => {
    process.env.FINCH_API_KEY = "finch_sk_real";
    callConvex.mockResolvedValue({ automations: [] });
    const { getTier } = await import("../src/token-gate.js");
    expect(await getTier()).toBe("holder");
  });
  it("no credential and RPC failure -> basic (fail closed)", async () => {
    const { getTier } = await import("../src/token-gate.js");
    expect(await getTier()).toBe("basic");
    expect(callConvex).not.toHaveBeenCalled();
  });
  it("upgrade message names only the RH FINCH CA", async () => {
    const { tokenGateError } = await import("../src/token-gate.js");
    const t = (tokenGateError("x").content[0] as any).text as string;
    expect(t).toContain("0x879f29204a5ff842c66f0f65e0f2e422073acce7");
    expect(t.toLowerCase()).not.toContain("0x4b524015");
  });
});
