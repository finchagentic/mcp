// READ-ONLY mainnet check (eth_call only; nothing is signed or sent). Throwaway, unfunded sender.
import { ethers } from "ethers";
import { realChainOps, toLaunchParams, launchpadRpcUrl } from "../src/tools/launchpad.js";
import { verifyPrepareResponse, verifyPredictedToken, FACTORY, LOCKER, NATIVE, USDG_RH, type LaunchChain, type LaunchRequest } from "../src/launchpad-verify.js";
import { startTickForFdv } from "../src/launchpad-math.js";

const FACTORY_ABI = [
  "function findSalt(address launcher, bytes32 baseSalt, string name, string symbol, uint256 supply, string metadataURI, address quote, uint256 maxTries) view returns (bytes32 salt, address token)",
  "function predictToken(address launcher, bytes32 salt, string name, string symbol, uint256 supply, string metadataURI) view returns (address)",
];
const CHAIN_ID = { base: 8453, robinhood: 4663 } as const;

async function main() {
  const sender = ethers.Wallet.createRandom().address; // throwaway, never funded
  const budget = ethers.Wallet.createRandom().address; // stand-in budget wallet
  const host = new URL(process.env.FINCH_CONVEX_URL ?? "https://valuable-fish-533.convex.site").host;
  const cases: Array<{ chain: LaunchChain; quote: "eth" | "usdg"; mcap: number; feePct: 0 | 1 | 3; feeTo: "creator" | "burn" }> = [
    { chain: "base", quote: "eth", mcap: 10, feePct: 1, feeTo: "creator" },
    { chain: "robinhood", quote: "eth", mcap: 10, feePct: 1, feeTo: "creator" },
    { chain: "robinhood", quote: "usdg", mcap: 10000, feePct: 3, feeTo: "creator" },
    { chain: "base", quote: "eth", mcap: 25, feePct: 1, feeTo: "burn" },
    { chain: "robinhood", quote: "eth", mcap: 5, feePct: 0, feeTo: "creator" },
  ];
  for (const c of cases) {
    const p = new ethers.JsonRpcProvider(launchpadRpcUrl(c.chain), CHAIN_ID[c.chain], { staticNetwork: true });
    const code = await p.getCode(FACTORY); const lcode = await p.getCode(LOCKER);
    const f = new ethers.Contract(FACTORY, FACTORY_ABI, p);
    const name = "Parity Check", symbol = "PCHK";
    const metadataURI = `https://${host}/launchpad/meta/${sender.toLowerCase()}/0x${"34".repeat(32)}`;
    const quoteAddr = c.quote === "usdg" ? USDG_RH : NATIVE;
    const [salt, found] = (await f.findSalt(sender, ethers.hexlify(ethers.randomBytes(32)), name, symbol, 0n, metadataURI, quoteAddr, 64n)) as [string, string];
    const dec = c.quote === "usdg" ? 6 : 18;
    const routes = c.feePct !== 0 && c.feeTo !== "burn";
    const resp = {
      launcher: sender, chain: c.chain, factory: FACTORY, locker: LOCKER, quote: { address: quoteAddr, decimals: dec },
      startTick: startTickForFdv(c.mcap, dec), lpFee: c.feePct * 10000, salt, predictedToken: found, metadataURI,
      recipients: c.feePct === 0 ? [] : c.feeTo === "burn" ? [{ payout: "0x000000000000000000000000000000000000dEaD", bps: 10000 }] : [{ payout: budget, bps: 9000 }, { payout: sender, bps: 1000 }],
      agentFunded: routes, budgetWallet: routes ? budget : null, name, symbol,
    };
    const req: LaunchRequest = { chain: c.chain, name, symbol, quote: c.quote, startingMarketCap: c.mcap, feePct: c.feePct, feeTo: c.feeTo };
    const v = verifyPrepareResponse(resp, req, sender);
    const params = toLaunchParams(v);
    const predicted = await realChainOps.predictToken(c.chain, sender, params); // our production code path
    verifyPredictedToken(predicted, v.predictedToken);
    let sim = "";
    try { const gas = await realChainOps.simulateLaunch(c.chain, sender, params); sim = `ACCEPTED (estimateGas ${gas})`; }
    catch (e: any) { sim = `REJECTED: ${String(e?.shortMessage ?? e?.message).slice(0, 200)}`; }
    // also a raw eth_call of factory.launch for the unfunded sender
    const iface = new ethers.Interface(["function launch((string name, string symbol, string metadataURI, address quote, uint256 supply, int24 startTick, uint24 lpFee, bytes32 salt, (address payout, uint16 bps)[] recipients) p) returns (address token, uint256 tokenId)"]);
    let raw = "";
    try { const out = await p.call({ from: sender, to: FACTORY, data: iface.encodeFunctionData("launch", [params]) }); const [tok, id] = iface.decodeFunctionResult("launch", out); raw = `eth_call OK -> token ${tok} tokenId ${id}`; }
    catch (e: any) { raw = `eth_call REVERT: ${String(e?.shortMessage ?? e?.message).slice(0, 200)}`; }
    console.log(JSON.stringify({ chain: c.chain, quote: c.quote, mcap: c.mcap, feePct: c.feePct, feeTo: c.feeTo, factoryHasCode: code !== "0x", lockerHasCode: lcode !== "0x", startTick: v.startTick, findSaltToken: found, predictTokenOnChain: predicted, match: predicted.toLowerCase() === found.toLowerCase(), sender, simulateLaunch: sim, rawEthCall: raw }, null, 1));
  }
}
main().catch((e) => { console.error("FAILED", e); process.exit(1); });
