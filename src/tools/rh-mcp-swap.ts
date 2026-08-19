// Swap execution engine: quote, approvals (direct + Permit2), broadcast,
// and receipt confirmation. Real funds move through this file.

import { ethers } from "ethers";
import { callConvex } from "../convex.js";
import { RH_PERMIT2, RH_UNIVERSAL_ROUTER, RH_CHAIN_ID } from "./rh-mcp-constants.js";
import { rhProviderAsync, rhRpc, parseHumanToWei } from "./rh-mcp-provider.js";
import { resolveTokenSmart } from "./rh-mcp-resolve.js";
import type { ResolvedToken } from "./rh-mcp-dex.js";

export async function quoteRh(args: {
  fromToken: string;
  toToken: string;
  amount: string;
  maxSlippagePct?: number;
  taker: string;
  toolName?: string;
}): Promise<any> {
  const from = await resolveTokenSmart(args.fromToken);
  const to = await resolveTokenSmart(args.toToken);
  if (from.kind === to.kind) {
    throw new Error("RH swaps route ETH ↔ token. Buy a token with ETH, or sell a token for ETH.");
  }
  const sellAmount = parseHumanToWei(args.amount, from.decimals);
  const slippagePct = args.maxSlippagePct ?? 2.0;
  // Same bound defi.ts's SwapSchema already enforces for Base swaps
  // (.positive().max(50)) - this file had no equivalent check anywhere, so a
  // negative or absurd value flowed straight through to the backend as
  // slippageBps, both for direct rh_mcp_swap calls and for every unattended
  // rh_orders_tick execution of a DCA/bracket order created with a bad value.
  if (!(slippagePct > 0) || slippagePct > 50) {
    throw new Error(`maxSlippagePct must be greater than 0 and at most 50 (got ${args.maxSlippagePct}).`);
  }
  const slippageBps = Math.round(slippagePct * 100);
  const result = await callConvex(
    "/mcp/rh/quote",
    "POST",
    {
      sellToken: from.address,
      buyToken: to.address,
      sellAmount,
      taker: args.taker,
      slippageBps,
      fromSymbol: from.symbol,
      toSymbol: to.symbol,
    },
    args.toolName ?? "rh_mcp_estimate"
  );
  if (result.error) throw new Error(result.error);
  return { ...result, from, to, sellAmount, slippageBps };
}

/** Plain ERC-20 approval for routers that pull via transferFrom (SwapRouter02). */
export async function ensureDirectApproval(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  token: string,
  spender: string,
  amountWei: bigint
): Promise<string[]> {
  const provider = await rhProviderAsync();
  const signer = wallet.connect(provider);
  const erc20 = new ethers.Contract(
    token,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    signer
  );
  const allowance: bigint = await erc20.allowance(wallet.address, spender);
  if (allowance >= amountWei) return [];
  const tx = await erc20.approve(spender, ethers.MaxUint256);
  await tx.wait();
  return [tx.hash];
}

export async function ensureSellApprovals(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  token: string,
  amountWei: bigint
): Promise<string[]> {
  const provider = await rhProviderAsync();
  const signer = wallet.connect(provider);
  const hashes: string[] = [];

  const erc20 = new ethers.Contract(
    token,
    [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
    signer
  );
  const allowance: bigint = await erc20.allowance(wallet.address, RH_PERMIT2);
  if (allowance < amountWei) {
    const tx = await erc20.approve(RH_PERMIT2, ethers.MaxUint256);
    await tx.wait();
    hashes.push(tx.hash);
  }

  // Permit2.approve(token, spender, amount, expiration) selector 0x87517c45
  const permit2 = new ethers.Contract(
    RH_PERMIT2,
    [
      "function approve(address token, address spender, uint160 amount, uint48 expiration)",
      "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
    ],
    signer
  );
  try {
    const al = await permit2.allowance(wallet.address, token, RH_UNIVERSAL_ROUTER);
    const amt = BigInt(al.amount ?? al[0] ?? 0);
    const exp = Number(al.expiration ?? al[1] ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (amt >= amountWei && exp > now + 60) return hashes;
  } catch {
    /* re-approve */
  }
  const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30d
  // uint160 max for amount
  const max160 = (1n << 160n) - 1n;
  const tx2 = await permit2.approve(token, RH_UNIVERSAL_ROUTER, max160, expiration);
  await tx2.wait();
  hashes.push(tx2.hash);
  return hashes;
}

/**
 * Wait for the swap receipt and read back what actually happened on-chain.
 *
 * A quote is a prediction; a receipt is proof. Reporting only the quoted amount
 * leaves the user unable to tell a real fill from a fabricated one, so we
 * surface the mined status, block, gas, and the ACTUAL amount credited —
 * parsed from the token's Transfer logs (buys) or the ETH balance delta (sells).
 */
export async function confirmRhSwap(
  txHash: string,
  walletAddress: string,
  to: ResolvedToken,
  ethBefore: bigint | null
): Promise<{
  mined: boolean;
  ok?: boolean;
  block?: number;
  gasUsed?: string;
  received?: string;
}> {
  try {
    const provider = await rhProviderAsync();
    const receipt = await provider.waitForTransaction(txHash, 1, 90_000);
    if (!receipt) return { mined: false };

    let received: string | undefined;
    if (to.kind === "token") {
      // Sum Transfer(_, me, value) emitted by the bought token.
      const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
      const me = walletAddress.toLowerCase();
      let total = 0n;
      for (const log of receipt.logs ?? []) {
        if (log.address?.toLowerCase() !== to.address.toLowerCase()) continue;
        if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
        const dest = "0x" + log.topics[2].slice(-40);
        if (dest.toLowerCase() !== me) continue;
        try {
          total += BigInt(log.data);
        } catch {
          /* skip malformed */
        }
      }
      if (total > 0n) received = ethers.formatUnits(total, to.decimals);
    } else if (ethBefore != null) {
      // Selling for native ETH: credited amount = delta + gas actually burned.
      try {
        const after = BigInt(await rhRpc("eth_getBalance", [walletAddress, "latest"]));
        const fee = BigInt(receipt.gasUsed ?? 0n) * BigInt(receipt.gasPrice ?? 0n);
        const delta = after - ethBefore + fee;
        if (delta > 0n) received = ethers.formatEther(delta);
      } catch {
        /* balance read optional */
      }
    }

    return {
      mined: true,
      ok: receipt.status === 1,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
      received,
    };
  } catch {
    return { mined: false };
  }
}

export async function broadcastRhSwap(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  tx: { to: string; data: string; value: string; gas?: string }
): Promise<string> {
  const provider = await rhProviderAsync();
  const signer = wallet.connect(provider);
  // "pending" (not "latest") so sequential swaps in one orders-tick get
  // incrementing nonces instead of colliding on the same unmined nonce.
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const fee = await provider.getFeeData();
  const signed = await signer.signTransaction({
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value || "0"),
    gasLimit: BigInt(tx.gas || "650000"),
    maxFeePerGas: fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 100_000_000n,
    nonce,
    chainId: RH_CHAIN_ID,
    type: 2,
  });
  const resp = await rhRpc("eth_sendRawTransaction", [signed]);
  return resp as string;
}
