import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CONFIG_DIR  = path.join(os.homedir(), ".finch");
const LEGACY_DIR  = path.join(os.homedir(), ".finch");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LEGACY_FILE = path.join(LEGACY_DIR, "config.json");

export interface FinchConfig {
  sessionToken?: string;
  email?: string;
  name?: string;
  // The account's real custodial wallet (same one the webapp Profile page
  // shows), returned by /auth/apikey/login. Distinct from the local
  // per-device signing wallet at ~/.finch/wallet.json - showing the wrong
  // one after login is what a signed-in user's "Wallet" line should never do.
  walletAddress?: string;
  // "local-file" = zero-dependency memory on this machine under
  // ~/.finch/memory/ (no server, no key). "local" = client for a
  // separately-run supermemory server (needs supermemoryUrl/ApiKey below).
  // Unset/"convex" = hosted.
  memoryBackend?: "local-file" | "local" | "convex";
  supermemoryUrl?: string;
  supermemoryApiKey?: string;
  // "local" = store vault artifacts on this machine under ~/.finch/vault/
  // (user-owned, no account, no Convex). Unset/"convex" = hosted vault.
  vaultBackend?: "local" | "convex";
  bankrApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}

/** Prefer FINCH_* env, fall back to legacy FINCH_* during rebrand. */
export function env(name: string, legacy?: string): string | undefined {
  const primary = process.env[name];
  if (primary !== undefined && primary !== "") return primary;
  if (legacy) {
    const v = process.env[legacy];
    if (v !== undefined && v !== "") return v;
  }
  // Auto-map FINCH_X → FINCH_X when legacy not passed
  if (name.startsWith("FINCH_")) {
    const auto = "FINCH_" + name.slice("FINCH_".length);
    const v = process.env[auto];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export function readConfig(): FinchConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
    // migrate-read: still pick up old ~/.finch/config.json
    if (fs.existsSync(LEGACY_FILE)) {
      return JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
    }
  } catch {
    // Missing/corrupt config file - treat as no saved config.
  }
  return {};
}

export function writeConfig(patch: Partial<FinchConfig>): void {
  const current = readConfig();
  const updated  = { ...current, ...patch };
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
}

export function getSavedToken(): string | undefined {
  // env var always wins over saved config
  return env("FINCH_SESSION_TOKEN", "FINCH_SESSION_TOKEN") ?? readConfig().sessionToken;
}

/** Accept finch_sk_* (new) and noel_sk_* (backend still issues these). */
export function isApiKey(value: string | undefined | null): boolean {
  if (!value) return false;
  return value.startsWith("finch_sk_") || value.startsWith("noel_sk_");
}

// Injects provider keys saved via `finch setup` into process.env, so both
// the interactive CLI and the MCP server process (spawned fresh by Claude
// Desktop/Cursor/etc, which never sees ~/.finch/config.json otherwise)
// pick them up the same way. An env var already set by the parent process
// always wins - this only fills gaps, never overrides.
export function hydrateEnvFromConfig(): void {
  const cfg = readConfig();
  if (!process.env.BANKR_API_KEY && cfg.bankrApiKey) process.env.BANKR_API_KEY = cfg.bankrApiKey;
  if (!process.env.ANTHROPIC_API_KEY && cfg.anthropicApiKey) process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (!process.env.OPENAI_API_KEY && cfg.openaiApiKey) process.env.OPENAI_API_KEY = cfg.openaiApiKey;
  if (!process.env.OPENAI_BASE_URL && cfg.openaiBaseUrl) process.env.OPENAI_BASE_URL = cfg.openaiBaseUrl;

  // Bridge legacy env into FINCH_* so the rest of the codebase can read one name.
  const bridges: Array<[string, string]> = [
    ["FINCH_SESSION_TOKEN", "FINCH_SESSION_TOKEN"],
    ["FINCH_API_KEY", "FINCH_API_KEY"],
    ["FINCH_CONVEX_URL", "FINCH_CONVEX_URL"],
    ["FINCH_TOOLS", "FINCH_TOOLS"],
    ["FINCH_PROVIDER", "FINCH_PROVIDER"],
    ["FINCH_MODEL", "FINCH_MODEL"],
    ["FINCH_RPC_URL", "FINCH_RPC_URL"],
    ["FINCH_BROADCAST_RPC", "FINCH_BROADCAST_RPC"],
    ["FINCH_WALLET_PASSPHRASE", "FINCH_WALLET_PASSPHRASE"],
    ["FINCH_PAYMENT_HEADER", "FINCH_PAYMENT_HEADER"],
  ];
  for (const [fin, leg] of bridges) {
    if (!process.env[fin] && process.env[leg]) process.env[fin] = process.env[leg]!;
  }
}
