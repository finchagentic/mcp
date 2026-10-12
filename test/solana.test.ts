import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

// Isolate ~/.finch so tests never touch a real wallet.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "finch-sol-test-"));
process.env.HOME = TMP_HOME;
process.env.FINCH_WALLET_PASSPHRASE = "test-passphrase";
process.env.FINCH_SOLANA_RPC_URL = "https://rpc.example.invalid/secret-api-key";

import {
  parseHumanToBaseUnits, formatBaseUnits, resolveMint, handleSolanaTool, SOLANA_TOOLS,
  SOL_MINT, USDC_MINT, FINCH_MINT, loadSolanaKeypair, solanaRpcUrl,
} from "../src/tools/solana.js";

import dns from "dns";
import { text, calls, mockFetch, sentTx } from "./helpers/solana-mock.js";

// Spend gate is default-deny; these functional tests run with it enabled.
process.env.FINCH_SOL_ALLOW_SPEND = "1";

/** preview -> confirmed swap, binding the quoteId like a real client must. */
async function swap(args: Record<string, any>, confirm = true) {
  const prev: any = await handleSolanaTool("sol_swap", args);
  if (!confirm) return prev;
  return handleSolanaTool("sol_swap", { ...args, confirmed: true, quoteId: prev.structuredContent.quoteId });
}

beforeEach(() => {
  vi.spyOn(dns.promises, "lookup").mockImplementation((async (h: string) => [{ address: "93.184.216.34", family: 4 }]) as any); fs.rmSync(path.join(TMP_HOME, ".finch"), { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("exact amount conversion", () => {
  it("converts without float error", () => {
    expect(parseHumanToBaseUnits("1", 9)).toBe(1_000_000_000n);
    expect(parseHumanToBaseUnits("0.1", 9)).toBe(100_000_000n);
    expect(parseHumanToBaseUnits("0.000000001", 9)).toBe(1n);
    expect(parseHumanToBaseUnits("123456789.123456", 6)).toBe(123_456_789_123_456n);
    // classic float trap: 0.1+0.2 style and >2^53 values stay exact
    expect(parseHumanToBaseUnits("9007199254.740993", 6)).toBe(9_007_199_254_740_993n);
    expect(parseHumanToBaseUnits("1.500", 2)).toBe(150n); // trailing zeros beyond precision OK
  });
  it("rejects imprecise / malformed / zero / overflow amounts", () => {
    for (const bad of ["1.0000001", "abc", "-1", "1e3", "", "0", "0.0", ".5", "1,5"]) {
      expect(() => parseHumanToBaseUnits(bad, 6), bad).toThrow();
    }
    expect(() => parseHumanToBaseUnits("99999999999999999999", 9)).toThrow(/u64/);
  });
  it("formats round trip", () => {
    expect(formatBaseUnits(193041101607552n, 6)).toBe("193041101.607552");
    expect(formatBaseUnits("1000000000", 9)).toBe("1");
    expect(formatBaseUnits(1n, 9)).toBe("0.000000001");
    expect(formatBaseUnits(parseHumanToBaseUnits("42.42", 9), 9)).toBe("42.42");
  });
});

describe("symbol -> mint resolution", () => {
  it("resolves known symbols case-insensitively", () => {
    expect(resolveMint("sol")).toEqual({ mint: SOL_MINT, decimals: 9 });
    expect(resolveMint("USDC")).toEqual({ mint: USDC_MINT, decimals: 6 });
    expect(resolveMint("Finch")).toEqual({ mint: FINCH_MINT, decimals: 6 });
    expect(FINCH_MINT).toBe("4LKS9yUYaBEZyzsaExmFXcWbG9pDBX7AWhseigVYpump");
  });
  it("passes through valid mints and rejects junk", () => {
    expect(resolveMint(USDC_MINT).decimals).toBe(6);
    const k = Keypair.generate().publicKey.toBase58();
    expect(resolveMint(k)).toEqual({ mint: k });
    expect(() => resolveMint("NOTATOKEN!!")).toThrow(/Unknown token/);
    expect(() => resolveMint("")).toThrow();
  });
});

describe("sol_quote", () => {
  it("returns exact amounts, min received, impact percent and routes", async () => {
    mockFetch();
    const r: any = await handleSolanaTool("sol_quote", { inputMint: "SOL", outputMint: "FINCH", amount: "0.1" });
    expect(r.isError).toBeUndefined();
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("amount")).toBe("100000000");
    expect(url.searchParams.get("outputMint")).toBe(FINCH_MINT);
    expect(r.structuredContent.outAmount).toBe("193041101.607552");
    expect(r.structuredContent.minReceived).toBe("192075896.099515");
    expect(r.structuredContent.priceImpactPct).toBeCloseTo(0.1, 6);
    expect(r.structuredContent.routes).toEqual(["Pump.fun Amm", "Raydium"]);
  });
});

describe("sol_swap safety", () => {
  it("without confirmed returns the estimate and sends nothing (not even a wallet needed)", async () => {
    mockFetch();
    const r: any = await handleSolanaTool("sol_swap", { inputMint: "SOL", outputMint: "FINCH", amount: "0.1" });
    expect(text(r)).toMatch(/NOT EXECUTED/);
    expect(r.structuredContent.executed).toBe(false);
    expect(calls.some((c) => c.url.includes("/swap/v1/swap"))).toBe(false);
    expect(sentTx()).toHaveLength(0);
  });

  it("confirmed=true with no local wallet is refused", async () => {
    mockFetch();
    const r: any = await swap({ inputMint: "SOL", outputMint: "FINCH", amount: "0.1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No local Solana wallet/);
    expect(sentTx()).toHaveLength(0);
    expect(fs.existsSync(path.join(TMP_HOME, ".finch", "solana-wallet.json"))).toBe(false); // must not auto-create
  });

  it("rejects price impact > 5% even when confirmed", async () => {
    mockFetch({ impact: "0.06" });
    await handleSolanaTool("sol_wallet", {});
    const r: any = await swap({ inputMint: "SOL", outputMint: "FINCH", amount: "0.1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/price impact 6\.00% exceeds the 5% limit/);
    expect(calls.some((c) => c.url.includes("/swap/v1/swap"))).toBe(false);
    expect(sentTx()).toHaveLength(0);
  });

  it("accepts 4.9% impact boundary path and sends only with confirmed=true", async () => {
    mockFetch({ impact: "0.049" });
    await handleSolanaTool("sol_wallet", {});
    const r: any = await swap({ inputMint: "SOL", outputMint: "FINCH", amount: "0.1" });
    expect(text(r)).toMatch(/Swap confirmed/);
    expect(sentTx()).toHaveLength(1);
  });
});

describe("sol_send / sol_launch_token confirm gate", () => {
  it("sol_send preview does not send", async () => {
    mockFetch();
    await handleSolanaTool("sol_wallet", {});
    const to = Keypair.generate().publicKey.toBase58();
    const r: any = await handleSolanaTool("sol_send", { to, amount: "0.5" });
    expect(text(r)).toMatch(/NOT EXECUTED/);
    expect(text(r)).toContain("0.5 SOL");
    expect(sentTx()).toHaveLength(0);
    const r2: any = await handleSolanaTool("sol_send", { to, amount: "0.5", confirmed: true });
    expect(text(r2)).toMatch(/Sent 0\.5 SOL/);
    expect(sentTx()).toHaveLength(1);
  });
  it("sol_send refuses insufficient balance and bad address", async () => {
    mockFetch({ balanceLamports: 1000 });
    await handleSolanaTool("sol_wallet", {});
    const to = Keypair.generate().publicKey.toBase58();
    expect(text(await handleSolanaTool("sol_send", { to, amount: "1", confirmed: true }) as any)).toMatch(/Insufficient SOL/);
    expect(text(await handleSolanaTool("sol_send", { to: "nope", amount: "1" }) as any)).toMatch(/Invalid recipient/);
    expect(sentTx()).toHaveLength(0);
  });
  it("sol_launch_token preview never uploads or sends, and enforces balance", async () => {
    mockFetch({ balanceLamports: 100_000_000 }); // 0.1 SOL
    await handleSolanaTool("sol_wallet", {});
    const base = { name: "T", symbol: "T", description: "d", imageUrl: "https://example.com/i.png" };
    const low: any = await handleSolanaTool("sol_launch_token", { ...base, devBuySol: "0.5", confirmed: true });
    expect(text(low)).toMatch(/Insufficient SOL/);
    const prev: any = await handleSolanaTool("sol_launch_token", { ...base, devBuySol: "0.01" });
    expect(text(prev)).toMatch(/NOT EXECUTED/);
    expect(calls.some((c) => c.url.includes("pump.fun") || c.url.includes("pumpportal"))).toBe(false);
    expect(sentTx()).toHaveLength(0);
  });
  it("sol_launch_token confirmed uploads metadata, builds with pumpportal and signs with both keys", async () => {
    mockFetch({ balanceLamports: 2_000_000_000 });
    await handleSolanaTool("sol_wallet", {});
    const payer = loadSolanaKeypair(false)!.keypair;
    let portalBody: any;
    const base = (globalThis.fetch as any);
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u === "https://example.com/i.png") return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), { headers: { "content-type": "image/png" } });
      if (u === "https://pump.fun/api/ipfs") {
        expect(init.body).toBeInstanceOf(FormData);
        expect((init.body as FormData).get("showName")).toBe("true");
        return new Response(JSON.stringify({ metadataUri: "https://ipfs.io/ipfs/x" }));
      }
      if (u === "https://pumpportal.fun/api/trade-local") {
        portalBody = JSON.parse(init.body);
        // two-signer tx: payer + mint
        const mintPk = new PublicKey(portalBody.mint);
        const msg = new TransactionMessage({
          payerKey: payer.publicKey, recentBlockhash: "11111111111111111111111111111111",
          instructions: [{ programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: mintPk, isSigner: true, isWritable: true }], data: Buffer.alloc(0) }],
        }).compileToV0Message();
        return new Response(Buffer.from(new VersionedTransaction(msg).serialize()));
      }
      return base(url, init);
    }));
    const r: any = await handleSolanaTool("sol_launch_token", { name: "T", symbol: "T", description: "d", imageUrl: "https://example.com/i.png", devBuySol: "0.01", confirmed: true });
    expect(text(r)).toMatch(/Token launched/);
    expect(portalBody).toMatchObject({ publicKey: payer.publicKey.toBase58(), action: "create", denominatedInSol: "true", amount: 0.01, slippage: 10, priorityFee: 0.0005, pool: "pump", tokenMetadata: { uri: "https://ipfs.io/ipfs/x" } });
    expect(r.structuredContent.mint).toBe(portalBody.mint);
  });
});

describe("wallet secrecy", () => {
  it("sol_wallet creates once, returns only the public address, file is 0600", async () => {
    mockFetch();
    const r1: any = await handleSolanaTool("sol_wallet", {});
    expect(r1.structuredContent.created).toBe(true);
    const r2: any = await handleSolanaTool("sol_wallet", {});
    expect(r2.structuredContent.created).toBe(false);
    expect(r2.structuredContent.address).toBe(r1.structuredContent.address);
    const file = path.join(TMP_HOME, ".finch", "solana-wallet.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const kp = loadSolanaKeypair(false)!.keypair;
    const secretB58Like = Buffer.from(kp.secretKey);
    const hay = JSON.stringify([r1, r2]);
    expect(hay).not.toContain(secretB58Like.toString("hex"));
    expect(hay).not.toContain(secretB58Like.toString("base64"));
    expect(hay).not.toContain(JSON.stringify(Array.from(kp.secretKey)));
    // the secret is not stored in plaintext either
    const disk = fs.readFileSync(file, "utf8");
    expect(disk).not.toContain(secretB58Like.toString("hex"));
    expect(disk).not.toContain(secretB58Like.toString("base64"));
  });
  it("no tool output ever contains the secret or the RPC url/api key", async () => {
    mockFetch();
    await handleSolanaTool("sol_wallet", {});
    const kp = loadSolanaKeypair(false)!.keypair;
    const forbidden = [Buffer.from(kp.secretKey).toString("hex"), Buffer.from(kp.secretKey).toString("base64"), Buffer.from(kp.secretKey.slice(0, 32)).toString("hex"), "secret-api-key"];
    const to = Keypair.generate().publicKey.toBase58();
    const outs = [
      await handleSolanaTool("sol_balance", {}),
      await handleSolanaTool("sol_quote", { inputMint: "SOL", outputMint: "USDC", amount: "1" }),
      await swap({ inputMint: "SOL", outputMint: "USDC", amount: "0.1" }),
      await handleSolanaTool("sol_send", { to, amount: "0.1", confirmed: true }),
    ];
    // and an RPC failure path
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED https://rpc.example.invalid/secret-api-key"); }));
    outs.push(await handleSolanaTool("sol_balance", {}));
    const hay = JSON.stringify(outs);
    for (const f of forbidden) expect(hay).not.toContain(f);
    expect(hay).toContain("Solana RPC");
  });
  it("refuses to overwrite a wallet it cannot decrypt", async () => {
    await handleSolanaTool("sol_wallet", {});
    process.env.FINCH_WALLET_PASSPHRASE = "different";
    try {
      const r: any = await handleSolanaTool("sol_wallet", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Refusing to replace/);
    } finally { process.env.FINCH_WALLET_PASSPHRASE = "test-passphrase"; }
  });
});

describe("config & registration", () => {
  it("defaults RPC and honours FINCH_SOLANA_RPC_URL", () => {
    expect(solanaRpcUrl()).toBe("https://rpc.example.invalid/secret-api-key");
    const prev = process.env.FINCH_SOLANA_RPC_URL;
    delete process.env.FINCH_SOLANA_RPC_URL;
    expect(solanaRpcUrl()).toBe("https://api.mainnet-beta.solana.com");
    process.env.FINCH_SOLANA_RPC_URL = prev;
  });
  it("registers 7 tools, fund movers are destructive, reads read-only", async () => {
    expect(SOLANA_TOOLS.map((t) => t.name).sort()).toEqual(["sol_balance", "sol_launch_token", "sol_quote", "sol_send", "sol_swap", "sol_token_info", "sol_wallet"]);
    const { annotationsFor } = await import("../src/annotations.js");
    for (const n of ["sol_swap", "sol_send", "sol_launch_token"]) expect(annotationsFor(n).destructiveHint).toBe(true);
    for (const n of ["sol_quote", "sol_balance", "sol_token_info"]) expect(annotationsFor(n).readOnlyHint).toBe(true);
  });
});
