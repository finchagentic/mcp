# Changelog

All notable changes to the **@noelclaw/mcp** package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.32.7] - 2026-07-10

### Added

- Local, self-hosted memory backend (self-hosted [supermemory](https://github.com/supermemoryai/supermemory)) - opt-in via `noelclaw setup`. Memory tools run entirely on your own machine, zero cost, no Noelclaw account or Convex proxy involved once enabled.
- OpenAI as a fourth BYOK LLM provider (`OPENAI_API_KEY`), alongside Bankr/Anthropic/Grok. Includes `OPENAI_BASE_URL` override for any OpenAI Chat Completions-compatible self-hosted endpoint (LiteLLM, vLLM, Ollama, OpenRouter, your own VPS gateway).
- `noelclaw setup` - new CLI command: configure a BYOK LLM provider and/or enable local memory in one guided flow.

**Known limitation:** the local memory client (`src/local-memory.ts`) has been code-reviewed and unit-verified (branching logic, config handling, error paths), but has **not yet been live-tested against a running `supermemory-server`** - the official installer requires WSL2 on Windows, and setting up a WSL distro + an LLM key for supermemory's own embedding pipeline wasn't completed this release. In particular the `"*"` wildcard-search assumption in `localMemoryList()` (used by `memory_list`/`memory_profile`/dedup detection) is unverified against the real API. Treat local memory as beta until confirmed against a live server.

### Fixed

- **Critical:** `noelclaw install` wrote a broken MCP server entry into every detected client config - `npx -y @noelclaw/mcp@latest` fails outright with "could not determine executable to run" (the package ships two bins, `noelclaw` and `noelclaw-mcp`, and npx can't resolve which one to run from the package name alone). Every fresh install via the CLI's own auto-configure feature was non-functional. Now writes the unambiguous form (`npx -y -p @noelclaw/mcp@<pinned-version> noelclaw-mcp`), pinned to the installed version instead of `@latest`.

## [3.32.6] - 2026-07-09

### Fixed

- **Critical:** `getOrCreateWallet` silently generated and saved a brand-new random wallet whenever the existing `wallet.json` failed to decrypt (wrong/missing `NOELCLAW_WALLET_PASSPHRASE`, different machine, etc.), overwriting the file with zero warning — orphaning the previous wallet and any funds it held. Now throws a clear error instead of auto-replacing the file; only creates a new wallet when none exists yet.

## [3.32.5] - 2026-07-09

### Fixed

- `score_token` returned data for the wrong token when the queried address was the *quote* currency (not base) in the top-liquidity DexScreener pair — e.g. checking USDC returned AERO's price and score. Now filters to pairs where the queried address is the base token; returns a clear error if the token never appears as a base token instead of silently scoring the wrong asset. Matters most for stablecoins/RWA tokens (B20), which are frequently paired as the quote side.

## [3.32.4] - 2026-06-26

### Fixed

- `base_mcp_balance` live ETH price fix — fetches CoinGecko in parallel with RPC call, shows `≈ $X.XX USD` next to ETH balance. Eliminates stale price hallucination from LLM training data.

## [3.32.3] - 2026-06-26

### Fixed

- `get_wallet_balance` now fetches live ETH price from CoinGecko and includes USD value in the output table. LLM no longer needs to estimate price from training data.
- `base_mcp_balance` now also fetches live ETH price from CoinGecko in parallel with RPC balance call. Output includes `≈ $X.XX USD` next to ETH balance and `ETH price: $X,XXX · source: CoinGecko` footer — eliminates stale price hallucination.

## [3.32.2] - 2026-06-26

### Fixed

- Update notification now shows pinned version (`npm install -g @noelclaw/mcp@X.Y.Z`) instead of `@latest` — consistent with supply-chain security boundary.

## [3.32.1] - 2026-06-26

### Fixed

- README hero banner SVG updated to show 108 tools (was hardcoded to 103 in base64).
- `package.json` description updated to 108 MCP tools.
- All install commands, SKILL.md, and docs bumped to `@3.32.1`.

## [3.32.0] - 2026-06-26

### Added

- **`execute_swap`** — execute a token swap on Base mainnet from Noel Shell. Requires `confirmed=true` after explicit user confirmation. Enforces estimate → preview → confirm → execute flow. Routes through 0x Permit2 via the custodial wallet. Returns tx hash + Basescan link.

### Security

- `execute_swap` is hard-blocked without `confirmed=true` — LLM cannot bypass the confirmation gate.
- Noel Shell system prompt updated: LLM instructed to always call `estimate_swap` first and wait for explicit user confirmation before calling `execute_swap`.

## [3.31.0] - 2026-06-26

### Added

- **`get_wallet_balance`** — live ETH + USDC balance from Base mainnet via public RPC. No API key required. Accepts optional address to check any wallet. Returns table + Basescan link.
- **`wallet_sign_message`** — EIP-191 personal_sign with the local Noelclaw wallet. Returns signature + verification instructions. Useful for proving wallet ownership off-chain.
- **`chronicle_search`** — keyword search across chronicle events by title and detail. Answers "when did I last research ETH?" without scrolling through the full log.
- **`chronicle_stats`** — runtime activity analytics: event breakdown by type, daily heatmap, busiest days, and average events per day over a configurable window (default 30 days, max 90).
- **`noel_diagnostics`** — pre-flight health check: pings Convex backend, Firecrawl, and Supermemory; lists which API keys are configured; warns on missing LLM key or Firecrawl key with actionable hints.
- **Base Builder Code** — all x402 payment flows now include `bc_7diuqbqo` as `builderCode` in the 402 response body and `X-Builder-Code` header. Transactions are attributed to Noelclaw in the Base Dashboard.

### Fixed

- `get_wallet_balance` RPC calls now race against a 10-second timeout — prevents hanging on slow Base RPC nodes.
- `noel_diagnostics` Convex ping now targets `/auth/otp/send` (a known live endpoint) instead of `/health` which returned 404 and incorrectly showed Convex as unreachable.
- `chronicle_search` and `chronicle_stats` output now explicitly notes "most recent 100 entries" so users know the search scope.

### Security

- SKILL.md updated with all 8 security boundaries: prompt-injection, mainnet confirmation flow, pinned install, credential vault trust, data flow disclosure, monitor consent, agent schedule disclosure, and agent identity custody.
- DeFi flow in SKILL.md now enforces explicit estimate → preview → confirm → execute sequence.
- Monitor flow in SKILL.md now requires explicit user confirmation before `schedule_research` with cost/persistence disclosure.

### Changed

- `get_wallet_address` output now includes hint to run `get_wallet_balance`.
- Architecture diagram updated: v3.31.0, 107 tools, wallet RPC branch added.
- `MINIMAX_API_KEY` reference removed from docs — humanizer uses standard LLM router (`callLLM`), not MiniMax directly.

## [3.29.0] - 2026-06-24

The runtime layer for Agentic AI. Persistent memory, autonomous agents, vault
storage, and scheduled workflows — for Claude Code, Cursor, Windsurf, Codex,
Aeon, Antigravity, and any MCP-compatible client.

### Added

- **103 MCP tools** across the runtime, verified with zero errors across four
  end-to-end rescans. Tools span memory, vault, chronicle, agents, automation,
  monitors, packets, deep research, DeFi, Base, market, scanner, web, coder,
  github, and humanizer categories.
- **PWA** support for the NoelClaw web app — installable, offline-capable, with
  background sync for agent state.
- **Deep research multi-agent synthesis** — `deep_research` now orchestrates
  multiple specialist agents, each producing a sub-report, then synthesizes a
  single grounded report with citations. Compare and chain modes
  (`research_compare`, `research_chain`) build on the same pipeline.
- **90-day memory decay** — memories use a 90-day half-life so recent context
  ranks above stale notes during semantic `memory_search` and
  `memory_context` retrieval. Older entries are down-ranked, not deleted.
- `noelclaw doctor` — five-second health check showing exactly what is wired and
  what is missing (API keys, session token, RPC, tool palette).
- `noelclaw install` — one-command auto-install that detects Claude Code,
  Cursor, Windsurf, VS Code, and Zed and configures each automatically.
- Tool palette via `NOELCLAW_TOOLS`: `all` (103), `core` (~40), `defi`,
  `research`, `memory`.

### Changed

- **Bundle splitting** — the web app `vite.config.ts` now uses `manualChunks`
  to split out `vendor-phaser`, `vendor-privy`, `vendor-convex`,
  `vendor-motion`, `vendor-icons`, `vendor-radix`, and `vendor-react`,
  reducing the main bundle and improving cache hit rates.
- **React 19 upgrade** — the web app and all shared UI moved to React 19,
  including the newer `use()` hook and concurrent rendering for chat streams.
- HTTP cache + 429 backoff on every external call for reliability across
  long-running agent loops.
- `prepare` script now installs Husky git hooks; `prepublishOnly` still builds
  before npm publish.

### Security

- **Slippage caps** — swap tools refuse trades whose price impact exceeds the
  configured cap. Users can override with an explicit `maxPriceImpactPct`, but
  the default refuses bad fills rather than trusting the LLM.
- **Audit grounding** — contract scanner refuses to act on contracts flagged as
  unsafe by audit data, surfacing the findings instead of executing.
- **Prompt-injection boundary** — tool inputs from untrusted sources (web
  pages, research content, contract metadata) are treated as data, not
  instructions; they never enter the system prompt and cannot change tool
  routing or spawn unsanctioned agents.
- Wallets continue to use AES-256-CBC encryption for private keys at rest;
  sessions use server-issued tokens; passwords use bcrypt.

## [3.28.0] - 2026-05-01

- Maintenance release: dependency bumps, minor tool refinements.
  See git history for details.

[Unreleased]: https://github.com/noelclaw/mcp/compare/v3.32.4...HEAD
[3.32.4]: https://github.com/noelclaw/mcp/compare/v3.32.3...v3.32.4
[3.32.3]: https://github.com/noelclaw/mcp/compare/v3.32.2...v3.32.3
[3.32.2]: https://github.com/noelclaw/mcp/compare/v3.32.1...v3.32.2
[3.32.1]: https://github.com/noelclaw/mcp/compare/v3.32.0...v3.32.1
[3.32.0]: https://github.com/noelclaw/mcp/compare/v3.31.0...v3.32.0
[3.31.0]: https://github.com/noelclaw/mcp/compare/v3.29.0...v3.31.0
[3.29.0]: https://github.com/noelclaw/mcp/releases/tag/v3.29.0
[3.28.0]: https://github.com/noelclaw/mcp/releases/tag/v3.28.0
