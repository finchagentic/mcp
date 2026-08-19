// RH RPC access — provider, raw eth_call/eth_getBalance, and the wei/decimal
// helpers everything else in rh-mcp-* builds on.

import { ethers } from "ethers";
import { CONVEX_SITE } from "../convex.js";
import { getSavedToken } from "../config.js";
import { RH_RPC, RH_CHAIN_ID } from "./rh-mcp-constants.js";
import { dexTokenBest } from "./rh-mcp-dex.js";

// Some networks can't reach the RH RPC at all (e.g. ISPs that DNS-block
// robinhood.com), which would break balances, approvals and broadcasting. Probe
// once, then transparently relay through Convex — which can reach it — instead.
const RH_RPC_RELAY = `${CONVEX_SITE}/mcp/rh/rpc`;
let _rhRpcMode: "direct" | "relay" | null = null;

async function rhRpcMode(): Promise<"direct" | "relay"> {
  if (_rhRpcMode) return _rhRpcMode;
  try {
    const res = await fetch(RH_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      _rhRpcMode = "direct";
      return _rhRpcMode;
    }
  } catch {
    /* blocked or unreachable → relay */
  }
  _rhRpcMode = "relay";
  return _rhRpcMode;
}

/** Auth header for the Convex relay (session token or API key). */
function rhRelayHeaders(): Record<string, string> {
  const token = getSavedToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Provider that works on both paths — relays via Convex when RPC is blocked. */
export async function rhProviderAsync(): Promise<ethers.JsonRpcProvider> {
  if ((await rhRpcMode()) === "direct") {
    return new ethers.JsonRpcProvider(RH_RPC, RH_CHAIN_ID);
  }
  const req = new ethers.FetchRequest(RH_RPC_RELAY);
  for (const [k, v] of Object.entries(rhRelayHeaders())) req.setHeader(k, v);
  return new ethers.JsonRpcProvider(req, RH_CHAIN_ID);
}

export async function rhRpc(method: string, params: unknown[]): Promise<any> {
  const relay = (await rhRpcMode()) === "relay";
  const url = relay ? RH_RPC_RELAY : RH_RPC;
  const res = await fetch(url, {
    method: "POST",
    headers: relay ? rhRelayHeaders() : { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RH RPC HTTP ${res.status}${relay ? " (via relay)" : ""}`);
  const data = (await res.json()) as any;
  if (data.error) throw new Error(data.error.message ?? "RH RPC error");
  return data.result;
}

function encodeBalanceOf(addr: string): string {
  return "0x70a08231" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

/** Raw ERC-20 balanceOf(owner) on RH chain (wei). 0n on any failure. */
export async function rhErc20Balance(token: string, owner: string): Promise<bigint> {
  try {
    const hex = await rhRpc("eth_call", [{ to: token, data: encodeBalanceOf(owner) }, "latest"]);
    if (hex && hex !== "0x") return BigInt(hex);
  } catch {
    /* 0 */
  }
  return 0n;
}

/** Current USD price of a token on RH chain via DexScreener, or null. */
export async function rhPriceUsd(address: string): Promise<number | null> {
  const dex = await dexTokenBest(address);
  const p = dex?.priceUsd != null ? Number(dex.priceUsd) : NaN;
  return isFinite(p) ? p : null;
}

/** ERC-20 decimals() via RH RPC; falls back to 18. */
export async function erc20Decimals(addr: string): Promise<number> {
  try {
    const hex = await rhRpc("eth_call", [{ to: addr, data: "0x313ce567" }, "latest"]);
    if (hex && hex !== "0x") {
      const d = Number(BigInt(hex));
      if (d > 0 && d <= 36) return d;
    }
  } catch {
    /* default 18 */
  }
  return 18;
}

export function parseHumanToWei(amount: string, decimals = 18): string {
  const a = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(a)) throw new Error(`Invalid amount: ${amount}`);
  return ethers.parseUnits(a, decimals).toString();
}

export function formatWei(raw: string, decimals = 18, maxFrac = 6): string {
  try {
    const n = Number(ethers.formatUnits(raw, decimals));
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  } catch {
    return raw;
  }
}
