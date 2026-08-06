#!/usr/bin/env node
/**
 * rh-trade — direct terminal control for Robinhood Chain (4663) trading.
 *
 * You run it, you own the trade. Nothing executes without an explicit --yes
 * typed by you on the command line, and `swap` always prints the live quote
 * first so you see the fill before committing.
 *
 *   node scripts/rh-trade.js balance
 *   node scripts/rh-trade.js quote ETH 0x842245...4f0e 0.0007
 *   node scripts/rh-trade.js swap  ETH 0x842245...4f0e 0.0007 --yes
 *   node scripts/rh-trade.js swap  0x842245...4f0e ETH all --yes      # sell everything
 *
 * Flags:
 *   --yes                 required to broadcast
 *   --slippage <pct>      default 2 (raise for thin pools)
 *   --accept-bad-price    override the spot-price safety stop (rarely correct)
 */

const path = require("path");
const dist = path.join(__dirname, "..", "dist", "tools");
const { handleRhMcpTool } = require(path.join(dist, "rh-mcp.js"));

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(name);
const flagVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--slippage"));

function out(res) {
  const text = res?.content?.[0]?.text ?? "(no output)";
  console.log("\n" + text + "\n");
  return !res?.isError;
}

async function resolveAmount(fromToken, amount) {
  if (String(amount).toLowerCase() !== "all") return amount;
  if (/^eth$/i.test(fromToken)) {
    throw new Error("`all` is not supported for ETH — leave some for gas. Pass an explicit amount.");
  }
  // Read the on-chain balance of the exact token being sold. (Parsing the
  // balance tool's text was fragile and missed non-catalog tokens entirely.)
  const { resolveTokenSmart, rhErc20Balance } = require(path.join(dist, "rh-mcp.js"));
  const { getOrCreateWallet } = require(path.join(__dirname, "..", "dist", "wallet.js"));
  const { ethers } = require("ethers");

  const token = await resolveTokenSmart(fromToken);
  if (token.kind !== "token") throw new Error(`Not a sellable token: ${fromToken}`);
  const wallet = await getOrCreateWallet();
  const raw = await rhErc20Balance(token.address, wallet.address);
  if (raw <= 0n) throw new Error(`No ${token.symbol} balance in ${wallet.address}`);
  const human = ethers.formatUnits(raw, token.decimals);
  console.log(`  (all → ${human} ${token.symbol})`);
  return human;
}

(async () => {
  try {
    if (cmd === "balance") {
      return process.exit(out(await handleRhMcpTool("rh_mcp_balance", {})) ? 0 : 1);
    }

    if (cmd === "quote" || cmd === "swap") {
      const [, fromToken, toToken, rawAmount] = positional;
      if (!fromToken || !toToken || !rawAmount) {
        console.error("\nUsage: rh-trade.js " + cmd + " <fromToken> <toToken> <amount|all> [--yes]\n");
        process.exit(1);
      }
      const slippage = Number(flagVal("--slippage", "2"));
      const amount = await resolveAmount(fromToken, rawAmount);

      // Always show the live quote before anything is broadcast.
      console.log(`\n→ Quoting ${amount} ${fromToken} → ${toToken} (slippage ${slippage}%)`);
      const ok = out(
        await handleRhMcpTool("rh_mcp_estimate", {
          fromToken,
          toToken,
          amount,
          maxSlippagePct: slippage,
        })
      );
      if (cmd === "quote") process.exit(ok ? 0 : 1);
      if (!ok) {
        console.error("Quote failed — not broadcasting.\n");
        process.exit(1);
      }

      if (!flag("--yes")) {
        console.log("Dry run. Re-run with --yes to broadcast this trade.\n");
        process.exit(0);
      }

      console.log("→ Broadcasting (this spends real funds)…");
      const swapped = out(
        await handleRhMcpTool("rh_mcp_swap", {
          fromToken,
          toToken,
          amount,
          maxSlippagePct: slippage,
          confirm: true,
          ...(flag("--accept-bad-price") ? { acceptBadPrice: true } : {}),
        })
      );
      process.exit(swapped ? 0 : 1);
    }

    console.log(`
rh-trade — Robinhood Chain (4663)

  node scripts/rh-trade.js balance
  node scripts/rh-trade.js quote <from> <to> <amount>
  node scripts/rh-trade.js swap  <from> <to> <amount|all> --yes

  --slippage <pct>       default 2
  --accept-bad-price     override the spot-price safety stop
`);
    process.exit(0);
  } catch (e) {
    console.error("\n✗ " + (e?.message ?? e) + "\n");
    process.exit(1);
  }
})();
