import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CONFIG_DIR  = path.join(os.homedir(), ".noelclaw");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface NoelConfig {
  sessionToken?: string;
  email?: string;
  name?: string;
  memoryBackend?: "local" | "convex";
  supermemoryUrl?: string;
  supermemoryApiKey?: string;
  bankrApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}

export function readConfig(): NoelConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch {
    // Missing/corrupt config file - treat as no saved config.
  }
  return {};
}

export function writeConfig(patch: Partial<NoelConfig>): void {
  const current = readConfig();
  const updated  = { ...current, ...patch };
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
}

export function getSavedToken(): string | undefined {
  // env var always wins over saved config
  return process.env.NOELCLAW_SESSION_TOKEN ?? readConfig().sessionToken;
}

// Injects provider keys saved via `noelclaw setup` into process.env, so both
// the interactive CLI and the MCP server process (spawned fresh by Claude
// Desktop/Cursor/etc, which never sees ~/.noelclaw/config.json otherwise)
// pick them up the same way. An env var already set by the parent process
// always wins - this only fills gaps, never overrides.
export function hydrateEnvFromConfig(): void {
  const cfg = readConfig();
  if (!process.env.BANKR_API_KEY && cfg.bankrApiKey) process.env.BANKR_API_KEY = cfg.bankrApiKey;
  if (!process.env.ANTHROPIC_API_KEY && cfg.anthropicApiKey) process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (!process.env.OPENAI_API_KEY && cfg.openaiApiKey) process.env.OPENAI_API_KEY = cfg.openaiApiKey;
  if (!process.env.OPENAI_BASE_URL && cfg.openaiBaseUrl) process.env.OPENAI_BASE_URL = cfg.openaiBaseUrl;
}
