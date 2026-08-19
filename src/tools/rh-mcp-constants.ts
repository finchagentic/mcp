// Robinhood Chain (chainId 4663) constants shared across the rh-mcp-* modules.

export const RH_CHAIN_ID = 4663;
export const RH_RPC =
  process.env.ROBINHOOD_RPC_URL ??
  process.env.RH_RPC_URL ??
  process.env.FINCH_RH_RPC_URL ??
  "https://rpc.mainnet.chain.robinhood.com";

/** Host only, for display in tool output - never the full RH_RPC. An
 *  operator can point ROBINHOOD_RPC_URL/RH_RPC_URL at a keyed provider
 *  (same pattern app/convex just fixed for its own Alchemy-key leak risk -
 *  a `.../v2/<key>`-style URL echoed verbatim into a tool response lands the
 *  key in chat transcripts/client logs). Falls back to the raw value only
 *  if it isn't a parseable URL, which should never happen in practice. */
export function rhRpcDisplay(): string {
  try {
    return new URL(RH_RPC).host;
  } catch {
    return "(configured)";
  }
}

export const RH_EXPLORER = "https://robinhoodchain.blockscout.com";
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const RH_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const RH_UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";

/**
 * Canonical Global Dollar (USDG) — RH chain's settlement stablecoin (same
 * address as app/convex/_settlement.ts). Hardcoded rather than resolved via
 * DexScreener ticker search: "USDG" is the exact symbol an imposter contract
 * would spoof, and dexSearchByTicker ranks by pool liquidity, not authenticity
 * — a fake pool with inflated liquidity could otherwise outrank the real token.
 */
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DECIMALS = 6;

/** ClawHood / Finch catalog (22 tokenized stocks — official "Robinhood Token" contracts). */
export const RH_STOCKS: Array<{ address: string; symbol: string; name: string }> = [
  { address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", symbol: "AAPL", name: "Apple" },
  { address: "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc", symbol: "AMD", name: "AMD" },
  { address: "0x12f190a9f9d7d37a250758b26824b97ce941bf54", symbol: "AMZN", name: "Amazon" },
  { address: "0x822cc93ffd030293e9842c30bbd678f530701867", symbol: "BE", name: "Bloom Energy" },
  { address: "0x6330d8c3178a418788df01a47479c0ce7ccf450b", symbol: "COIN", name: "Coinbase" },
  { address: "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3", symbol: "CRWV", name: "CoreWeave" },
  { address: "0x1b0e319c6a659f002271b69db8a7df2f911c153e", symbol: "GME", name: "GameStop" },
  { address: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", symbol: "GOOGL", name: "Alphabet" },
  { address: "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681", symbol: "INTC", name: "Intel" },
  { address: "0xc0d6457c16cc70d6790dd43521c899c87ce02f35", symbol: "META", name: "Meta" },
  { address: "0xe93237c50d904957cf27e7b1133b510c669c2e74", symbol: "MSFT", name: "Microsoft" },
  { address: "0xff080c8ce2e5feadaca0da81314ae59d232d4afd", symbol: "MU", name: "Micron" },
  { address: "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8", symbol: "NFLX", name: "Netflix" },
  { address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", symbol: "NVDA", name: "NVIDIA" },
  { address: "0xb0992820e760d836549ba69bc7598b4af75dee03", symbol: "ORCL", name: "Oracle" },
  { address: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a", symbol: "PLTR", name: "Palantir" },
  { address: "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", symbol: "QQQ", name: "Invesco QQQ" },
  { address: "0xb90a19ff0af67f7779aff50a882a9cff42446400", symbol: "SNDK", name: "Sandisk" },
  { address: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", symbol: "SPCX", name: "SPACEX" },
  { address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", symbol: "SPY", name: "SPDR S&P 500" },
  { address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d", symbol: "TSLA", name: "Tesla" },
  { address: "0xd917b029c761d264c6a312bbbcda868658ef86a6", symbol: "USAR", name: "USA Rare Earth" },
];

export const RH_BLOCKSCOUT_V2 = "https://robinhoodchain.blockscout.com/api/v2";
export const DEXSCREENER = "https://api.dexscreener.com";
export const RH_DEX_CHAIN = "robinhood";
