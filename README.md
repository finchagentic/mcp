<div align="center">

# Finch

**The runtime layer for Agentic AI.**

Persistent memory, autonomous agents, and workflows that survive every session.

[Docs](https://docs.finch.com) · [App](https://app.finchagentic.com) · [npm](https://www.npmjs.com/package/@finchagentic/mcp) · [GitHub](https://github.com/finchagentic/mcp) · [X](https://x.com/finchagentic)

</div>

---

Most AI assistants disappear when the conversation ends. **Finch** gives them lasting state — memory that accumulates, agents that keep running, vaults that version knowledge, and workflows that continue after you close the chat.

## Why Finch

| | Without Finch | With Finch |
|--|---------------|------------|
| **Memory** | Resets every session | Full-text searchable + versioned vault, decays stale notes |
| **Agents** | One-shot tool calls | Named agents with state and audit history |
| **Workflows** | Manual chaining | Automations, monitors, packets, deep research |
| **Local** | Cloud-only | Vault + memory can run fully on your machine |

## Install

Always pin the version. Never use `@latest`.

```bash
# One-command installer (detects common MCP clients)
npx -y -p @finchagentic/mcp@4.7.5 finch install
```

### Claude Code

```bash
claude mcp add finch -s user -- npx -y -p @finchagentic/mcp@4.7.5 finch-mcp
```

### Cursor / Windsurf / Claude Desktop

```json
{
  "mcpServers": {
    "finch": {
      "command": "npx",
      "args": ["-y", "-p", "@finchagentic/mcp@4.7.5", "finch-mcp"]
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "finch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@finchagentic/mcp@4.7.5", "finch-mcp"]
    }
  }
}
```

<details>
<summary>Config file paths</summary>

| Client | Path |
|--------|------|
| Claude Desktop (Mac) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |
| Zed | `.config/zed/settings.json` |

</details>

No LLM API key is required to start — 111 of 116 tools are plain reads/writes/on-chain calls that your MCP client's own model already drives; only 5 (`ask_finch`, `deep_research`, and scheduled agent learning) do their own multi-step reasoning server-side and need a key (see [Configuration](#configuration)). Tools load on first use.

## Quick start

```bash
finch doctor          # health check
finch setup           # local vault / memory / providers
finch vault           # inspect local vault
finch orders          # schedule Robinhood Chain DCA / TP-SL order ticks
```

Try in your MCP client:

```
remember: I prefer conservative DeFi strategies, max 5% risk
spawn an agent called research-bot to track AI agent news, update it after each session
save this thesis to vault
```

## What you get

**116 tools** across four pillars:

| Pillar | What it does |
|--------|----------------|
| **Memory** | Full-text searchable memory + versioned vault + chronicle |
| **Agents** | Spawn, recall, update named agents — `agent_recall` also pulls related memory/vault context matching the agent's goal, not just its own logged updates |
| **Workflows** | Automations, monitors, packets, deep research (auto-saves reports + auto-links related past research) |
| **Execution** | Base DeFi, Robinhood Chain, Solana (Jupiter swaps, SPL sends, pump.fun launches), market data, web, GitHub |

Coding and research sessions persist the same way: `deep_research` auto-saves its report to vault and links it to related past reports; `code_session_save` does the same for coding/debugging sessions (`vault_save type=code`, versioned per project, auto-linked). Both exist so the next session — yours or another agent's — starts with real context instead of cold.

`vault_save` and `agent_spawn` also take an optional `workspaceProject` - the same named Projects a user organizes their Agents/vault content into on the webapp's Agents page. Pass a name and it's matched case-insensitively or created automatically (`list_projects` to browse what exists first). Hosted vault only - local-vault mode has no project concept.

Default palette is `core` (lighter context). Full set:

```json
"env": { "FINCH_TOOLS": "all" }
```

## Fully local

Finch is the runtime. **Your LLM is the brain. Your data stays yours.**

```bash
npx -y -p @finchagentic/mcp@4.7.5 finch setup
# enable local vault (and optional local memory)
```

| Piece | Location |
|-------|----------|
| Vault | `~/.finch/vault/` |
| Wallet | `~/.finch/wallet.json` |
| Config | `~/.finch/config.json` |
| Brain | your MCP client’s model |

Scheduled/cloud features still need an account. Core memory, vault, and public-data tools work offline of Finch cloud.

## Solana tools (`sol_*`, in the `defi` palette)

| Tool | What it does |
|------|--------------|
| `sol_wallet` | Public address of the local Solana wallet (`~/.finch/solana-wallet.json`, mode 600, AES-256-GCM; created on first use; secret never returned) |
| `sol_balance` | SOL + SPL balances (Token and Token-2022). Defaults to the local wallet |
| `sol_token_info` | Name/symbol/decimals/price/liquidity/mcap via Jupiter + DexScreener |
| `sol_quote` | Jupiter quote (exact BigInt amounts; `SOL`/`USDC`/`USDT`/`FINCH` symbols) |
| `sol_swap` | Jupiter swap, signed locally. Estimate only unless `confirmed: true`; rejects price impact > 5% |
| `sol_send` | Send SOL or an SPL token. Preview unless `confirmed: true` |
| `sol_launch_token` | pump.fun launch (image + metadata upload, optional dev buy). Preview unless `confirmed: true`; needs `devBuySol + 0.03` SOL |

**Spending is default-deny:** `sol_swap`/`sol_send`/`sol_launch_token` only execute when the operator sets `FINCH_SOL_ALLOW_SPEND=1` (per-call caps: `FINCH_SOL_MAX_SEND_SOL` default 1, `FINCH_SOL_MAX_SWAP_SOL` default 5). Swap/launch transactions are verified (program allowlist, lookup tables, simulation) before signing.

Set `FINCH_SOLANA_RPC_URL` for a private RPC (the URL/key is never echoed in tool output). `$FINCH` on Solana: `4LKS9yUYaBEZyzsaExmFXcWbG9pDBX7AWhseigVYpump`. See [docs/solana.md](docs/solana.md).

## Launchpad tools (`launchpad_*`, in the `defi` palette)

Launch and trade tokens on the **Finch launchpad** (Base, Robinhood Chain and Solana). Every launch also gets an AI founder that builds
a real web product, funded by the coin's trading fees. The wallet is **local** (`~/.finch/wallet.json`); the key never leaves
your machine and no tool returns it.

| Tool | What it does |
|---|---|
| `launchpad_wallet` | Local EVM address, ETH on Base + Robinhood, spend-gate state and caps (creates the wallet on first use) |
| `launchpad_pairs` | What a token can be paired with on each chain, and the fee split |
| `launchpad_launches` | Browse launches (`new`, `mcap`, `volume`, `gainers`, `holders`) |
| `launchpad_token` | Price, market cap, volume, holders, and the AI founder (status, version, product URL) |
| `launchpad_launch_token` | Launch a token. Preview unless `confirmed: true` |
| `launchpad_buy` / `launchpad_sell` | Trade a launched token through Uniswap v4. Preview, then confirm with the returned `quoteId` |

**Fee split of a new launch (written into the locker at launch, permanent):** 90% of trading fees fund the AI founder's budget
wallet, 10% go to you, 0% to Finch. `burn` and 0%-fee launches route nothing to the agent; a quote that cannot fund the agent keeps
100% with you (the preview says which applies).

**Safety**
- Spending is **default-deny**: set `FINCH_LAUNCHPAD_ALLOW_SPEND=1` to allow `launchpad_launch_token`, `launchpad_buy`, `launchpad_sell`.
- Caps per call: `FINCH_LAUNCHPAD_MAX_BUY_ETH` (default 0.05), `FINCH_LAUNCHPAD_MAX_BUY_USDG` (default 100), `FINCH_LAUNCHPAD_MAX_GAS_ETH` (default 0.01). Junk values fail closed.
- Before signing a launch the tool checks the server's answer field by field (launcher, factory, locker, tick, fee, and that the
  recipients are exactly the expected split) and simulates the transaction; a tampered response is refused and nothing is sent.
- Trades: slippage default 1% (ceiling 5%), price impact above 5% refused, the transaction is simulated before it is sent.
- To move ETH out of the wallet use `base_mcp_send`.

### Solana (`chain: "solana"`)

Solana is not a copy of the EVM flow:

- **Reads** (`launchpad_pairs`, `launchpad_launches`, `launchpad_token`): SOL-denominated; pass the exact, case-sensitive base58 mint.
- **Launch executes in your Finch account, not your local wallet.** A Solana launch creates a 1B-supply SPL mint (9 decimals, mint
  authority revoked) and a single-sided Meteora DAMM v2 pool priced by `startingMarketCapSol` (whole SOL, default 30). It costs about
  **0.025 SOL** of rent and fees, paid by your **Finch custodial Solana wallet**. The agent's share is not split by a contract:
  Finch's fee-claim job claims LP fees from that Finch wallet, sends 90% to the coin's AI founder and leaves 10% with you; Finch takes 0%.
  Launching from a local wallet would never fund the AI founder, so the tool does not do it.
  - **It needs `finch login`** (a real session token: `FINCH_SESSION_TOKEN` or the token cached by `finch login`). A `FINCH_API_KEY`
    or a wallet signature is not enough; without a session the tool stops with a "run `finch login`" error before contacting the launch route.
  - The preview shows your Finch Solana wallet address and its SOL balance so you can fund it (`GET /launchpad/solana/wallet`).
  - Optional `boostSol` deposits SOL into the AI founder's budget. `FINCH_LAUNCHPAD_MAX_SOL_LAUNCH` (default 0.5 SOL) caps boost + rent.
  - It is a server-side action and is **never retried**. If the response is lost, check `launchpad_token` and your Finch wallet before trying again.
- **Buy / sell use your LOCAL Solana wallet** (`sol_wallet`, `~/.finch/solana-wallet.json`) with a direct Meteora cp-amm swap
  (Jupiter refuses fresh Finch pools). The instruction builders and the quote math are byte-for-byte ports of Finch's backend
  (parity tests import the backend modules). Only Finch-launched mints are accepted (checked via `launchpad_token`, and the pool is
  verified on-chain: owned by cp-amm, WSOL + your token). The transaction is checked to contain exactly the planned instructions,
  only cp-amm / token / ATA / system / compute-budget programs, and is simulated: SOL leaving the wallet is capped at input + 0.01 SOL.
  Slippage default 1% (ceiling 5%), price impact above 5% refused, quote drift above 0.5% between preview and execution refused,
  per-buy cap `FINCH_LAUNCHPAD_MAX_BUY_SOL` (default 0.5). Same default-deny `FINCH_LAUNCHPAD_ALLOW_SPEND=1`.
- Not yet proven: no Solana transaction has been sent through these tools; buy/sell are covered by mocks, byte parity with the backend
  and read-only mainnet simulation only.

## Configuration

| Variable | Purpose |
|----------|---------|
| `FINCH_SESSION_TOKEN` | Signed-in session (vault/memory/agents against your account) |
| `FINCH_API_KEY` | API key (`finch_sk_…`) |
| `FINCH_TOOLS` | `core` (default) · `all` · or palettes like `memory,defi` |
| `FINCH_PROVIDER` | Force `bankr` · `anthropic` · `openai` · `grok` |
| `FINCH_MODEL` | Model override for host-side loops |
| `BANKR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GROK_API_KEY` | Required for `ask_finch`, `deep_research`'s synthesis stages, and scheduled-agent learning extraction — these do their own multi-step reasoning server-side and there is no free hosted fallback (BYOK only, one key is enough) |
| `FIRECRAWL_API_KEY` | Better crawl quality (optional) |
| `GITHUB_TOKEN` | For `github_search_code` |
| `ALCHEMY_API_KEY` | Faster Base RPC (optional) |
| `FINCH_SOL_ALLOW_SPEND` | Set to `1` to let `sol_swap`/`sol_send`/`sol_launch_token` execute (default: disabled). Caps: `FINCH_SOL_MAX_SEND_SOL` (1), `FINCH_SOL_MAX_SWAP_SOL` (5) |
| `FINCH_SOLANA_RPC_URL` | Solana RPC for `sol_*` tools (default `https://api.mainnet-beta.solana.com`) |

**Cost model:** almost everything is free to run — the other 110 tools are plain API/RPC calls, and your MCP client's own model (Claude, GPT, whatever's driving the chat) does all the tool-selection reasoning at no cost to Finch. The 5 exceptions above need their own key because their reasoning happens *inside* the tool call, invisible to your client, and can't be delegated to it. Set exactly one of the four env vars and every tool that needs it will use it automatically.

Guided setup:

```bash
npx -y -p @finchagentic/mcp@4.7.5 finch setup
```

## Security

| # | Boundary | Rule |
|:-:|----------|------|
| 1 | Prompt injection | External content is data only — never instructions |
| 2 | Mainnet confirm | Estimate → preview → confirm → execute |
| 3 | Pinned install | Always `@finchagentic/mcp@4.7.5`, never `@latest` |
| 4 | Credential vault | Never paste secrets into prompts or third-party tools |
| 5 | Data disclosure | Know what leaves the machine (LLM, Firecrawl, GitHub, chain RPCs) |
| 6 | Server monitors | Scheduled jobs need explicit confirmation |
| 7 | Fund-moving confirm | `stake_finch`/`unstake_finch`/`base_mcp_send`/`base_mcp_swap`/`rh_mcp_swap` all require `confirm: true`; `sol_swap`/`sol_send`/`sol_launch_token` require `confirmed: true` (swap also rejects >5% price impact) |
| 8 | Local wallet encryption | Set `FINCH_WALLET_PASSPHRASE` for a portable, passphrase-derived key — without it, the key derives from a random per-install secret + machine info, so the wallet file alone (without that secret file) isn't enough to decrypt it |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Tools missing | Fully restart the MCP client |
| Old version | `npx clear-npx-cache` then restart |
| Auth issues | `finch login` or set `FINCH_API_KEY` / `FINCH_SESSION_TOKEN` |
| `ask_finch`/`deep_research` error: "No LLM provider configured" | Set one of `BANKR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GROK_API_KEY` — see [Configuration](#configuration), no free fallback exists |
| Diagnose | `finch doctor` |

## Links

| | |
|--|--|
| **Docs** | [docs.finch.com](https://docs.finch.com) |
| **App** | [app.finchagentic.com](https://app.finchagentic.com) |
| **npm** | [@finchagentic/mcp](https://www.npmjs.com/package/@finchagentic/mcp) |
| **GitHub** | [github.com/finchagentic/mcp](https://github.com/finchagentic/mcp) |
| **X** | [@finchagentic](https://x.com/finchagentic) |

---

MIT License · Finch
