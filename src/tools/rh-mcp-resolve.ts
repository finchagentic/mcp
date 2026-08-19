// Resolve ETH / a catalog stock / a crypto ticker / a raw 0x address to a
// tradeable RH-chain token, plus the Blockscout-backed wallet balance render.

import { ethers } from "ethers";
import {
  RH_STOCKS,
  NATIVE_ETH,
  USDG_ADDRESS,
  USDG_DECIMALS,
  RH_BLOCKSCOUT_V2,
  RH_CHAIN_ID,
  RH_EXPLORER,
  rhRpcDisplay,
} from "./rh-mcp-constants.js";
import { dexTokenBest, dexSearchByTicker, type ResolvedToken } from "./rh-mcp-dex.js";
import { rhRpc, erc20Decimals } from "./rh-mcp-provider.js";

export function isAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

export function isEth(sym: string): boolean {
  const s = sym.trim().toUpperCase();
  return s === "ETH" || s === "WETH" || s === "NATIVE" || s === NATIVE_ETH.toUpperCase();
}

export function resolveStock(input: string): { address: string; symbol: string; name: string } | null {
  const t = input.trim();
  if (isEth(t)) return null;
  if (isAddress(t)) {
    const hit = RH_STOCKS.find((s) => s.address.toLowerCase() === t.toLowerCase());
    return hit ?? { address: t, symbol: t.slice(0, 8), name: "Unknown token" };
  }
  const up = t.toUpperCase();
  return RH_STOCKS.find((s) => s.symbol === up) ?? null;
}

/**
 * Resolve ETH, a catalog stock, a crypto ticker, or a raw 0x address to a
 * tradeable RH-chain token. Tickers resolve via DexScreener (highest liquidity
 * wins) — callers should confirm the contract address with the user first.
 */
export async function resolveTokenSmart(input: string): Promise<ResolvedToken> {
  if (isEth(input)) return { kind: "eth", address: NATIVE_ETH, symbol: "ETH", decimals: 18 };
  const t = input.trim();
  if (t.toUpperCase() === "USDG") {
    return { kind: "token", address: USDG_ADDRESS, symbol: "USDG", name: "Global Dollar", decimals: USDG_DECIMALS };
  }

  // 1) catalog symbol fast-path (22 tokenized stocks, all 18-decimals)
  const cat = RH_STOCKS.find((s) => s.symbol === t.toUpperCase());
  if (cat) return { kind: "token", address: cat.address, symbol: cat.symbol, name: cat.name, decimals: 18 };

  // 2) raw contract address
  if (isAddress(t)) {
    const dex = await dexTokenBest(t);
    const decimals = await erc20Decimals(t);
    const known = resolveStock(t);
    const symbol =
      dex?.baseToken?.address?.toLowerCase() === t.toLowerCase()
        ? dex.baseToken.symbol
        : known?.symbol ?? dex?.quoteToken?.symbol ?? `${t.slice(0, 6)}…`;
    return { kind: "token", address: t, symbol, name: dex?.baseToken?.name ?? known?.name, decimals, dex };
  }

  // 3) crypto ticker via DexScreener
  const cands = await dexSearchByTicker(t);
  if (cands.length === 0) {
    throw new Error(
      `Unknown RH asset "${input}". Not in the stock catalog and no Robinhood-chain token matched on DexScreener. Paste the 0x contract address instead.`
    );
  }
  const best = cands[0];
  const decimals = await erc20Decimals(best.baseToken.address);
  return {
    kind: "token",
    address: best.baseToken.address,
    symbol: best.baseToken.symbol,
    name: best.baseToken.name,
    decimals,
    dex: best,
  };
}

export async function fetchRhBalances(address: string): Promise<string> {
  if (!isAddress(address)) return "Invalid address.";
  let ethStr = "?";
  try {
    const hex = await rhRpc("eth_getBalance", [address, "latest"]);
    ethStr = (Number(BigInt(hex)) / 1e18).toFixed(6);
  } catch (e: any) {
    ethStr = `error: ${e?.message ?? "rpc"}`;
  }

  // Blockscout lists EVERY token held, not just the 18-stock catalog — the old
  // per-catalog RPC loop was blind to arbitrary crypto we can now trade. It's
  // also 1 request instead of 18, and stays reachable when the RPC is blocked.
  const holdings: Array<{ symbol: string; bal: string; address: string }> = [];
  try {
    const res = await fetch(`${RH_BLOCKSCOUT_V2}/addresses/${address}/token-balances`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const items: any[] = Array.isArray(data) ? data : (data?.items ?? []);
      for (const it of items) {
        const tk = it?.token ?? {};
        if (tk.type && String(tk.type).toUpperCase() !== "ERC-20") continue;
        const dec = Number(tk.decimals ?? 18);
        const raw = String(it?.value ?? "0");
        let bal = 0;
        try {
          bal = Number(ethers.formatUnits(raw, isFinite(dec) ? dec : 18));
        } catch {
          continue;
        }
        if (bal > 1e-9) {
          holdings.push({
            symbol: tk.symbol ?? "?",
            bal: bal.toLocaleString(undefined, { maximumFractionDigits: 6 }),
            address: tk.address_hash ?? tk.address ?? "",
          });
        }
      }
      holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
  } catch {
    /* fall through — ETH balance still reported */
  }

  const lines = [
    `**Wallet**: \`${address}\``,
    ``,
    `**Balances on Robinhood Chain (${RH_CHAIN_ID}):**`,
    `- ETH (gas): ${ethStr}`,
  ];
  if (holdings.length === 0) lines.push(`- (no token balances)`);
  else for (const h of holdings) lines.push(`- ${h.symbol}: ${h.bal}  \`${h.address}\``);
  lines.push(``, `_RPC: ${rhRpcDisplay()}_`, `_Explorer: ${RH_EXPLORER}/address/${address}_`);
  return lines.join("\n");
}
