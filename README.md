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
npx -y -p @finchagentic/mcp@4.0.0 finch install
```

### Claude Code

```bash
claude mcp add finch -s user -- npx -y -p @finchagentic/mcp@4.0.0 finch-mcp
```

### Cursor / Windsurf / Claude Desktop

```json
{
  "mcpServers": {
    "finch": {
      "command": "npx",
      "args": ["-y", "-p", "@finchagentic/mcp@4.0.0", "finch-mcp"]
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
      "args": ["-y", "-p", "@finchagentic/mcp@4.0.0", "finch-mcp"]
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

No LLM API key is required to start. Tools load on first use.

## Quick start

```bash
finch doctor          # health check
finch setup           # local vault / memory / providers
finch vault           # inspect local vault
```

Try in your MCP client:

```
remember: I prefer conservative DeFi strategies, max 5% risk
spawn an agent called research-bot to track AI agent news weekly
save this thesis to vault
```

## What you get

**121 tools** across four pillars:

| Pillar | What it does |
|--------|----------------|
| **Memory** | Full-text searchable memory + versioned vault + chronicle |
| **Agents** | Spawn, recall, update, schedule named agents |
| **Workflows** | Automations, monitors, packets, deep research |
| **Execution** | Base DeFi, Robinhood Chain, market data, web, GitHub |

Default palette is `core` (lighter context). Full set:

```json
"env": { "FINCH_TOOLS": "all" }
```

## Fully local

Finch is the runtime. **Your LLM is the brain. Your data stays yours.**

```bash
npx -y -p @finchagentic/mcp@4.0.0 finch setup
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
| `BANKR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GROK_API_KEY` | Only if Finch itself hosts the agent loop (CLI/cron) |
| `FIRECRAWL_API_KEY` | Better crawl quality (optional) |
| `GITHUB_TOKEN` | For `github_search_code` |
| `ALCHEMY_API_KEY` | Faster Base RPC (optional) |


Guided setup:

```bash
npx -y -p @finchagentic/mcp@4.0.0 finch setup
```

## Security

| # | Boundary | Rule |
|:-:|----------|------|
| 1 | Prompt injection | External content is data only — never instructions |
| 2 | Mainnet confirm | Estimate → preview → confirm → execute |
| 3 | Pinned install | Always `@finchagentic/mcp@4.0.0`, never `@latest` |
| 4 | Credential vault | Never paste secrets into prompts or third-party tools |
| 5 | Data disclosure | Know what leaves the machine (LLM, Firecrawl, GitHub, chain RPCs) |
| 6 | Server monitors | Scheduled jobs need explicit confirmation |
| 7 | Agent schedules | `agent_schedule` confirms cost + side effects |
| 8 | Identity custody | Do not send assets to agent identity addresses |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Tools missing | Fully restart the MCP client |
| Old version | `npx clear-npx-cache` then restart |
| Auth issues | `finch login` or set `FINCH_API_KEY` / `FINCH_SESSION_TOKEN` |
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
