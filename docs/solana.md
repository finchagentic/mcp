# Solana tools

Seven `sol_*` tools (included in the `defi` palette / `FINCH_TOOLS=all`). RPC: `FINCH_SOLANA_RPC_URL` (default public mainnet-beta).

| Tool | Args | Notes |
|---|---|---|
| `sol_wallet` | – | Returns the public address; creates the local wallet on first use |
| `sol_balance` | `address?` | SOL + SPL (Token & Token-2022) |
| `sol_token_info` | `mint` | Jupiter tokens v2 + DexScreener |
| `sol_quote` | `inputMint, outputMint, amount, slippageBps?` | amount is a human decimal string; symbols SOL/USDC/USDT/FINCH |
| `sol_swap` | same + `confirmed?` | needs `confirmed: true` to send; rejects price impact > 5%; max slippage 5000 bps |
| `sol_send` | `to, amount, mint?, confirmed?` | SOL or SPL; creates recipient ATA if needed |
| `sol_launch_token` | `name, symbol, description, imageUrl, devBuySol?, confirmed?` | pump.fun; balance ≥ devBuySol + 0.03 SOL; devBuySol ≤ 10 |

## Wallet
`~/.finch/solana-wallet.json` (mode 600): the ed25519 secret, AES-256-GCM encrypted with a key derived from the same material as the EVM wallet (`FINCH_WALLET_PASSPHRASE`, else per-install secret + machine info). No tool ever returns or logs it. If the file can't be decrypted it is never overwritten.

## $FINCH
Solana pump.fun mint `4LKS9yUYaBEZyzsaExmFXcWbG9pDBX7AWhseigVYpump` (symbol `FINCH` resolves to it).
