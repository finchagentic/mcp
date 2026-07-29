# Changelog

All notable changes to **@finchagentic/mcp** are documented in this file.

## [4.0.0] — 2026-07-25

### Changed
- **Rebrand: Finch → Finch.** Package is now `@finchagentic/mcp`.
- CLI binaries: `finch`, `finch-mcp` (replaces `finch`, `finch-mcp`).
- Config directory: `~/.finch` (still reads legacy `~/.finch`).
- Env vars: `FINCH_*` (still accepts legacy `FINCH_*`).
- Tool renames: `ask_finch`, `finch_status`, `finch_diagnostics`, `finch_shell_chat`, `get_finch_ledger`.
- Docs: [docs.finch.com](https://docs.finch.com) · GitHub: [finchagentic/mcp](https://github.com/finchagentic/mcp) · X: [@finchagentic](https://x.com/finchagentic).
- Narrative: *The runtime layer for Agentic AI. Persistent memory, autonomous agents, and workflows that survive every session.*

### Notes
- Historical entries below may still mention Finch package names for accuracy of past releases.

## [Unreleased]

## [4.1.0] — 2026-07-29

### Fixed

- **BYOK required for server-side reasoning tools, no more silent hosted billing.** `ask_finch` and `deep_research`'s synthesis stages silently proxied through Finch's own hosted backend when no `BANKR_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GROK_API_KEY` was set — meaning every install without its own key billed the Finch deployment owner. Removed the fallback; these tools now fail with a clear message telling you which env var to set. `market_thesis`/`trade_plan` were unaffected (they never called an LLM — they hand verified data to the calling model).
- **RH-chain token resolution.** `USDG` (Robinhood Chain's settlement stablecoin) now resolves to its canonical address instead of falling through to a fuzzy DexScreener ticker search — the exact symbol an imposter contract would spoof.
- **Chain-ambiguous balance/swap questions** ("what's my balance", "swap ETH to a stablecoin") now check both Base and Robinhood Chain before answering, instead of defaulting to Base.
- **No send/transfer tool exists for Robinhood Chain** — the model is now blocked from calling the Base-only `base_mcp_send` with an RH-only token name instead of risking a mismatched transfer.
- **Base swap/send now confirm the mined receipt** before reporting success — previously `base_mcp_swap`/`base_mcp_send` reported "Swap executed!" from a bare broadcast acceptance, which could misreport a reverted transaction as successful.
- **`base_mcp_lend`/`base_mcp_status` were calling tool names that don't exist**, silently returning empty Morpho/Moonwell data and "Chain stats unavailable" on every call.
- **CLI banner showed the wrong wallet address.** Login banner displayed the account's custodial webapp wallet, but every `base_mcp_*`/`rh_mcp_*` tool signs with a different local device wallet — banner now matches what tools actually report.
- **Wallet passphrase now actually makes the wallet portable.** `FINCH_WALLET_PASSPHRASE` previously still bound the encryption key to the local machine's hostname/platform/arch even when set, so the wallet could never move to a new machine. Includes a one-time in-place migration for existing wallets.
- **Dropped false "semantic AI search" claims** from `vault_search` and 6 `memory_*` tool descriptions — they call full-text (keyword) search, not embeddings; no third-party Supermemory integration exists.
- Finished the Noel→Finch rebrand in `vault.ts`/`chronicle.ts` tool descriptions and output headers (17 occurrences visible directly in any MCP client's tool list, missed by the earlier docs-only rebrand pass).

## [3.44.0] - 2026-07-23

### Added

- **Fully-local mode.** Run the whole runtime on your own machine — no account, no cloud, nothing phones home. See [`docs/local-first.md`](docs/local-first.md).
  - **Local vault** (`vaultBackend: "local"`, via `finch setup`): every vault tool (`vault_save`/`read`/`list`/`search`/`history`/`diff`/`pin`/`tag`/`link`/`related`/`export`/`store_credential`/`get_credential`) stores on your disk under `~/.finch/vault/`. Versioned, `[[wikilink]]` + `#tag` aware, local full-text search, credentials encrypted at rest (AES-256-GCM). Zero dependencies (plain JSON + one file per version, atomic manifest writes). Falls back to the hosted vault when local isn't enabled — same two-tier pattern as local memory. Data is a plain folder: back it up / `git` it / sync it however you like.
  - `finch vault` — new CLI command: shows the vault location, contents, and backup hints. `finch doctor` gained a matching "Local vault" check.
- **MCP spec compliance.** Behavioral annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) on all 121 tools, a server `instructions` field, and structured output (`outputSchema` + `structuredContent`) on 40 read tools via a central registry.

### Fixed

- **Install: per-client config formats.** `finch install` now writes the correct schema per client — VS Code uses the `servers` key with `"type": "stdio"`, Zed uses `context_servers` in `settings.json` with `"source": "custom"` (previously both got a `mcpServers` shape they ignore). Windsurf path corrected to `~/.codeium/windsurf/mcp_config.json`.
- **Install: never clobber a config it can't parse.** An existing JSONC config with comments (common in VS Code/Zed) is now left untouched with a manual-add hint, instead of being overwritten and wiped.
- **Install: broken manual fallback** — the "no client found" snippet printed the `npx -y @finchagentic/mcp` form that fails with "could not determine executable to run"; now prints the working `-p …@version finch-mcp` form.
- `finch-mcp login` unified with `finch login` (both take a `noel_sk_` API key against `/auth/apikey/login`, instead of two divergent flows).
- MCP server boot banner: fixed corrupted UTF-8 (rendered as mojibake in client logs) and now reports the *exposed* tool count (respecting `FINCH_TOOLS`) rather than always claiming 121.
- `vault_save` local mode: no longer attempts a hosted memory sync (which required auth) when running local vault without local memory — avoids a phone-home the local-only user can't satisfy.
- Two local-vault edge cases: auto-generated keys that slugify to the same value are disambiguated instead of silently versioning a different note; `vault_diff` guards against a pathologically large line-by-line diff.

### Changed

- Whole `src/` tree is now lint-clean; CI lint step made strict (`--max-warnings 0`, no `continue-on-error`).

## [3.43.2] - 2026-07-22

### Changed

- Robinhood Chain stock catalog expanded 18 -> 22: added NFLX, SPY, QQQ, GME (official Robinhood Token contracts, DexScreener-verified).
- README: removed all shield badges (npm version/downloads, GitHub stars/license, CI, CodeQL, Node, MCP).

## [3.43.1] - 2026-07-22

### Changed

- Removed all emoji from tool descriptions (warning prefixes are now plain text: `PERMANENT.`, `IRREVERSIBLE.`, `CAUTION:`) and from README headings/TOC/tables.
- Corrected the tool count everywhere to the measured 121 (`ALL_TOOLS.length`): npm package description, README (including the hero banner and pillar table), and docs.
- npm package description now mentions x402 pay-per-call APIs.

## [3.34.0] - 2026-07-20

### Added

- **`rh_mcp_*` family (5 tools)** — Robinhood Chain tokenized-stock rail, parity with `base_mcp_*`:
  - `rh_mcp_status` — chain 4663 status, wallet, ETH gas on RH, explorer
  - `rh_mcp_list_stocks` — 18 ClawHood/Finch tickers (AAPL…USAR)
  - `rh_mcp_balance` — ETH + stock balances via RH RPC (not Alchemy Base)
  - `rh_mcp_estimate` — Uni V4 quote (direct ETH↔stock or multi-hop via USDG)
  - `rh_mcp_swap` — execute with `confirm:true`; sells auto 2-step Permit2
- Backend: `POST /mcp/rh/quote` → `walletActions.zeroXQuote({ chainId: 4663 })`
- Agent loop + `FINCH_TOOLS=defi` preset include `rh_mcp_*`
- Explicitly **not** Robinhood Agentic brokerage MCP (`agent.robinhood.com`)

109 → **114** tools.

## [3.33.0] - 2026-07-18

### Added

- `get_base_token_data` - new Market tool. Live market data for any Base-chain token by contract address (price, 1h/6h/24h change, volume, liquidity, market cap, FDV, pair age, website/social links) via DexScreener, plus a CoinGecko contract-lookup check so callers know upfront whether `token_history` can produce a real historical chart for that token. Unlike `get_token_data`/`compare_tokens` (symbol-based, limited to CoinGecko's own listings), this works for any Base token by address - including ones too new or small to be listed anywhere. 108 → 109 tools.

## [3.32.8] - 2026-07-18

### Fixed

- **CLI login menu offered a dead "Email (OTP)" option** that called `/auth/otp/send` and `/auth/otp/verify` - both removed from the backend when email OTP auth was deleted in July 2026. Every user who picked that option got a broken/confusing failure. The interactive login flow now goes straight to API-key login, the only path that still exists.
- Deduplicated the doubled-input-stripping workaround for a known Clink v1.7.6 terminal bug: it was reimplemented inline in three separate places (`loginWithApiKey`, the old OTP/API-key menu prompt, `setupFlow`'s provider prompts) instead of using the single `dedupClinkInput` helper that already existed for exactly this. Extracted it into `src/clink-input.ts` so it's shared and independently testable.
- Removed a second, fully duplicated copy of the API-key env-var login path in the `finch login` CLI entry point (promise-chain style, 4-space indented, diverging from the rest of the file) - it now just delegates to `loginFlow()`, which already has this exact check.

### Added

- Real test suite (`npm test`, Vitest) covering tool registration (`ALL_TOOLS`/`HANDLER_MAP` consistency, schema shape, no duplicate names), provider-routing priority (Bankr-before-Anthropic ordering, no hardcoded `grok-3`), and the Clink dedup helper. CI's `Test` step no longer runs with `continue-on-error: true` — previously `npm test` had no script defined at all, so CI was silently masking a total absence of automated coverage.

### Removed

- `test_login.js` from the repo root - it hardcoded a live-looking `noel_sk_*` API key and had a syntax error preventing it from even running. If you have this package checked out locally, note that key may have been exposed via git history; rotate it if it's real.

### Added

- Local, self-hosted memory backend (self-hosted [supermemory](https://github.com/supermemoryai/supermemory)) - opt-in via `finch setup`. Memory tools run entirely on your own machine, zero cost, no Finch account or Convex proxy involved once enabled.
- OpenAI as a fourth BYOK LLM provider (`OPENAI_API_KEY`), alongside Bankr/Anthropic/Grok. Includes `OPENAI_BASE_URL` override for any OpenAI Chat Completions-compatible self-hosted endpoint (LiteLLM, vLLM, Ollama, OpenRouter, your own VPS gateway).
- `finch setup` - new CLI command: configure a BYOK LLM provider and/or enable local memory in one guided flow.

**Known limitation:** the local memory client (`src/local-memory.ts`) has been code-reviewed and unit-verified (branching logic, config handling, error paths), but has **not yet been live-tested against a running `supermemory-server`** - the official installer requires WSL2 on Windows, and setting up a WSL distro + an LLM key for supermemory's own embedding pipeline wasn't completed this release. In particular the `"*"` wildcard-search assumption in `localMemoryList()` (used by `memory_list`/`memory_profile`/dedup detection) is unverified against the real API. Treat local memory as beta until confirmed against a live server.

### Fixed

- **Critical:** `finch install` wrote a broken MCP server entry into every detected client config - `npx -y @finchagentic/mcp@latest` fails outright with "could not determine executable to run" (the package ships two bins, `finch` and `finch-mcp`, and npx can't resolve which one to run from the package name alone). Every fresh install via the CLI's own auto-configure feature was non-functional. Now writes the unambiguous form (`npx -y -p @finchagentic/mcp@<pinned-version> finch-mcp`), pinned to the installed version instead of `@latest`.

## [3.32.6] - 2026-07-09

### Fixed

- **Critical:** `getOrCreateWallet` silently generated and saved a brand-new random wallet whenever the existing `wallet.json` failed to decrypt (wrong/missing `FINCH_WALLET_PASSPHRASE`, different machine, etc.), overwriting the file with zero warning — orphaning the previous wallet and any funds it held. Now throws a clear error instead of auto-replacing the file; only creates a new wallet when none exists yet.

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

- Update notification now shows pinned version (`npm install -g @finchagentic/mcp@X.Y.Z`) instead of `@latest` — consistent with supply-chain security boundary.

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
- **`wallet_sign_message`** — EIP-191 personal_sign with the local Finch wallet. Returns signature + verification instructions. Useful for proving wallet ownership off-chain.
- **`chronicle_search`** — keyword search across chronicle events by title and detail. Answers "when did I last research ETH?" without scrolling through the full log.
- **`chronicle_stats`** — runtime activity analytics: event breakdown by type, daily heatmap, busiest days, and average events per day over a configurable window (default 30 days, max 90).
- **`noel_diagnostics`** — pre-flight health check: pings Convex backend, Firecrawl, and Supermemory; lists which API keys are configured; warns on missing LLM key or Firecrawl key with actionable hints.
- **Base Builder Code** — all x402 payment flows now include `bc_7diuqbqo` as `builderCode` in the 402 response body and `X-Builder-Code` header. Transactions are attributed to Finch in the Base Dashboard.

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
- **PWA** support for the Finch web app — installable, offline-capable, with
  background sync for agent state.
- **Deep research multi-agent synthesis** — `deep_research` now orchestrates
  multiple specialist agents, each producing a sub-report, then synthesizes a
  single grounded report with citations. Compare and chain modes
  (`research_compare`, `research_chain`) build on the same pipeline.
- **90-day memory decay** — memories use a 90-day half-life so recent context
  ranks above stale notes during semantic `memory_search` and
  `memory_context` retrieval. Older entries are down-ranked, not deleted.
- `finch doctor` — five-second health check showing exactly what is wired and
  what is missing (API keys, session token, RPC, tool palette).
- `finch install` — one-command auto-install that detects Claude Code,
  Cursor, Windsurf, VS Code, and Zed and configures each automatically.
- Tool palette via `FINCH_TOOLS`: `all` (103), `core` (~40), `defi`,
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

[Unreleased]: https://github.com/finchagentic/mcp/compare/v3.32.4...HEAD
[3.32.4]: https://github.com/finchagentic/mcp/compare/v3.32.3...v3.32.4
[3.32.3]: https://github.com/finchagentic/mcp/compare/v3.32.2...v3.32.3
[3.32.2]: https://github.com/finchagentic/mcp/compare/v3.32.1...v3.32.2
[3.32.1]: https://github.com/finchagentic/mcp/compare/v3.32.0...v3.32.1
[3.32.0]: https://github.com/finchagentic/mcp/compare/v3.31.0...v3.32.0
[3.31.0]: https://github.com/finchagentic/mcp/compare/v3.29.0...v3.31.0
[3.29.0]: https://github.com/finchagentic/mcp/releases/tag/v3.29.0
[3.28.0]: https://github.com/finchagentic/mcp/releases/tag/v3.28.0
