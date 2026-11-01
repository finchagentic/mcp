// Hard allowlists + calldata validation for every EVM transaction the local wallet signs.
// A quote comes from a remote backend (and, behind it, an aggregator): it is DATA, not authority.
// Nothing here trusts `tx.to`, `tx.value` or the calldata of a quote until it has been checked
// against constants compiled into this package.

import { ethers } from "ethers";

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const RH_CHAIN_ID_GUARD = 4663;
export const BASE_CHAIN_ID_GUARD = 8453;

const lc = (s: string) => s.toLowerCase();

/** Known-good contracts per chain. Extra routers can only be added by the operator via env (never by a tool arg). */
const BUILTIN: Record<number, string[]> = {
  [RH_CHAIN_ID_GUARD]: [
    PERMIT2,
    "0x8876789976decbfcbbbe364623c63652db8c0904", // Uniswap Universal Router (RH)
  ],
  [BASE_CHAIN_ID_GUARD]: [
    PERMIT2,
    "0x6fF5693b99212Da76ad316178A184AB56D299b43", // Uniswap Universal Router (Base)
    "0x0000000000001fF3684f28c67538d4D072C22734", // 0x AllowanceHolder
    "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", // 0x Exchange Proxy
  ],
};

export function allowedContracts(chainId: number): Set<string> {
  const extra = (process.env.FINCH_EXTRA_ROUTERS ?? "")
    .split(",").map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
  return new Set([...(BUILTIN[chainId] ?? []), ...extra].map(lc));
}

export function isAllowedSpender(chainId: number, spender: string): boolean {
  return allowedContracts(chainId).has(lc(spender));
}

export function assertAllowedSpender(chainId: number, spender: string): void {
  if (!ethers.isAddress(spender) || !isAllowedSpender(chainId, spender)) {
    throw new Error(
      `Refusing to approve spender ${spender}: not on the hard allowlist for chain ${chainId} (Permit2 / known routers). ` +
      "An operator can extend it with FINCH_EXTRA_ROUTERS=0x...,0x... in the MCP server env.",
    );
  }
}

export function assertAllowedTarget(chainId: number, to: string): void {
  if (!ethers.isAddress(to) || !isAllowedSpender(chainId, to)) {
    throw new Error(
      `Refusing to sign a transaction to ${to}: not a known router/Permit2 on chain ${chainId}. ` +
      "The quote may be malicious or corrupted. Operators can extend the allowlist with FINCH_EXTRA_ROUTERS.",
    );
  }
}

/** Slippage policy: default 1%, hard cap 5% (lower with FINCH_MAX_SLIPPAGE_PCT). */
export const DEFAULT_SLIPPAGE_PCT = 1;
export const MAX_SLIPPAGE_PCT = 5;
export function resolveSlippagePct(v: unknown): number {
  const envCap = Number(process.env.FINCH_MAX_SLIPPAGE_PCT);
  const cap = isFinite(envCap) && envCap > 0 ? Math.min(envCap, MAX_SLIPPAGE_PCT) : MAX_SLIPPAGE_PCT;
  if (v == null) return Math.min(DEFAULT_SLIPPAGE_PCT, cap);
  const n = Number(v);
  if (!(n > 0) || n > cap) throw new Error(`maxSlippagePct must be greater than 0 and at most ${cap} (got ${String(v)}).`);
  return n;
}

// ── Universal Router calldata decoding ───────────────────────────────────────
const UR_IFACE = new ethers.Interface([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
  "function execute(bytes commands, bytes[] inputs)",
]);
const coder = ethers.AbiCoder.defaultAbiCoder();

const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

// Command byte -> input ABI types (low 5 bits; 0x80 is the allow-revert flag).
const UR_CMDS: Record<number, { name: string; types: string[]; recipientIdx?: number }> = {
  0x00: { name: "V3_SWAP_EXACT_IN", types: ["address", "uint256", "uint256", "bytes", "bool"], recipientIdx: 0 },
  0x01: { name: "V3_SWAP_EXACT_OUT", types: ["address", "uint256", "uint256", "bytes", "bool"], recipientIdx: 0 },
  0x02: { name: "PERMIT2_TRANSFER_FROM", types: ["address", "address", "uint160"], recipientIdx: 1 },
  0x04: { name: "SWEEP", types: ["address", "address", "uint256"], recipientIdx: 1 },
  0x08: { name: "V2_SWAP_EXACT_IN", types: ["address", "uint256", "uint256", "address[]", "bool"], recipientIdx: 0 },
  0x09: { name: "V2_SWAP_EXACT_OUT", types: ["address", "uint256", "uint256", "address[]", "bool"], recipientIdx: 0 },
  0x0a: { name: "PERMIT2_PERMIT", types: ["bytes", "bytes"] }, // checked structurally below
  0x0b: { name: "WRAP_ETH", types: ["address", "uint256"], recipientIdx: 0 },
  0x0c: { name: "UNWRAP_WETH", types: ["address", "uint256"], recipientIdx: 0 },
  0x10: { name: "V4_SWAP", types: ["bytes", "bytes[]"] },
};
// Deliberately NOT allowed: TRANSFER (0x05), PAY_PORTION (0x06), PERMIT2_TRANSFER_FROM_BATCH (0x0d), anything unknown.

const V4_ACTIONS_OK = new Set([0x06, 0x07, 0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x12, 0x13, 0x14]);
// V4 actions carrying a recipient: TAKE(currency, recipient, amount), TAKE_PAIR(c0, c1, recipient), SWEEP(currency, recipient)
const V4_RECIPIENT: Record<number, { types: string[]; idx: number }> = {
  0x0e: { types: ["address", "address", "uint256"], idx: 1 },
  0x11: { types: ["address", "address", "address"], idx: 2 },
  0x14: { types: ["address", "address"], idx: 1 },
};

function recipientOk(r: string, wallet: string): boolean {
  const x = lc(r);
  return x === lc(wallet) || x === MSG_SENDER || x === ADDRESS_THIS;
}

export interface SwapTxCheck {
  chainId: number;
  wallet: string;
  /** native wei the caller authorised to be sent with the tx (sell amount for ETH-in swaps, else 0) */
  maxValueWei: bigint;
}

const FORBIDDEN_SELECTORS = new Set(["0x095ea7b3", "0xa9059cbb", "0x23b872dd", "0xd505accf", "0x39509351"]); // approve/transfer/transferFrom/permit/increaseAllowance

/** Throws unless the swap tx targets an allowlisted contract, sends at most the authorised value, and (for the
 *  Universal Router) every command and recipient decodes to something a legitimate swap needs. */
export function validateSwapTx(tx: { to: string; data: string; value?: string | bigint; gas?: string }, chk: SwapTxCheck): void {
  assertAllowedTarget(chk.chainId, tx.to);
  const value = BigInt(tx.value ?? 0);
  if (value < 0n || value > chk.maxValueWei) {
    throw new Error(`Quote tx value ${value} wei exceeds the authorised amount ${chk.maxValueWei} wei. Refusing to sign.`);
  }
  if (tx.gas != null && BigInt(tx.gas) > 3_000_000n) throw new Error("Quote tx gas limit is unreasonably high (>3M). Refusing to sign.");
  const data = tx.data || "0x";
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length < 10) throw new Error("Quote tx has malformed calldata. Refusing to sign.");
  const sel = lc(data.slice(0, 10));
  if (FORBIDDEN_SELECTORS.has(sel)) throw new Error(`Quote calldata calls token-level selector ${sel} on the router - not a swap. Refusing to sign.`);
  if (isAddr(tx.to, BUILTIN[chk.chainId]?.[1])) validateUniversalRouter(data, chk.wallet);
}

function isAddr(a: string, b?: string) { return !!b && lc(a) === lc(b); }

function validateUniversalRouter(data: string, wallet: string): void {
  let parsed: ethers.TransactionDescription | null;
  try { parsed = UR_IFACE.parseTransaction({ data }); } catch { parsed = null; }
  if (!parsed) throw new Error("Universal Router calldata is not execute(...). Refusing to sign.");
  const commands = ethers.getBytes(parsed.args[0] as string);
  const inputs = parsed.args[1] as string[];
  if (commands.length === 0 || commands.length !== inputs.length) throw new Error("Universal Router commands/inputs mismatch. Refusing to sign.");
  commands.forEach((byte, i) => {
    const cmd = UR_CMDS[byte & 0x1f];
    if (!cmd) throw new Error(`Universal Router command 0x${byte.toString(16)} is not on the swap allowlist. Refusing to sign.`);
    let dec: any;
    try { dec = coder.decode(cmd.types, inputs[i]); } catch { throw new Error(`Cannot decode ${cmd.name} input. Refusing to sign.`); }
    if (cmd.recipientIdx != null && !recipientOk(dec[cmd.recipientIdx], wallet)) {
      throw new Error(`${cmd.name} pays ${dec[cmd.recipientIdx]} - not the wallet. Refusing to sign.`);
    }
    if (cmd.name === "V4_SWAP") validateV4(dec[0] as string, dec[1] as string[], wallet);
  });
}

function validateV4(actionsHex: string, params: string[], wallet: string): void {
  const actions = ethers.getBytes(actionsHex);
  if (actions.length !== params.length) throw new Error("V4 actions/params mismatch. Refusing to sign.");
  actions.forEach((a, i) => {
    if (!V4_ACTIONS_OK.has(a)) throw new Error(`V4 action 0x${a.toString(16)} is not on the swap allowlist (e.g. TAKE_PORTION). Refusing to sign.`);
    const r = V4_RECIPIENT[a];
    if (r) {
      let dec: any;
      try { dec = coder.decode(r.types, params[i]); } catch { throw new Error("Cannot decode V4 action. Refusing to sign."); }
      if (!recipientOk(dec[r.idx], wallet)) throw new Error(`V4 action 0x${a.toString(16)} pays ${dec[r.idx]} - not the wallet. Refusing to sign.`);
    }
  });
}

/** eth_call the exact tx from the wallet; throws with the revert reason if it would fail. */
export async function simulateTx(
  call: (method: string, params: unknown[]) => Promise<any>,
  from: string,
  tx: { to: string; data: string; value?: string | bigint },
): Promise<void> {
  const v = BigInt(tx.value ?? 0);
  try {
    await call("eth_call", [{ from, to: tx.to, data: tx.data, ...(v > 0n ? { value: "0x" + v.toString(16) } : {}) }, "latest"]);
  } catch (e: any) {
    throw new Error(`Simulation (eth_call) failed - refusing to broadcast: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// ── ERC-20 transfer built locally ────────────────────────────────────────────
const ERC20_IFACE = new ethers.Interface(["function transfer(address to, uint256 amount)", "function approve(address spender, uint256 amount)"]);

export function buildErc20Transfer(token: string, to: string, amount: bigint): { to: string; data: string; value: string } {
  if (!ethers.isAddress(token) || !ethers.isAddress(to)) throw new Error("Invalid token or recipient address.");
  if (amount <= 0n) throw new Error("Amount must be positive.");
  const data = ERC20_IFACE.encodeFunctionData("transfer", [to, amount]);
  verifyErc20Transfer({ to: token, data, value: "0" }, token, to, amount);
  return { to: token, data, value: "0" };
}

/** Decode a tx and prove it is exactly transfer(recipient, amount) on `token` with zero native value. */
export function verifyErc20Transfer(tx: { to: string; data: string; value?: string | bigint }, token: string, recipient: string, amount: bigint): void {
  if (lc(tx.to) !== lc(token)) throw new Error("Transfer target is not the requested token contract.");
  if (BigInt(tx.value ?? 0) !== 0n) throw new Error("ERC-20 transfer must carry zero native value.");
  const d = ERC20_IFACE.parseTransaction({ data: tx.data });
  if (!d || d.name !== "transfer") throw new Error("Calldata is not an ERC-20 transfer.");
  if (lc(d.args[0]) !== lc(recipient) || BigInt(d.args[1]) !== amount) throw new Error("Transfer calldata recipient/amount mismatch.");
}

export function buildApprove(spender: string, amount: bigint): string {
  return ERC20_IFACE.encodeFunctionData("approve", [spender, amount]);
}
