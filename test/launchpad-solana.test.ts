// launchpad_* on chain="solana": reads, launch (Finch account, needs a real session), buy/sell (local wallet, direct cp-amm).
// All network is mocked (one fetch stub for the Finch backend + Solana JSON-RPC). No transaction is ever sent to a real chain.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TMP_HOME = await vi.hoisted(async () => {
  const fs = await import("fs"), os = await import("os"), path = await import("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "finch-lpsol-test-"));
  process.env.HOME = d;
  process.env.FINCH_WALLET_PASSPHRASE = "test-passphrase";
  delete process.env.FINCH_API_KEY;
  delete process.env.FINCH_SESSION_TOKEN;
  delete process.env.FINCH_SOLANA_RPC_URL;
  return d;
});

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { handleLaunchpadTool, LAUNCHPAD_TOOLS } from "../src/tools/launchpad.js";
import { handleLaunchpadSwapTool, LAUNCHPAD_SWAP_TOOLS } from "../src/tools/launchpad-swap.js";
import { _resetSolanaPreviews, solanaCapLamports, parseSolanaMint, requireSessionToken } from "../src/tools/launchpad-solana.js";
import { loadSolanaKeypair } from "../src/tools/solana.js";
import * as L from "../src/launchpad-solana.js";

// Lets one test tamper with the compiled transaction between "build" and "sign" (defense-in-depth check).
const tamper = vi.hoisted(() => ({ on: false }));
vi.mock("../src/launchpad-solana.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    compileSwapTx: (wallet: any, blockhash: string, ixs: any[]) => orig.compileSwapTx(wallet, blockhash, tamper.on ? [...ixs, ixs[0]] : ixs),
  };
});

const MINT = "AJgGt1EGPzYdXRzVovtjgTW2qAbYGzEPHeBp727c8FJq";
const POOL = "ETzvYneJnVMoDkUU4NAfzV1jWHsrcS27Z5oc5sNNYop8";
const FINCH_WALLET = Keypair.generate().publicKey.toBase58();
const SIG1 = "5".repeat(88), SIG2 = "4".repeat(88);
const NEW_MINT = Keypair.generate().publicKey.toBase58();
const NEW_POOL = Keypair.generate().publicKey.toBase58();
const SESSION = "sess_" + "a".repeat(40);
const text = (r: any) => r.content[0].text as string;
const poolFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/finch-pool-account.json"), "utf8"));
const mintFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/finch-mint-account.json"), "utf8"));

interface World {
  calls: Array<{ url: string; method: string; headers: any; body: any; rpc?: string }>;
  poolData: Buffer; poolOwner: string; mintOwner: string;
  token: any | "404";
  walletBody: any | { status: number; json: any };
  launch: (body: any) => { status: number; json?: any; throw?: boolean };
  solBalance: bigint; tokenBalance: bigint;
  simErr: unknown; simSolDelta: bigint; simTokenDelta: bigint; simDropAccounts: boolean;
  sent: string[];
}
let W: World;
let me: PublicKey;

const b64 = (b: Buffer) => b.toString("base64");
function tokenAcctData(amount: bigint): Buffer { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return b; }
function writeU128(buf: Buffer, off: number, v: bigint) { buf.writeBigUInt64LE(v & 0xffffffffffffffffn, off); buf.writeBigUInt64LE(v >> 64n, off + 8); }
/** A pool that has been traded up (sqrtPrice above the floor) so SELL quotes work. */
function tradedPool(extraSqrt = 4_000_000_000_000_000n): Buffer {
  const b = Buffer.from(poolFixture.data, "base64");
  const s = L.decodeSwapPool(b);
  writeU128(b, 456, s.sqrtPrice + extraSqrt);
  return b;
}
const finchTokenBody = (over: Record<string, any> = {}) => ({
  chain: "solana", token: MINT, name: "Test Coin", symbol: "TST", source: "finch", poolId: POOL, quote: L.WSOL_MINT.toBase58(), quoteDecimals: 9,
  stats: { priceSol: 0.00000003, marketCapSol: 30, volume24hSol: 1.5, priceUsd: 0.000005, marketCapUsd: 5000, volume24hUsd: 250 },
  agent: { status: "building", slug: "tst-agent", productUrl: "https://tst-agent.finchagentic.com", budgetUsd: 12, feeRouted: true },
  ...over,
});

function install() {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json), json: async () => json });
    if (u.startsWith("https://valuable-fish-533.convex.site") || u.includes("convex.site")) {
      W.calls.push({ url: u, method, headers: init.headers, body });
      const p = new URL(u);
      if (p.pathname === "/launchpad/pairs") return reply(200, { chains: { base: { quotes: [] }, solana: { quotes: [{ key: "sol", address: L.WSOL_MINT.toBase58(), decimals: 9, symbol: "SOL" }], launch: "finch-account", splitNote: "Solana: no contract split. Finch's fee-claim job claims fees." } }, split: { agentBps: 9000, creatorBps: 1000, platformBps: 0 } });
      if (p.pathname === "/launchpad/list") return reply(200, { launches: [{ chain: "solana", token: MINT, name: "Test Coin", symbol: "TST", marketCapSol: 30, marketCapUsd: 5000, volume24hSol: 1.5, hasAgent: true, agentSlug: "tst-agent" }] });
      if (p.pathname === "/launchpad/token") {
        if (W.token === "404") return reply(404, { error: "Token not found." });
        return reply(200, W.token);
      }
      if (p.pathname === "/launchpad/solana/wallet") {
        if ((W.walletBody as any)?.status) return reply((W.walletBody as any).status, (W.walletBody as any).json);
        return reply(200, W.walletBody);
      }
      if (p.pathname === "/launchpad/solana/launch") {
        const r = W.launch(body);
        if (r.throw) throw new Error("socket hang up");
        return reply(r.status, r.json ?? {});
      }
      return reply(404, { error: "unmocked " + p.pathname });
    }
    // Solana JSON-RPC
    const { method: rpcMethod, params } = body;
    W.calls.push({ url: u, method, headers: init.headers, body, rpc: rpcMethod });
    const res = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, result }) });
    const acct = (data: Buffer, owner: string, lamports = 2_000_000) => ({ lamports, owner, data: [b64(data), "base64"], executable: false, rentEpoch: 0, space: data.length });
    const ataTok = L.ataAddress(new PublicKey(MINT), me, L.TOKEN_PROGRAM).toBase58();
    const wallet = me.toBase58();
    const stateOf = (addr: string, post: boolean) => {
      if (addr === wallet) return acct(Buffer.alloc(0), "11111111111111111111111111111111", Number(W.solBalance + (post ? W.simSolDelta : 0n)));
      if (addr === ataTok) return acct(tokenAcctData(W.tokenBalance + (post ? W.simTokenDelta : 0n)), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      return null;
    };
    if (rpcMethod === "getAccountInfo") {
      const a = params[0] as string;
      if (a === POOL) return res({ value: acct(W.poolData, W.poolOwner, 10_000_000) });
      if (a === MINT) return res({ value: acct(Buffer.from(mintFixture.data, "base64"), W.mintOwner, 1_000_000) });
      if (a === ataTok) return res({ value: W.tokenBalance > 0n ? acct(tokenAcctData(W.tokenBalance), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") : null });
      return res({ value: null });
    }
    if (rpcMethod === "getBalance") return res({ value: Number(W.solBalance) });
    if (rpcMethod === "getLatestBlockhash") return res({ value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 } });
    if (rpcMethod === "getMultipleAccounts") return res({ value: (params[0] as string[]).map((a) => stateOf(a, false)) });
    if (rpcMethod === "simulateTransaction") {
      const addrs: string[] = params[1].accounts.addresses;
      if (W.simErr) return res({ value: { err: W.simErr, logs: [], accounts: null } });
      return res({ value: { err: null, logs: [], accounts: W.simDropAccounts ? [] : addrs.map((a) => stateOf(a, true)) } });
    }
    if (rpcMethod === "sendTransaction") { W.sent.push(params[0]); return res(SIG1); }
    if (rpcMethod === "getSignatureStatuses") return res({ value: [{ confirmationStatus: "confirmed", err: null }] });
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: body.id, error: { message: "unmocked " + rpcMethod } }) };
  }));
}

const ENV_KEYS = ["FINCH_LAUNCHPAD_ALLOW_SPEND", "FINCH_LAUNCHPAD_MAX_BUY_SOL", "FINCH_LAUNCHPAD_MAX_SOL_LAUNCH", "FINCH_SESSION_TOKEN", "FINCH_API_KEY"];
beforeEach(() => {
  _resetSolanaPreviews();
  for (const k of ENV_KEYS) delete process.env[k];
  me = loadSolanaKeypair(true)!.keypair.publicKey; // scrypt is slow: keep the wallet across tests (tests that delete it get a fresh one here)
  W = {
    calls: [], poolData: Buffer.from(poolFixture.data, "base64"), poolOwner: L.METEORA_CP_AMM_PROGRAM.toBase58(), mintOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    token: finchTokenBody(), walletBody: { address: FINCH_WALLET, balanceSol: 1, balanceLamports: 1_000_000_000, chain: "solana" },
    launch: () => ({ status: 200, json: { ok: true, mint: NEW_MINT, poolId: NEW_POOL, mintTx: SIG1, poolTx: SIG2, wallet: FINCH_WALLET, agentSlug: "new-agent", productUrl: null, split: { agentBps: 9000, creatorBps: 1000, platformBps: 0 }, splitNote: "x" } }),
    solBalance: 2_000_000_000n, tokenBalance: 0n, simErr: null, simSolDelta: 0n, simTokenDelta: 0n, simDropAccounts: false, sent: [],
  };
  install();
});
afterEach(() => { vi.unstubAllGlobals(); });

const launchPosts = () => W.calls.filter((c) => c.url.includes("/launchpad/solana/launch"));
const rpcCalls = (m: string) => W.calls.filter((c) => c.rpc === m);
const launch = (extra: Record<string, any> = {}) => handleLaunchpadTool("launchpad_launch_token", { chain: "solana", name: "Coin", symbol: "coin", ...extra });
const buy = (extra: Record<string, any> = {}) => handleLaunchpadSwapTool("launchpad_buy", { chain: "solana", token: MINT, amount: "0.1", ...extra });
const sell = (extra: Record<string, any> = {}) => handleLaunchpadSwapTool("launchpad_sell", { chain: "solana", token: MINT, percent: 50, ...extra });
async function buyConfirm(extra: Record<string, any> = {}, confirmExtra: Record<string, any> = {}) {
  const prev: any = await buy(extra);
  return buy({ ...extra, confirmed: true, quoteId: prev.structuredContent.quoteId, ...confirmExtra });
}
async function sellConfirm(extra: Record<string, any> = {}, confirmExtra: Record<string, any> = {}) {
  const prev: any = await sell(extra);
  return sell({ ...extra, confirmed: true, quoteId: prev.structuredContent.quoteId, ...confirmExtra });
}

describe("schemas", () => {
  it("tool names are unchanged and solana is a valid chain everywhere", () => {
    expect(LAUNCHPAD_TOOLS.map((t) => t.name)).toEqual(["launchpad_wallet", "launchpad_pairs", "launchpad_launches", "launchpad_token", "launchpad_launch_token"]);
    expect(LAUNCHPAD_SWAP_TOOLS.map((t) => t.name)).toEqual(["launchpad_buy", "launchpad_sell"]);
    for (const t of [...LAUNCHPAD_TOOLS.filter((x) => x.name !== "launchpad_wallet" && x.name !== "launchpad_pairs"), ...LAUNCHPAD_SWAP_TOOLS]) {
      expect(JSON.stringify((t.inputSchema as any).properties.chain.enum), t.name).toContain("solana");
    }
  });
});

describe("reads", () => {
  it("launchpad_pairs shows the SOL quote and the Solana split note", async () => {
    const r: any = await handleLaunchpadTool("launchpad_pairs", {});
    expect(text(r)).toContain(`"solana": SOL (sol, 9 dec, ${L.WSOL_MINT.toBase58()})`);
    expect(text(r)).toContain("finch login");
  });
  it("launchpad_launches chain=solana shows SOL mcap and the exact mint", async () => {
    const r: any = await handleLaunchpadTool("launchpad_launches", { chain: "solana" });
    expect(W.calls[0].url).toContain("chain=solana");
    expect(text(r)).toContain(MINT);
    expect(text(r)).toContain("30 SOL");
  });
  it("launchpad_launches accepts any", async () => {
    const r: any = await handleLaunchpadTool("launchpad_launches", { chain: "any" });
    expect(r.isError).toBeUndefined();
  });
  it("launchpad_token chain=solana keeps the mint case, shows SOL + agent + product", async () => {
    const r: any = await handleLaunchpadTool("launchpad_token", { chain: "solana", token: MINT });
    expect(W.calls[0].url).toBe(`https://valuable-fish-533.convex.site/launchpad/token?chain=solana&token=${MINT}`);
    const t = text(r);
    expect(t).toContain(MINT); expect(t).toContain("SOL"); expect(t).toContain("https://tst-agent.finchagentic.com"); expect(t).toContain(POOL);
  });
  it("rejects non-base58 / EVM addresses for solana", async () => {
    for (const bad of ["0x1688E6cE60FE0C7743ff07ce0b578942Dd4F1723", MINT.toLowerCase(), "short", ""]) {
      const r: any = await handleLaunchpadTool("launchpad_token", { chain: "solana", token: bad });
      expect(r.isError, bad).toBe(true);
    }
    expect(W.calls.length).toBe(0);
  });
  it("EVM tokens are still validated as 0x", async () => {
    const r: any = await handleLaunchpadTool("launchpad_token", { chain: "base", token: MINT });
    expect(r.isError).toBe(true);
  });
  it("parseSolanaMint is case-sensitive", () => {
    expect(parseSolanaMint(MINT)).toBe(MINT);
    expect(() => parseSolanaMint(MINT.toUpperCase())).toThrow();
  });
});

describe("launch: session requirement", () => {
  it("no session at all: clear finch login error, NO backend contact", async () => {
    for (const confirmed of [false, true]) {
      const r: any = await launch({ confirmed });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("finch login");
    }
    expect(W.calls.length).toBe(0);
  });
  it("API key only: finch login error, no backend contact", async () => {
    process.env.FINCH_API_KEY = "finch_sk_" + "b".repeat(30);
    const r: any = await launch({ confirmed: true });
    expect(r.isError).toBe(true); expect(text(r)).toContain("finch login");
    expect(W.calls.length).toBe(0);
  });
  it("an API key placed in FINCH_SESSION_TOKEN is still not a session", async () => {
    for (const k of ["finch_sk_" + "c".repeat(30), "noel_sk_" + "c".repeat(30)]) {
      process.env.FINCH_SESSION_TOKEN = k;
      const r: any = await launch({ confirmed: true });
      expect(r.isError, k).toBe(true); expect(text(r)).toContain("finch login");
    }
    expect(W.calls.length).toBe(0);
  });
  it("requireSessionToken returns a real token", () => {
    process.env.FINCH_SESSION_TOKEN = SESSION;
    expect(requireSessionToken()).toBe(SESSION);
  });
});

describe("launch: preview", () => {
  beforeEach(() => { process.env.FINCH_SESSION_TOKEN = SESSION; });
  it("shows the exact outcome, wallet + balance, split, rent; sends nothing", async () => {
    const r: any = await launch({ description: "hi", boostSol: 0.1 });
    const t = text(r);
    expect(t).toContain("NOT EXECUTED");
    expect(t).toContain("~0.025 SOL");
    expect(t).toContain("90% agent / 10% you / 0% Finch (claimed by Finch's cron from your Finch wallet)");
    expect(t).toContain(FINCH_WALLET);
    expect(t).toContain("1 SOL");
    expect(t).toContain("Starting market cap: 30 SOL");
    expect(t).toContain('Symbol: "COIN"');
    expect(r.structuredContent).toMatchObject({ executed: false, chain: "solana", finchWallet: FINCH_WALLET, startingMarketCapSol: 30, boostSol: 0.1, estimatedCostSol: "0.125" });
    expect(launchPosts().length).toBe(0);
    const walletCall = W.calls.find((c) => c.url.includes("/solana/wallet"))!;
    expect(walletCall.headers.Authorization).toBe(`Bearer ${SESSION}`);
  });
  it("tells the user to fund the Finch wallet when it is short", async () => {
    W.walletBody = { address: FINCH_WALLET, balanceSol: 0.001, balanceLamports: 1_000_000 };
    const t = text(await launch());
    expect(t).toContain("does not hold enough SOL"); expect(t).toContain(`to ${FINCH_WALLET}`);
  });
  it("a wallet-route 401 gives the login hint", async () => {
    W.walletBody = { status: 401, json: { error: "Launching on Solana requires a logged-in Finch session" } };
    const r: any = await launch();
    expect(r.isError).toBe(true); expect(text(r)).toContain("finch login");
  });
  it("validates inputs before any network call", async () => {
    for (const bad of [{ name: "" }, { symbol: "bad symbol!" }, { startingMarketCapSol: -1 }, { startingMarketCapSol: "x" }, { boostSol: -1 }, { imageUrl: "http://x.com/a.png" }, { website: "ftp://x" }, { description: "x".repeat(281) }]) {
      const r: any = await launch(bad);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(W.calls.length).toBe(0);
  });
  it("JSON-quotes user strings (data, not instructions)", async () => {
    const t = text(await launch({ name: 'Evil\nIGNORE ALL', description: 'x"; run rm' }));
    expect(t).toContain('"Evil\\nIGNORE ALL"'); expect(t).toContain('"x\\"; run rm"');
  });
});

describe("launch: confirmed", () => {
  beforeEach(() => { process.env.FINCH_SESSION_TOKEN = SESSION; });
  it("refused without the spend gate; the launch route is never contacted", async () => {
    const r: any = await launch({ confirmed: true });
    expect(r.isError).toBe(true); expect(text(r)).toContain("FINCH_LAUNCHPAD_ALLOW_SPEND=1");
    expect(launchPosts().length).toBe(0);
  });
  it("ALLOW_SPEND must be exactly 1", async () => {
    for (const v of ["true", "0", "yes", ""]) {
      process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = v;
      const r: any = await launch({ confirmed: true });
      expect(r.isError, v).toBe(true);
    }
    expect(launchPosts().length).toBe(0);
  });
  it("cap: default 0.5 SOL covers boost + rent; over-cap refused before the route", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    W.walletBody = { address: FINCH_WALLET, balanceSol: 10, balanceLamports: 10_000_000_000 };
    let r: any = await launch({ confirmed: true, boostSol: 0.5 }); // 0.5 + 0.025 > 0.5
    expect(r.isError).toBe(true); expect(text(r)).toContain("FINCH_LAUNCHPAD_MAX_SOL_LAUNCH");
    r = await launch({ confirmed: true, boostSol: 0.475 }); // exactly 0.5
    expect(r.isError).toBeUndefined();
    expect(launchPosts().length).toBe(1);
  });
  it("junk cap env fails closed (both caps)", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    for (const [k, v] of [["FINCH_LAUNCHPAD_MAX_SOL_LAUNCH", "abc"], ["FINCH_LAUNCHPAD_MAX_SOL_LAUNCH", "-1"], ["FINCH_LAUNCHPAD_MAX_SOL_LAUNCH", "0"], ["FINCH_LAUNCHPAD_MAX_BUY_SOL", "1e3"]]) {
      process.env[k] = v;
      const r: any = await launch({ confirmed: true });
      expect(r.isError, `${k}=${v}`).toBe(true);
      delete process.env[k];
    }
    expect(launchPosts().length).toBe(0);
  });
  it("insufficient Finch wallet balance: refused with the deposit address, route not contacted", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    W.walletBody = { address: FINCH_WALLET, balanceSol: 0.01, balanceLamports: 10_000_000 };
    const r: any = await launch({ confirmed: true });
    expect(r.isError).toBe(true); expect(text(r)).toContain(FINCH_WALLET);
    expect(launchPosts().length).toBe(0);
  });
  it("success: one POST with the session bearer, exact body, verified + reported result", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const r: any = await launch({ confirmed: true, description: "d", imageUrl: "https://x.com/a.png", agentBrief: "build x", startingMarketCapSol: 45 });
    expect(r.isError).toBeUndefined();
    expect(launchPosts().length).toBe(1);
    const p = launchPosts()[0];
    expect(p.headers.Authorization).toBe(`Bearer ${SESSION}`);
    expect(p.headers["X-Wallet-Signature"]).toBeUndefined();
    expect(p.body).toEqual({ name: "Coin", symbol: "COIN", startingMarketCapSol: 45, description: "d", imageUrl: "https://x.com/a.png", agentBrief: "build x" });
    expect(r.structuredContent).toMatchObject({ executed: true, mint: NEW_MINT, poolId: NEW_POOL, mintTx: SIG1, poolTx: SIG2, wallet: FINCH_WALLET, agentSlug: "new-agent", splitVerified: true });
    expect(text(r)).toContain(NEW_MINT);
    expect(text(r)).toContain("90% agent / 10% you / 0% Finch");
  });
  it("default startingMarketCapSol is 30; boostSol is forwarded when > 0", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    await launch({ confirmed: true });
    expect(launchPosts()[0].body.startingMarketCapSol).toBe(30);
    expect(launchPosts()[0].body.boostSol).toBeUndefined();
    await launch({ confirmed: true, boostSol: 0.2 });
    expect(launchPosts()[1].body.boostSol).toBe(0.2);
  });
  it("a lost response is NEVER retried and the user is told to check first", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    W.launch = () => ({ status: 0, throw: true });
    const r: any = await launch({ confirmed: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("DO NOT retry"); expect(text(r)).toContain("launchpad_token");
    expect(launchPosts().length).toBe(1);
  });
  it("a 5xx is never retried and warns the launch may have executed", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    W.launch = () => ({ status: 502, json: { error: "Something went wrong" } });
    const r: any = await launch({ confirmed: true });
    expect(text(r)).toContain("may have been executed"); expect(text(r)).toContain("DO NOT retry");
    expect(launchPosts().length).toBe(1);
  });
  it("a 4xx says nothing was launched; a 401 says finch login", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    W.launch = () => ({ status: 429, json: { error: "Daily launch limit reached (3 per 24h)." } });
    expect(text(await launch({ confirmed: true }))).toContain("Nothing was launched");
    W.launch = () => ({ status: 401, json: { error: "Launching on Solana requires a logged-in Finch session", hint: "Run `finch login` first" } });
    expect(text(await launch({ confirmed: true }))).toContain("finch login");
  });
  it("a malformed success body is an error that still says do not retry", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    for (const bad of [{ ok: true, mint: "not-a-pubkey", poolId: NEW_POOL, mintTx: SIG1, poolTx: SIG2, wallet: FINCH_WALLET }, { ok: false }, { ok: true, mint: NEW_MINT, poolId: NEW_POOL, mintTx: "x", poolTx: SIG2, wallet: FINCH_WALLET }, {}]) {
      W.launch = () => ({ status: 200, json: bad });
      const r: any = await launch({ confirmed: true });
      expect(r.isError, JSON.stringify(bad)).toBe(true); expect(text(r)).toContain("DO NOT retry");
    }
  });
  it("executing wallet different from the previewed one is flagged", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const other = Keypair.generate().publicKey.toBase58();
    W.launch = () => ({ status: 200, json: { ok: true, mint: NEW_MINT, poolId: NEW_POOL, mintTx: SIG1, poolTx: SIG2, wallet: other, split: { agentBps: 9000, creatorBps: 1000, platformBps: 0 } } });
    const r: any = await launch({ confirmed: true });
    expect(r.isError).toBe(true); expect(text(r)).toContain(NEW_MINT);
  });
  it("an untruthful split in the response is reported, not hidden", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    W.launch = () => ({ status: 200, json: { ok: true, mint: NEW_MINT, poolId: NEW_POOL, mintTx: SIG1, poolTx: SIG2, wallet: null, split: { agentBps: 5000, creatorBps: 4000, platformBps: 1000 } } });
    const r: any = await launch({ confirmed: true });
    expect(r.structuredContent.splitVerified).toBe(false);
    expect(text(r)).toContain("UNEXPECTED fee split");
  });
  it("retryRegisterTxHash is rejected for Solana", async () => {
    const r: any = await launch({ confirmed: true, retryRegisterTxHash: "0x" + "ab".repeat(32) });
    expect(r.isError).toBe(true);
  });
});

describe("buy/sell: resolution refusals", () => {
  it("not a Finch launch (404) / wrong source / wrong chain / no pool", async () => {
    W.token = "404";
    expect(text(await buy())).toContain("not a Finch launch");
    W.token = finchTokenBody({ source: "pumpfun" });
    expect(text(await buy())).toContain("not a Finch-launched token");
    W.token = finchTokenBody({ source: null });
    expect((await buy() as any).isError).toBe(true);
    W.token = finchTokenBody({ chain: "base" });
    expect((await buy() as any).isError).toBe(true);
    W.token = finchTokenBody({ poolId: null });
    expect(text(await buy())).toContain("no pool recorded");
    expect(rpcCalls("sendTransaction").length).toBe(0);
  });
  it("pool owned by another program, wrong layout, not a SOL pair, wrong token", async () => {
    W.poolOwner = "11111111111111111111111111111111";
    expect(text(await buy())).toContain("not owned by the Meteora");
    W.poolOwner = L.METEORA_CP_AMM_PROGRAM.toBase58();
    W.poolData = Buffer.alloc(1112); // no discriminator
    expect(text(await buy())).toContain("not a cp-amm pool");
    const b = Buffer.from(poolFixture.data, "base64"); b.fill(7, 200, 232); // tokenB mint no longer WSOL
    W.poolData = b;
    expect(text(await buy())).toContain("not a SOL pair");
    const c = Buffer.from(poolFixture.data, "base64"); c.fill(9, 168, 200); // token side != requested mint
    W.poolData = c;
    expect(text(await buy())).toMatch(/does not match the token/);
  });
  it("the pool must advertise a mint that is a classic 9-dec SPL mint", async () => {
    W.mintOwner = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    expect(text(await buy())).toContain("classic SPL");
  });
  it("slippage ceiling 5%; default 1%", async () => {
    expect((await buy({ slippagePct: 6 }) as any).isError).toBe(true);
    expect((await buy({ slippagePct: 0 }) as any).isError).toBe(true);
    const r: any = await buy();
    expect(r.structuredContent.slippageBps).toBe(100);
    expect(((await buy({ slippagePct: 5 })) as any).structuredContent.slippageBps).toBe(500);
  });
  it("amount validation", async () => {
    for (const amount of ["0", "-1", "abc", "1e3", "0.0000000001", ""]) expect((await buy({ amount }) as any).isError, amount).toBe(true);
  });
  it("non-solana chain still routes to EVM validation (no solana path)", async () => {
    const r: any = await handleLaunchpadSwapTool("launchpad_buy", { chain: "ethereum", token: MINT, amount: "1" });
    expect(r.isError).toBe(true);
  });
});

describe("buy: preview and confirmation binding", () => {
  it("preview quotes locally, shows min received + impact, sends and simulates nothing", async () => {
    const r: any = await buy();
    const t = text(r);
    expect(t).toContain("NOT EXECUTED"); expect(t).toContain("direct Meteora cp-amm swap"); expect(t).toContain("Price impact:");
    expect(r.structuredContent).toMatchObject({ executed: false, chain: "solana", side: "buy", token: MINT, pool: POOL, amountIn: "0.1", slippageBps: 100 });
    const s = L.decodeSwapPool(W.poolData);
    const q = L.quoteExactIn(s, L.WSOL_MINT, 100_000_000n, 100, 9, 9, 0n);
    expect(r.structuredContent.expectedOut).toBe(`${q.outAmount / 10n ** 9n}.${(q.outAmount % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, "")}`);
    expect(rpcCalls("sendTransaction").length + rpcCalls("simulateTransaction").length).toBe(0);
  });
  it("confirmed=true with no / wrong quoteId is ignored (preview again)", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    for (const quoteId of [undefined, "deadbeefdeadbeef"]) {
      const r: any = await buy({ confirmed: true, quoteId });
      expect(text(r)).toContain("confirmed=true was ignored");
    }
    expect(rpcCalls("sendTransaction").length).toBe(0);
  });
  it("a quoteId from a different amount does not authorize this amount", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const prev: any = await buy({ amount: "0.1" });
    const r: any = await buy({ amount: "0.2", confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(text(r)).toContain("confirmed=true was ignored");
  });
  it("default-deny gate: a confirmed buy is refused unless FINCH_LAUNCHPAD_ALLOW_SPEND=1", async () => {
    const r: any = await buyConfirm();
    expect(r.isError).toBe(true); expect(text(r)).toContain("FINCH_LAUNCHPAD_ALLOW_SPEND=1");
    expect(rpcCalls("sendTransaction").length).toBe(0);
    expect(text(await buy())).toContain("spending is disabled");
  });
  it("buy cap: default 0.5 SOL, env override, junk fails closed", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    let r: any = await buyConfirm({ amount: "0.6" });
    expect(r.isError).toBe(true); expect(text(r)).toContain("FINCH_LAUNCHPAD_MAX_BUY_SOL");
    process.env.FINCH_LAUNCHPAD_MAX_BUY_SOL = "0.05";
    r = await buyConfirm({ amount: "0.1" });
    expect(r.isError).toBe(true); expect(text(r)).toContain("0.05");
    for (const junk of ["abc", "-1", "0", "1e3", "0.1.2"]) {
      process.env.FINCH_LAUNCHPAD_MAX_BUY_SOL = junk;
      r = await buyConfirm({ amount: "0.01" });
      expect(r.isError, junk).toBe(true);
    }
    expect(rpcCalls("sendTransaction").length).toBe(0);
  });
  it("price impact above 5% is rejected (no quoteId issued)", async () => {
    const r: any = await buy({ amount: "5" });
    expect(r.isError).toBe(true); expect(text(r)).toContain("price impact"); expect(r.structuredContent.rejected).toBe("price_impact");
  });
  it("quote drift: a worse live quote (>0.5%) than the preview is refused", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const prev: any = await buy();
    const b = Buffer.from(W.poolData); b.writeBigUInt64LE(10_000_000n, 8); W.poolData = b; // fee 0.25% -> 1% (0.75% worse)
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.isError).toBe(true); expect(text(r)).toContain("Quote moved");
    expect(rpcCalls("sendTransaction").length).toBe(0);
  });
  it("a slightly different live quote (<0.5%) is accepted", async () => {
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    const prev: any = await buy();
    const b = Buffer.from(W.poolData); b.writeBigUInt64LE(2_700_000n, 8); W.poolData = b; // 0.25% -> 0.27% fee: ~0.02% worse
    W.simTokenDelta = 10n ** 18n;
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.isError).toBeUndefined();
  });
});

describe("buy: execution", () => {
  beforeEach(() => { process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1"; W.simSolDelta = -100_000_000n - 5_000_000n; W.simTokenDelta = 10n ** 18n; });

  it("sends exactly the planned transaction (programs allowlisted, minOut == quote)", async () => {
    const r: any = await buyConfirm();
    expect(r.isError, text(r)).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ executed: true, confirmed: true, signature: SIG1 });
    expect(W.sent.length).toBe(1);
    const tx = VersionedTransaction.deserialize(Buffer.from(W.sent[0], "base64"));
    const keys = tx.message.staticAccountKeys;
    expect(keys[0].toBase58()).toBe(me.toBase58());
    const progs = tx.message.compiledInstructions.map((i) => keys[i.programIdIndex].toBase58());
    expect(progs).toEqual(["ComputeBudget111111111111111111111111111111", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", L.METEORA_CP_AMM_PROGRAM.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    for (const p of progs) expect(L.SOLANA_SWAP_PROGRAMS).toContain(p);
    const swap = tx.message.compiledInstructions[5];
    const q = L.quoteExactIn(L.decodeSwapPool(W.poolData), L.WSOL_MINT, 100_000_000n, 100, 9, 9, 0n);
    expect(Buffer.from(swap.data).toString("hex")).toBe(L.encodeSwapData(100_000_000n, q.minOut).toString("hex"));
    expect(tx.signatures.length).toBe(1);
    expect(tx.signatures[0].some((b) => b !== 0)).toBe(true); // signed
    expect(rpcCalls("simulateTransaction").length).toBe(1);
  });

  it("simulation: SOL dropping by more than input + reserve is refused, nothing sent", async () => {
    W.simSolDelta = -(100_000_000n + L.SWAP_RESERVE + 1n);
    const r: any = await buyConfirm();
    expect(r.isError).toBe(true); expect(text(r)).toContain("SOL balance dropping");
    expect(W.sent.length).toBe(0);
  });
  it("simulation: SOL drop exactly at input + reserve passes", async () => {
    W.simSolDelta = -(100_000_000n + L.SWAP_RESERVE);
    const r: any = await buyConfirm();
    expect(r.isError, text(r)).toBeUndefined();
  });
  it("simulation: receiving less token than the quoted minimum is refused", async () => {
    const q = L.quoteExactIn(L.decodeSwapPool(W.poolData), L.WSOL_MINT, 100_000_000n, 100, 9, 9, 0n);
    W.simTokenDelta = q.minOut - 1n;
    const r: any = await buyConfirm();
    expect(r.isError).toBe(true); expect(text(r)).toContain("less");
    expect(W.sent.length).toBe(0);
  });
  it("simulation error / missing post-state: refused", async () => {
    W.simErr = { InstructionError: [5, "Custom"] };
    expect((await buyConfirm() as any).isError).toBe(true);
    W.simErr = null; W.simDropAccounts = true;
    expect((await buyConfirm() as any).isError).toBe(true);
    expect(W.sent.length).toBe(0);
  });
  it("insufficient SOL (amount + 0.01 reserve): refused", async () => {
    W.solBalance = 100_000_000n + L.SWAP_RESERVE - 1n;
    const r: any = await buyConfirm();
    expect(r.isError).toBe(true); expect(text(r)).toContain("Insufficient SOL");
    expect(W.sent.length).toBe(0);
  });
  it("no local wallet: preview works, confirmed refuses", async () => {
    const prev: any = await buy();
    fs.rmSync(path.join(TMP_HOME, ".finch", "solana-wallet.json"));
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.isError).toBe(true); expect(text(r)).toContain("sol_wallet");
  });
  it("wallet changed between preview and execution: refused (everything else would succeed)", async () => {
    const prev: any = await buy();
    fs.rmSync(path.join(TMP_HOME, ".finch", "solana-wallet.json"));
    me = loadSolanaKeypair(true)!.keypair.publicKey; // the mocked chain now follows the NEW wallet: only the binding check can stop it
    const r: any = await buy({ confirmed: true, quoteId: prev.structuredContent.quoteId });
    expect(r.isError).toBe(true); expect(text(r)).toContain("Wallet changed");
    expect(W.sent.length).toBe(0);
  });
  it("a transaction that differs from the plan (extra instruction, even an allowlisted one) is never signed or sent", async () => {
    tamper.on = true;
    try {
      const r: any = await buyConfirm();
      expect(r.isError).toBe(true); expect(text(r)).toContain("expected 7");
      expect(W.sent.length).toBe(0);
      expect(rpcCalls("simulateTransaction").length).toBe(0);
    } finally { tamper.on = false; }
  });
  it("a tampered transaction (extra instruction) would be caught by the plan check", () => {
    const wallet = Keypair.generate().publicKey;
    const state = L.decodeSwapPool(Buffer.from(poolFixture.data, "base64"));
    const ixs = L.buildSwapInstructions({ wallet, pool: new PublicKey(POOL), state, inputMint: L.WSOL_MINT, amountIn: 1n, minOut: 1n, tokenAProgram: L.TOKEN_PROGRAM, tokenBProgram: L.TOKEN_PROGRAM });
    const good = L.compileSwapTx(wallet, Keypair.generate().publicKey.toBase58(), ixs);
    expect(() => L.assertTxMatchesPlan(good, ixs)).not.toThrow();
    const extra = [...ixs, ixs[0]];
    expect(() => L.assertTxMatchesPlan(L.compileSwapTx(wallet, Keypair.generate().publicKey.toBase58(), extra), ixs)).toThrow(/instructions/);
    const lowered = [...ixs]; lowered[5] = { ...ixs[5], data: L.encodeSwapData(1n, 0n), keys: ixs[5].keys, programId: ixs[5].programId } as any;
    expect(() => L.assertTxMatchesPlan(L.compileSwapTx(wallet, Keypair.generate().publicKey.toBase58(), lowered), ixs)).toThrow(/data differs/);
  });
});

describe("sell", () => {
  beforeEach(() => { process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1"; W.poolData = tradedPool(); W.tokenBalance = 5_000_000_000_000n; W.simTokenDelta = -1n; });

  it("needs a balance; amount > balance refused; exactly one of percent/amount", async () => {
    W.tokenBalance = 0n;
    expect(text(await sell())).toContain("holds none");
    W.tokenBalance = 1_000_000_000n;
    expect((await sell({ percent: undefined, amount: "2" }) as any).isError).toBe(true);
    expect((await sell({ percent: 50, amount: "1" }) as any).isError).toBe(true);
    expect((await sell({ percent: undefined }) as any).isError).toBe(true);
    expect((await sell({ percent: 101 }) as any).isError).toBe(true);
    expect((await sell({ percent: 0 }) as any).isError).toBe(true);
  });
  it("preview quotes the token -> SOL leg locally", async () => {
    const r: any = await sell({ percent: 10 });
    expect(r.structuredContent).toMatchObject({ side: "sell", chain: "solana", amountIn: "500" });
    expect(text(r)).toContain("unwrapped to native SOL");
  });
  it("sends [fee, ata, ata, swap, close] with token input; no approvals/transfers", async () => {
    const amountIn = 500_000_000_000n; // 10% of balance
    const q = L.quoteExactIn(L.decodeSwapPool(W.poolData), new PublicKey(MINT), amountIn, 100, 9, 9, 0n);
    W.simTokenDelta = -amountIn; W.simSolDelta = q.outAmount - 5_000_000n;
    const r: any = await sellConfirm({ percent: 10 });
    expect(r.isError, text(r)).toBeUndefined();
    expect(W.sent.length).toBe(1);
    const tx = VersionedTransaction.deserialize(Buffer.from(W.sent[0], "base64"));
    const keys = tx.message.staticAccountKeys;
    const progs = tx.message.compiledInstructions.map((i) => keys[i.programIdIndex].toBase58());
    expect(progs).toEqual(["ComputeBudget111111111111111111111111111111", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", L.METEORA_CP_AMM_PROGRAM.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
    const swap = tx.message.compiledInstructions[3];
    expect(Buffer.from(swap.data).toString("hex")).toBe(L.encodeSwapData(amountIn, q.minOut).toString("hex"));
  });
  it("sell: token leaving beyond the input is refused by the simulation guard", async () => {
    const amountIn = 500_000_000_000n;
    W.simTokenDelta = -(amountIn + 1n); W.simSolDelta = 10n ** 9n;
    const r: any = await sellConfirm({ percent: 10 });
    expect(r.isError).toBe(true); expect(text(r)).toContain("leaving the wallet");
    expect(W.sent.length).toBe(0);
  });
  it("sell: SOL proceeds below the quoted minimum (minus reserve) are refused", async () => {
    const amountIn = 500_000_000_000n;
    const q = L.quoteExactIn(L.decodeSwapPool(W.poolData), new PublicKey(MINT), amountIn, 100, 9, 9, 0n);
    W.simTokenDelta = -amountIn; W.simSolDelta = q.minOut - L.SWAP_RESERVE - 1n;
    const r: any = await sellConfirm({ percent: 10 });
    expect(r.isError).toBe(true); expect(text(r)).toContain("receiving only");
    expect(W.sent.length).toBe(0);
  });
  it("sell is also gated by the default-deny switch and the preview binding", async () => {
    delete process.env.FINCH_LAUNCHPAD_ALLOW_SPEND;
    expect((await sellConfirm({ percent: 10 }) as any).isError).toBe(true);
    process.env.FINCH_LAUNCHPAD_ALLOW_SPEND = "1";
    expect(text(await sell({ percent: 10, confirmed: true }))).toContain("confirmed=true was ignored");
    expect(W.sent.length).toBe(0);
  });
  it("sell: price impact above 5% is rejected", async () => {
    W.tokenBalance = 10n ** 18n;
    const r: any = await sell({ percent: 100 });
    expect(r.isError).toBe(true);
  });
  it("sell on a pool at its price floor cannot be quoted (clear error, nothing sent)", async () => {
    W.poolData = Buffer.from(poolFixture.data, "base64");
    const r: any = await sell({ percent: 10 });
    expect(r.isError).toBe(true);
    expect(W.sent.length).toBe(0);
  });
});

describe("helpers", () => {
  it("solanaCapLamports parses decimals exactly and fails closed", () => {
    process.env.TEST_CAP = "0.123456789";
    expect(solanaCapLamports("TEST_CAP", "1")).toBe(123_456_789n);
    delete process.env.TEST_CAP;
    expect(solanaCapLamports("TEST_CAP", "0.5")).toBe(500_000_000n);
    for (const bad of ["x", "0", "-1", "1e3", "0.1234567891"]) { process.env.TEST_CAP = bad; expect(() => solanaCapLamports("TEST_CAP", "1"), bad).toThrow(/fail closed/); }
    delete process.env.TEST_CAP;
  });
});
