import { ethers } from "ethers";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "../types.js";
import { callConvex } from "../convex.js";
import { getSavedToken } from "../config.js";
import { rhProviderAsync, RH_EXPLORER } from "./rh-mcp.js";

// FINCH staking - MCP wrapper around the EXISTING app/convex staking actions
// (stake.ts's stakeFINCH/unstakeFINCH, stakeInternal.ts's myStakingStats/
// globalStats). No staking logic lives here - this only parses a
// human-friendly amount ("all", "max", "50%", "1m", "100k", a raw number)
// into wei and calls the backend, exactly like the webapp's Stake page does.
//
// IMPORTANT - custodial wallet, not the local signing wallet: unlike
// base_mcp_swap/rh_mcp_swap (which sign and broadcast with the LOCAL
// ~/.finch/wallet.json key and need no login), staking moves FINCH from the
// account's CUSTODIAL wallet (the one shown on the webapp's Wallet page) -
// stake.ts's actions resolve identity via a real logged-in session, not a
// wallet signature. Requires `finch login` first; there is no way around
// this without changing stake.ts's own session-based design, which is out
// of scope here. The local wallet and the custodial wallet are DIFFERENT
// addresses with different balances - never conflate them in output.
//
// SECURITY: no tool here ever returns a private key or seed phrase, and
// none ever will - the custodial key stays server-side (Turnkey-enclave /
// encrypted-at-rest), exactly as it already does for the webapp. "Log in,
// then stake" is the ceiling of what this integration does; it does not,
// and must not, add an export path.

const FINCH_CA = "0xce1981b0431fb495912cab057d2877a290199824";
const FINCH_DECIMALS = 18;
const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

function requireLogin(): { token: string } | null {
  const token = getSavedToken();
  return token ? { token } : null;
}

const NOT_LOGGED_IN_MSG =
  "Staking needs a logged-in session (not just the local wallet). Run `finch login` first, then retry.";

async function finchBalanceOf(address: string): Promise<bigint> {
  const provider = await rhProviderAsync();
  const finch = new ethers.Contract(FINCH_CA, ERC20_BALANCE_ABI, provider);
  return await finch.balanceOf(address);
}

// Parses "all" | "max" | "50%" | "1m" | "100k" | "100000" | "value 100000"
// against a live balance. Returns wei as a string, or throws with a message
// the caller can show verbatim.
export function parseStakeAmount(input: string, balanceWei: bigint): bigint {
  const raw = input.trim().toLowerCase().replace(/^value\s+/, "");

  if (raw === "all" || raw === "max") {
    if (balanceWei <= 0n) throw new Error("Wallet has 0 FINCH - nothing to stake.");
    return balanceWei;
  }

  const pctMatch = raw.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (!(pct > 0) || pct > 100) throw new Error("Percentage must be between 0 and 100.");
    return (balanceWei * BigInt(Math.round(pct * 100))) / 10_000n;
  }

  const suffixMatch = raw.match(/^(\d+(?:\.\d+)?)\s*([km])$/);
  if (suffixMatch) {
    const n = parseFloat(suffixMatch[1]);
    const mult = suffixMatch[2] === "m" ? 1_000_000 : 1_000;
    return ethers.parseUnits((n * mult).toString(), FINCH_DECIMALS);
  }

  const plainMatch = raw.match(/^(\d+(?:\.\d+)?)$/);
  if (plainMatch) {
    return ethers.parseUnits(plainMatch[1], FINCH_DECIMALS);
  }

  throw new Error(
    `Could not parse amount "${input}". Use "all", "max", a percentage like "50%", ` +
    `a shorthand like "1m" or "100k", or a plain number like "100000".`
  );
}

function fmtFinch(wei: bigint): string {
  return `${Number(ethers.formatUnits(wei, FINCH_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 4 })} FINCH`;
}

export const STAKE_TOOLS: Tool[] = [
  {
    name: "stake_finch_status",
    description:
      "View your FINCH staking status - custodial wallet balance available to stake, your active stakes " +
      "(amount, lock-up remaining, accrued rewards), and pool-wide stats (total staked, daily USDG reward). " +
      "Requires `finch login` (stakes live on your account's custodial wallet, not the local MCP signing wallet).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "stake_finch",
    description:
      "Stake FINCH from your custodial wallet (the one shown on the webapp's Wallet page) to earn USDG " +
      "rewards. Locks for a fixed period (see stake_finch_status for lockDays) - unstake is blocked until " +
      "then. Requires `finch login` first and `confirm: true`. Amount accepts \"all\"/\"max\" (entire " +
      "available balance), a percentage (\"50%\"), a shorthand (\"1m\", \"100k\"), or a plain number " +
      "(\"100000\").",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "\"all\" | \"max\" | \"50%\" | \"1m\" | \"100k\" | \"100000\"",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to stake - this moves real FINCH out of your custodial wallet.",
        },
      },
      required: ["amount", "confirm"],
    },
  },
  {
    name: "unstake_finch",
    description:
      "Unstake FINCH back to your custodial wallet, plus any pending USDG rewards. Only works once the " +
      "lock-up period has passed (check stake_finch_status for which stakes are unlockable). Requires " +
      "`finch login` and `confirm: true`. Pass a specific stakeId, or \"all\" to unstake every currently " +
      "unlockable stake in one call (each processed and reported individually).",
    inputSchema: {
      type: "object",
      properties: {
        stakeId: { type: "string", description: "A stake ID from stake_finch_status, or \"all\"" },
        confirm: { type: "boolean", description: "Must be true to unstake." },
      },
      required: ["stakeId", "confirm"],
    },
  },
];

export async function handleStakeTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name === "stake_finch_status") {
    const login = requireLogin();
    if (!login) return { content: [{ type: "text", text: NOT_LOGGED_IN_MSG }], isError: true };

    const data = await callConvex("/mcp/stake/status", "GET", undefined, "stake_finch_status") as {
      walletAddress?: string | null;
      myStats?: { totalStaked: number; totalRewards: number; activeStakes: number; canUnstakeCount: number; stakes: any[] };
      global?: { totalStakedHuman: number; totalStakers: number; dailyRewardUsdg: number; lockDays: number };
      error?: string;
    };
    if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }], isError: true };

    const address = data.walletAddress ?? null;
    let balanceWei: bigint | null = null;
    if (address) {
      try { balanceWei = await finchBalanceOf(address); } catch { /* balance is a nice-to-have, don't fail the whole status */ }
    }

    const my = data.myStats;
    const global = data.global;
    const lines = [
      `## FINCH Staking Status`,
      ``,
      address ? `**Custodial wallet:** \`${address}\` ${balanceWei != null ? `(${fmtFinch(balanceWei)} available to stake)` : ""}` : `_Could not resolve custodial wallet address._`,
      ``,
      global ? `**Pool:** ${global.totalStakedHuman.toLocaleString()} FINCH staked by ${global.totalStakers} stakers · ${global.dailyRewardUsdg} USDG/day pool · ${global.lockDays}-day lock-up` : "",
      ``,
      my ? `**Your stakes:** ${my.activeStakes} active · ${my.totalStaked.toLocaleString()} FINCH staked · ${my.totalRewards.toFixed(4)} USDG accrued · ${my.canUnstakeCount} unlockable now` : "",
    ];
    if (my?.stakes?.length) {
      lines.push(``, `**Detail:**`);
      for (const s of my.stakes) {
        const unlocked = Date.now() >= s.unlockAt;
        lines.push(`- \`${s._id}\` — ${s.amountHuman} FINCH · ${s.status}${s.status === "staked" ? (unlocked ? " · unlockable now" : ` · unlocks ${new Date(s.unlockAt).toISOString().slice(0, 10)}`) : ""}`);
      }
    }
    return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
  }

  if (name === "stake_finch") {
    const { amount, confirm } = (args ?? {}) as { amount?: string; confirm?: boolean };
    if (!amount) return { content: [{ type: "text", text: "amount is required" }], isError: true };
    if (confirm !== true) {
      return {
        content: [{ type: "text", text: "Refusing to stake without confirmation - pass `confirm: true` after reviewing the amount." }],
        isError: true,
      };
    }
    const login = requireLogin();
    if (!login) return { content: [{ type: "text", text: NOT_LOGGED_IN_MSG }], isError: true };

    const status = await callConvex("/mcp/stake/status", "GET", undefined, "stake_finch_status") as {
      walletAddress?: string | null; error?: string;
    };
    if (status.error) return { content: [{ type: "text", text: `Error: ${status.error}` }], isError: true };
    if (!status.walletAddress) return { content: [{ type: "text", text: "Could not resolve your custodial wallet address." }], isError: true };

    let balanceWei: bigint;
    try {
      balanceWei = await finchBalanceOf(status.walletAddress);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Could not read FINCH balance: ${e?.message ?? e}` }], isError: true };
    }

    let amountWei: bigint;
    try {
      amountWei = parseStakeAmount(amount, balanceWei);
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
    if (amountWei > balanceWei) {
      return {
        content: [{ type: "text", text: `Insufficient FINCH. Have ${fmtFinch(balanceWei)}, tried to stake ${fmtFinch(amountWei)}.` }],
        isError: true,
      };
    }

    const result = await callConvex("/mcp/stake/stake", "POST", { amountWei: amountWei.toString() }, "stake_finch") as {
      stakeId?: string; txHash?: string; error?: string;
    };
    if (result.error) return { content: [{ type: "text", text: `Stake failed: ${result.error}` }], isError: true };

    return {
      content: [{
        type: "text",
        text: [
          `✅ Staked ${fmtFinch(amountWei)}`,
          `Stake ID: \`${result.stakeId}\``,
          `Tx: \`${result.txHash}\``,
          `${RH_EXPLORER}/tx/${result.txHash}`,
        ].join("\n"),
      }],
    };
  }

  if (name === "unstake_finch") {
    const { stakeId, confirm } = (args ?? {}) as { stakeId?: string; confirm?: boolean };
    if (!stakeId) return { content: [{ type: "text", text: "stakeId is required (or \"all\")" }], isError: true };
    if (confirm !== true) {
      return {
        content: [{ type: "text", text: "Refusing to unstake without confirmation - pass `confirm: true`." }],
        isError: true,
      };
    }
    const login = requireLogin();
    if (!login) return { content: [{ type: "text", text: NOT_LOGGED_IN_MSG }], isError: true };

    let targetIds: string[];
    if (stakeId.toLowerCase() === "all") {
      const status = await callConvex("/mcp/stake/status", "GET", undefined, "stake_finch_status") as {
        myStats?: { stakes: any[] }; error?: string;
      };
      if (status.error) return { content: [{ type: "text", text: `Error: ${status.error}` }], isError: true };
      const now = Date.now();
      targetIds = (status.myStats?.stakes ?? [])
        .filter((s: any) => s.status === "staked" && now >= s.unlockAt)
        .map((s: any) => s._id);
      if (!targetIds.length) {
        return { content: [{ type: "text", text: "No stakes are currently unlockable." }] };
      }
    } else {
      targetIds = [stakeId];
    }

    const lines: string[] = [];
    for (const id of targetIds) {
      const result = await callConvex("/mcp/stake/unstake", "POST", { stakeId: id }, "unstake_finch") as {
        txHash?: string; rewardsTxHash?: string; error?: string;
      };
      if (result.error) {
        lines.push(`🔴 \`${id}\`: ${result.error}`);
      } else {
        lines.push(`✅ \`${id}\` unstaked — tx \`${result.txHash}\`${result.rewardsTxHash ? ` · rewards tx \`${result.rewardsTxHash}\`` : ""}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return null;
}
