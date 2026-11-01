// Single source of truth for the FINCH token. FINCH lives on Robinhood Chain (4663) as an ERC-20.
// Two older addresses (0x4B52…9Ba3 on Base, 0xce19…9824) are NOT the FINCH token and must never be
// referenced again; test/constants.test.ts fails the build if either reappears under src/.

export const FINCH_RH_CHAIN_ID = 4663;
export const FINCH_RH_ADDRESS = "0x879f29204a5ff842c66f0f65e0f2e422073acce7";
export const FINCH_DECIMALS = 18;
