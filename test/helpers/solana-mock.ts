import { vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import { SOL_MINT, FINCH_MINT, JUPITER_V6_PROGRAM, TOKEN_PROGRAM } from "../../src/tools/solana.js";

export const RPC = "https://rpc.example.invalid";
export const calls: Array<{ url: string; init?: any }> = [];
export const text = (r: any) => r.content[0].text as string;

export function jupQuote(priceImpactFraction: string | null, out: string, threshold: string | null, inAmount: string) {
  const q: any = {
    inputMint: SOL_MINT, inAmount, outputMint: FINCH_MINT, outAmount: out,
    swapMode: "ExactIn", slippageBps: 50,
    routePlan: [{ swapInfo: { label: "Pump.fun Amm" } }, { swapInfo: { label: "Raydium" } }],
  };
  if (priceImpactFraction !== null) q.priceImpactPct = priceImpactFraction;
  if (threshold !== null) q.otherAmountThreshold = threshold;
  return q;
}

export const b64tx = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString("base64");

/** A benign Jupiter-style tx: compute budget + a Jupiter-program instruction that signs with the wallet. */
export function benignJupiterTx(payer: PublicKey, extra: TransactionInstruction[] = [], lookups: AddressLookupTableAccount[] = []): VersionedTransaction {
  const ixs = [
    new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: Buffer.from([2, 0x40, 0x0d, 0x03, 0x00]) }),
    new TransactionInstruction({ programId: new PublicKey(JUPITER_V6_PROGRAM), keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) }),
    ...extra,
  ];
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message(lookups);
  return new VersionedTransaction(msg);
}

export interface MockOpts {
  impact?: string | undefined; noImpact?: boolean; noThreshold?: boolean;
  out?: string; threshold?: string;
  balanceLamports?: number;
  swapTx?: (payer: PublicKey) => VersionedTransaction;
  simDecreaseLamports?: number;     // wallet SOL decrease reported by simulation
  simTokenOut?: bigint;             // token amount gained by wallet ATA (index 1)
  simErr?: any;
  tables?: Record<string, Buffer>;  // lookup-table account data by address
  mintExtensions?: any[];           // Token-2022 mint extensions
  mintOwner?: string;
  extra?: (u: string, init: any) => Response | undefined | Promise<Response | undefined>;
}

export function mockFetch(opts: MockOpts = {}) {
  calls.length = 0;
  const bal = opts.balanceLamports ?? 5_000_000_000;
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (opts.extra) { const r = await opts.extra(u, init); if (r) return r; }
    if (u.startsWith("https://lite-api.jup.ag/swap/v1/quote")) {
      const amt = new URL(u).searchParams.get("amount") ?? "100000000";
      const q = jupQuote(opts.noImpact ? null : (opts.impact ?? "0.001"), opts.out ?? "193041101607552", opts.noThreshold ? null : (opts.threshold ?? "192075896099515"), amt);
      return json(q);
    }
    if (u === "https://lite-api.jup.ag/swap/v1/swap") {
      const body = JSON.parse(init.body);
      const payer = new PublicKey(body.userPublicKey);
      return json({ swapTransaction: b64tx((opts.swapTx ?? ((p) => benignJupiterTx(p)))(payer)) });
    }
    if (u.startsWith(RPC)) {
      const { method, params } = JSON.parse(init.body);
      const res = (result: any) => json({ jsonrpc: "2.0", id: 1, result });
      if (method === "getBalance") return res({ value: bal });
      if (method === "getLatestBlockhash") return res({ value: { blockhash: "11111111111111111111111111111111" } });
      if (method === "getTokenAccountsByOwner") return res({ value: [] });
      if (method === "sendTransaction") return res("FAKESIG");
      if (method === "getSignatureStatuses") return res({ value: [{ err: null, confirmationStatus: "confirmed" }] });
      if (method === "getAccountInfo") {
        return res({ value: { owner: opts.mintOwner ?? TOKEN_PROGRAM, data: { parsed: { info: { decimals: 6, extensions: opts.mintExtensions } } } } });
      }
      if (method === "getTokenAccountBalance") return res({ value: { amount: "1000000000" } });
      if (method === "getMultipleAccounts") {
        const keys: string[] = params[0];
        return res({ value: keys.map((k, i) => {
          if (opts.tables?.[k]) return { lamports: 1, owner: "AddressLookupTab1e1111111111111111111111111", data: [opts.tables[k].toString("base64"), "base64"] };
          const d = Buffer.alloc(165); // token account, amount 0
          return i === 0 ? { lamports: bal, owner: "11111111111111111111111111111111", data: ["", "base64"] } : { lamports: 2039280, owner: TOKEN_PROGRAM, data: [d.toString("base64"), "base64"] };
        }) });
      }
      if (method === "simulateTransaction") {
        const addrs: string[] = params[1].accounts?.addresses ?? [];
        return res({ value: { err: opts.simErr ?? null, logs: [], unitsConsumed: 1, accounts: addrs.map((_, i) => {
          if (i === 0) return { lamports: bal - (opts.simDecreaseLamports ?? 0), owner: "11111111111111111111111111111111", data: ["", "base64"] };
          const d = Buffer.alloc(165);
          if (i === 1) d.writeBigUInt64LE(opts.simTokenOut ?? 10_000_000_000_000_000n, 64);
          return { lamports: 2039280, owner: TOKEN_PROGRAM, data: [d.toString("base64"), "base64"] };
        }) } });
      }
      return json({ jsonrpc: "2.0", id: 1, error: { message: "unmocked " + method } });
    }
    return json({ error: "unmocked " + u }, 404);
  }));
}

export const sentTx = () => calls.filter((c) => c.url.startsWith(RPC) && JSON.parse(c.init.body).method === "sendTransaction");
export { Keypair, SystemProgram };
