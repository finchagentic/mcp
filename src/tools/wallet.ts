import { ethers } from "ethers";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getOrCreateWallet } from "../wallet.js";
import { ToolResult } from "../types.js";

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BASE_RPC);
}

export const WALLET_TOOLS: Tool[] = [
  {
    name: "get_wallet_address",
    description:
      "Get your Noelclaw wallet address. This is the local MCP wallet used to sign " +
      "requests and receive on-chain assets. Keys never leave your machine.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_wallet_balance",
    description:
      "Check ETH and USDC balance of your Noelclaw wallet on Base mainnet. " +
      "Also accepts an optional address to check any wallet. Live on-chain data, no API key required.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Optional: wallet address to check (default: your Noelclaw wallet)",
        },
      },
    },
  },
  {
    name: "wallet_sign_message",
    description:
      "Sign an arbitrary message with your local Noelclaw wallet. Returns the EIP-191 signature. " +
      "Useful for proving wallet ownership or signing auth challenges off-chain.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to sign",
        },
      },
      required: ["message"],
    },
  },
];

export async function handleWalletTool(name: string, args: unknown): Promise<ToolResult | null> {
  switch (name) {
    case "get_wallet_address": {
      try {
        const wallet = await getOrCreateWallet();
        return {
          content: [{
            type: "text",
            text: [
              `**Your Noelclaw Wallet**`,
              ``,
              `Address: \`${wallet.address}\``,
              `Network: Base mainnet (chainId 8453)`,
              ``,
              `This wallet is stored locally at \`~/.noelclaw/wallet.json\`.`,
              `Private keys never leave your machine - all signing happens locally.`,
              ``,
              `Use this address to receive ETH, USDC, or any ERC-20 token on Base.`,
              `Run \`get_wallet_balance\` to see current balances.`,
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to load wallet: ${err.message}` }], isError: true };
      }
    }

    case "get_wallet_balance": {
      try {
        const input = args as { address?: string };
        let targetAddress = input?.address;
        if (!targetAddress) {
          const wallet = await getOrCreateWallet();
          targetAddress = wallet.address;
        }

        if (!/^0x[0-9a-fA-F]{40}$/.test(targetAddress)) {
          return { content: [{ type: "text", text: "Invalid address format" }], isError: true };
        }

        const provider = getProvider();
        const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

        const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("RPC timeout")), ms));

        const [balances, priceRes] = await Promise.all([
          Promise.race([
            Promise.all([provider.getBalance(targetAddress), usdc.balanceOf(targetAddress)]),
            timeout(10_000),
          ]),
          fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
            signal: AbortSignal.timeout(5000),
          }).then(r => r.json()).catch(() => null),
        ]);

        const [ethRaw, usdcRaw] = balances as [bigint, bigint];
        const ethBalance = parseFloat(ethers.formatEther(ethRaw));
        const usdcBalance = parseFloat(ethers.formatUnits(usdcRaw, 6));
        const ethPrice: number | null = (priceRes as any)?.ethereum?.usd ?? null;
        const ethUsd = ethPrice ? (ethBalance * ethPrice).toFixed(2) : null;

        const basescanUrl = `https://basescan.org/address/${targetAddress}`;

        return {
          content: [{
            type: "text",
            text: [
              `**Wallet Balance — Base Mainnet**`,
              ``,
              `Address: \`${targetAddress}\``,
              ``,
              `| Token | Balance | USD Value |`,
              `|-------|---------|-----------|`,
              `| ETH   | ${ethBalance.toFixed(6)} ETH | ${ethUsd ? `$${ethUsd}` : "—"} |`,
              `| USDC  | $${usdcBalance.toFixed(2)} | $${usdcBalance.toFixed(2)} |`,
              ``,
              ethPrice ? `ETH price: $${ethPrice.toLocaleString()} (CoinGecko)` : ``,
              `🔗 [View on Basescan](${basescanUrl})`,
            ].filter(l => l !== "").join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Balance fetch failed: ${err.message}` }], isError: true };
      }
    }

    case "wallet_sign_message": {
      try {
        const { message } = args as { message: string };
        if (!message) return { content: [{ type: "text", text: "message is required" }], isError: true };

        const wallet = await getOrCreateWallet();
        const signature = await wallet.signMessage(message);

        return {
          content: [{
            type: "text",
            text: [
              `**Message Signed**`,
              ``,
              `Signer: \`${wallet.address}\``,
              `Message: \`${message}\``,
              ``,
              `Signature:`,
              `\`\`\``,
              signature,
              `\`\`\``,
              ``,
              `Standard EIP-191 personal_sign. Verifiable on-chain or with ethers.js \`verifyMessage()\`.`,
            ].join("\n"),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Sign failed: ${err.message}` }], isError: true };
      }
    }

    default:
      return null;
  }
}
