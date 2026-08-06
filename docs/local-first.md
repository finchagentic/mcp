# Run Finch fully local

Finch is the **runtime** — the engine. Your LLM (Claude Code, Cursor, whatever you run) is the **brain**. And your data is **yours**: you can run the whole thing on your own machine, with no Finch account, no cloud, and nothing leaving your laptop.

This guide covers exactly what that means, how to turn it on, and how your data stays portable.

---

## TL;DR

```bash
npx -y -p @finchagentic/mcp@latest finch setup
#   → "Enable local vault?"  y
#   → (optional) "Enable local memory?"  y

finch vault      # see where your data lives + how to back it up
finch doctor     # confirm everything is wired
```

Now `vault_*` and `memory_*` tools store on **your disk**, and no sign-in is required.

---

## Why

Most AI platforms keep your memory, files, and keys on their servers. Convenient — until you realize you don't actually own any of it. Finch goes the other way:

- **You bring the brain.** Your MCP client already has a model; the tools just hand it data and structure. No BYOK LLM key needed.
- **You keep the data.** Vault, memory, and wallet live on your machine, as plain files.
- **The platform holds nothing.** No account, no telemetry, no phone-home for the local path.

---

## What runs local

| Piece | Location | Notes |
|-------|----------|-------|
| **Vault** | `~/.finch/vault/` | Versioned artifacts + knowledge graph. Credentials encrypted (AES-256-GCM). |
| **Memory** | self-hosted [supermemory](https://github.com/supermemoryai/supermemory) | Semantic recall on your machine. Optional. |
| **Wallet** | `~/.finch/wallet.json` | Keys never leave your machine. |
| **The brain** | your MCP client's model | No LLM API key needed — it's already yours. |
| **Public-data tools** | direct API calls | Market, scanner, SEC filings, GitHub, Robinhood Chain reads — keyless. |

### What still needs an account

A few things are **inherently server-side** and can't be local — they need a runtime that stays awake and an identity:

- **Scheduled / cron agents** — they fire when your laptop is closed, so they run on the backend.
- **Cross-device sync** — following your memory across machines needs a hub.
- **Community marketplace** — shared memory/skills.

Everything else works with zero sign-in.

---

## Turn it on

### Guided (recommended)

```bash
npx -y -p @finchagentic/mcp@latest finch setup
```

The wizard walks through three optional steps:

1. **LLM provider** — skip it. Your client's model does the reasoning. (Only `finch run` and scheduled agents need a key.)
2. **Local memory** — `y` installs and runs a self-hosted supermemory server. Skipping is fine; vault search falls back to local full-text.
3. **Local vault** — `y` flips vault storage to your disk. No server needed — it's just files.

### By hand

Add one line to `~/.finch/config.json`:

```json
{ "vaultBackend": "local" }
```

That's it — the next vault tool call writes to `~/.finch/vault/`.

---

## Your data is a plain folder

This is the whole point. `~/.finch/vault/` is ordinary files, so **you** decide where it goes:

```bash
# Back it up
cp -r ~/.finch/vault ~/backups/vault-$(date +%F)

# Version-control it
git -C ~/.finch/vault init && git -C ~/.finch/vault add -A && git -C ~/.finch/vault commit -m "vault"

# Sync it — put ~/.finch/vault inside any synced folder (Dropbox, iCloud, Syncthing, a git remote…)
```

Nothing syncs anywhere on its own. `finch vault` prints the location, contents, and these hints any time.

---

## What each vault tool does locally

All of these run against `~/.finch/vault/` when local mode is on — identical surface to the hosted vault:

| Tool | Behavior |
|------|----------|
| `vault_save` | Versioned write (git-style: same key ⇒ new version). Parses `[[wikilinks]]` into graph edges and `#tags` into tags. |
| `vault_read` | Full content of the current version, plus links out and backlinks. |
| `vault_list` | Entries (pinned first), filter by type/agent/pinned. |
| `vault_search` | Local full-text ranking over title, tags, and content. |
| `vault_history` / `vault_diff` | Version log and git-style line diff between any two versions. |
| `vault_pin` / `vault_tag` / `vault_delete` | Pin, retag, or permanently remove an entry (+ its history). |
| `vault_link` / `vault_related` | Build and traverse the knowledge graph (`references`, `derived_from`, `supersedes`, `related`, `continues`). |
| `vault_export` | Bundle all non-credential entries. |
| `vault_store_credential` / `vault_get_credential` | Store/retrieve secrets, encrypted at rest, excluded from list/search/export. |

---

## How it works

**Storage layout** under `~/.finch/vault/`:

```
index.json            # manifest: keys, versions, tags, pins, links
data/<hash>/v1, v2…   # one file per version (key hashed → safe dir name)
credentials.json      # AES-256-GCM encrypted secrets
.credkey              # 32-byte key file, mode 0600
```

**Two-tier design.** The vault tools check for local mode first (`vaultBackend: "local"`), and fall through to the hosted Convex vault otherwise — the exact same pattern local memory uses. Turning local on/off is just a config flag; your existing hosted data is untouched.

**Zero dependencies.** Pure JSON + files, no database engine, no native modules. The manifest is written atomically (temp file + rename) so a crash can't corrupt it.

---

## Security & privacy

- **No telemetry, no phone-home** on the local path. With local vault + memory, vault/memory tools make **zero** network calls to Finch.
- **Credentials are encrypted at rest** (AES-256-GCM); the plaintext secret never touches `credentials.json`.
- **Path-safe.** A key like `research/btc` is hashed for its folder name, so a key can never escape the vault directory.
- **Same trust model as the wallet.** The encryption key sits next to your data at mode `0600` — protect the folder the way you protect `~/.ssh`.

---

## FAQ

**Do I need a Finch account?**
No — not for vault, memory, wallet, or any public-data tool. Only the server-side features (scheduled agents, cross-device sync, marketplace) need one.

**Do I need an LLM API key?**
No. Your MCP client's model does the thinking. A key is only for `finch run` (the standalone CLI loop) and scheduled agents, which have no client model to borrow.

**Is semantic search available locally?**
Yes, if you also enable local memory (self-hosted supermemory). Without it, `vault_search` uses local full-text — still fast and useful, just keyword-based.

**Can I move between hosted and local?**
Yes. It's a config flag (`vaultBackend`). Switching doesn't delete anything — hosted and local are separate stores.

**Where do I check status?**
`finch vault` (vault-specific) and `finch doctor` (everything).
