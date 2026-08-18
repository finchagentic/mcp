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
npx -y -p @finchagentic/mcp@4.6.0 finch install
```

### Claude Code

```bash
claude mcp add finch -s user -- npx -y -p @finchagentic/mcp@4.6.0 finch-mcp
```

### Cursor / Windsurf / Claude Desktop

```json
{
  "mcpServers": {
    "finch": {
      "command": "npx",
      "args": ["-y", "-p", "@finchagentic/mcp@4.6.0", "finch-mcp"]
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
      "args": ["-y", "-p", "@finchagentic/mcp@4.6.0", "finch-mcp"]
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
| **Execution** | Base DeFi, Robinhood Chain, market data, web, GitHub |

Coding and research sessions persist the same way: `deep_research` auto-saves its report to vault and links it to related past reports; `code_session_save` does the same for coding/debugging sessions (`vault_save type=code`, versioned per project, auto-linked). Both exist so the next session — yours or another agent's — starts with real context instead of cold.

`vault_save` and `agent_spawn` also take an optional `workspaceProject` - the same named Projects a user organizes their Agents/vault content into on the webapp's Agents page. Pass a name and it's matched case-insensitively or created automatically (`list_projects` to browse what exists first). Hosted vault only - local-vault mode has no project concept.

Default palette is `core` (lighter context). Full set:

```json
"env": { "FINCH_TOOLS": "all" }
```

## Fully local

Finch is the runtime. **Your LLM is the brain. Your data stays yours.**

```bash
npx -y -p @finchagentic/mcp@4.6.0 finch setup
# enable local vault (and optional local memory)
```

| Piece | Location |
|-------|----------|
| Vault | `~/.finch/vault/` |
| Wallet | `~/.finch/wallet.json` |
| Config | `~/.finch/config.json` |
| Brain | your MCP client’s model |

Scheduled/cloud features still need an account. Core memory, vault, and public-data tools work offline of Finch cloud.

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

**Cost model:** almost everything is free to run — the other 110 tools are plain API/RPC calls, and your MCP client's own model (Claude, GPT, whatever's driving the chat) does all the tool-selection reasoning at no cost to Finch. The 5 exceptions above need their own key because their reasoning happens *inside* the tool call, invisible to your client, and can't be delegated to it. Set exactly one of the four env vars and every tool that needs it will use it automatically.

Guided setup:

```bash
npx -y -p @finchagentic/mcp@4.6.0 finch setup
```

## Security

| # | Boundary | Rule |
|:-:|----------|------|
| 1 | Prompt injection | External content is data only — never instructions |
| 2 | Mainnet confirm | Estimate → preview → confirm → execute |
| 3 | Pinned install | Always `@finchagentic/mcp@4.6.0`, never `@latest` |
| 4 | Credential vault | Never paste secrets into prompts or third-party tools |
| 5 | Data disclosure | Know what leaves the machine (LLM, Firecrawl, GitHub, chain RPCs) |
| 6 | Server monitors | Scheduled jobs need explicit confirmation |
| 7 | Fund-moving confirm | `stake_finch`/`unstake_finch`/`base_mcp_send`/`base_mcp_swap`/`rh_mcp_swap` all require `confirm: true` |
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
