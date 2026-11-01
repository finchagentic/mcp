# Solana tools

Seven `sol_*` tools (included in the `defi` palette / `FINCH_TOOLS=all`). RPC: `FINCH_SOLANA_RPC_URL` (default public mainnet-beta).

| Tool | Args | Notes |
|---|---|---|
| `sol_wallet` | – | Returns the public address; creates the local wallet on first use |
| `sol_balance` | `address?` | SOL + SPL (Token & Token-2022) |
| `sol_token_info` | `mint` | Jupiter tokens v2 + DexScreener |
| `sol_quote` | `inputMint, outputMint, amount, slippageBps?` | amount is a human decimal string; symbols SOL/USDC/USDT/FINCH |
| `sol_swap` | same + `quoteId?`, `allowHighSlippage?`, `confirmed?` | spend-gated; needs `confirmed: true` **and** the `quoteId` from the preview; rejects price impact > 5%; slippage ≤ 500 bps (≤ 1000 with `allowHighSlippage:true`) |
| `sol_send` | `to, amount, mint?, allowToken2022Extensions?, confirmed?` | spend-gated, capped; SOL or SPL; creates recipient ATA if needed (≈0.0021 SOL rent); Token-2022 mints with transfer-fee/hook refused unless `allowToken2022Extensions:true` |
| `sol_launch_token` | `name, symbol, description, imageUrl, devBuySol?, confirmed?` | pump.fun; balance ≥ devBuySol + 0.03 SOL; devBuySol ≤ 10 and ≤ `FINCH_SOL_MAX_SEND_SOL`; spend-gated; description ≤ 1000 chars |

## Spend gate (default-deny)
`sol_swap`, `sol_send` and `sol_launch_token` **refuse to execute** unless the human operator sets `FINCH_SOL_ALLOW_SPEND=1` in the MCP server environment (exactly `1`) and restarts. Previews and the read-only tools always work. Per-call caps (SOL): `FINCH_SOL_MAX_SEND_SOL` (default `1`; applies to `sol_send` of SOL and the launch dev buy) and `FINCH_SOL_MAX_SWAP_SOL` (default `5`; swap input value). A prompt-injected model therefore cannot move funds unless the operator opted in, and cannot move more than the caps in one call.

## Transaction verification
Transactions built by third parties (Jupiter `/swap`, pumpportal `trade-local`) are never signed blindly. A shared verifier (`assertSafeTx`) resolves address lookup tables via RPC and requires: fee payer = the local wallet; only allowlisted programs (Jupiter: Jupiter v6, ComputeBudget, System, Token, Token-2022, ATA, Memo; pump: pump, pump buy wrapper, Metaplex metadata + the same base programs); no System Assign/TransferWithSeed/nonce ops; no SPL Transfer/Approve/SetAuthority/Burn; CloseAccount only back to the wallet; System transfers from the wallet only to its own wSOL account (swaps) and bounded by input + 0.01 SOL (swaps) or devBuy + 0.03 SOL (launch). It then **simulates** the transaction and aborts unless the wallet's SOL drop and token deltas are within the quoted bounds. A confirmed swap must carry the `quoteId` from its preview; the quote is re-fetched at execution and aborted if min-received is >0.5% worse.

## Image / metadata hardening
`imageUrl`: https only, no credentials, DNS-resolved and rejected if private/loopback/link-local/CGNAT/metadata, redirects followed manually (max 3, each re-validated), 5 MB hard cap on declared and streamed size, PNG/JPEG/GIF/WEBP magic bytes required. The pump.fun `metadataUri` must be https on `ipfs.io`, `*.ipfs.io`, `cf-ipfs.com`, `gateway.pinata.cloud`, `pump.fun` or `*.pump.fun`.

## Wallet
`~/.finch/solana-wallet.json` (mode 600, dir 700, written atomically): the ed25519 secret, AES-256-GCM encrypted with a key derived by **scrypt** (N=2^15, r=8, p=1, random 16-byte salt stored in the file, `"kdf":"scrypt-v1"`) from the same material as the EVM wallet (`FINCH_WALLET_PASSPHRASE`, else per-install secret + machine info). Older files without a `kdf` field are still read with the legacy derivation. The per-install `.local-secret` is **never regenerated** while a wallet file exists; if it is missing the tools fail closed with an explanation. **Back up `~/.finch/` (including `.local-secret`) or use a passphrase you control.** No tool ever returns or logs it. If the file can't be decrypted it is never overwritten.

## $FINCH
Solana pump.fun mint `4LKS9yUYaBEZyzsaExmFXcWbG9pDBX7AWhseigVYpump` (symbol `FINCH` resolves to it).
