#!/usr/bin/env node
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runAgent } from "./agent-loop.js";
import { ALL_TOOLS } from "./server.js";
import { filterTools } from "./tool-filter.js";
import { writeConfig, readConfig, hydrateEnvFromConfig } from "./config.js";
import type { ChatMessage } from "./llm.js";
import { getLocalMemoryConfig, isLocalMemoryReachable } from "./local-memory.js";
import * as child_process from "child_process";

hydrateEnvFromConfig();

// Derived tool counts - single source of truth, kept in sync with the
// actual registered tools. Updates here propagate to banner, login,
// and doctor without manual edits.
const TOTAL_TOOL_COUNT = ALL_TOOLS.length;
const CORE_TOOL_COUNT = (() => {
  const prev = process.env.NOELCLAW_TOOLS;
  try {
    process.env.NOELCLAW_TOOLS = "core";
    return filterTools(ALL_TOOLS).length;
  } finally {
    if (prev === undefined) delete process.env.NOELCLAW_TOOLS;
    else process.env.NOELCLAW_TOOLS = prev;
  }
})();

const CONVEX_SITE = process.env.NOELCLAW_CONVEX_URL ?? "https://befitting-porcupine-276.convex.site";

const PKG_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// Read wallet address from the encrypted JSON without decrypting -
// ethers stores the address in plaintext inside the keystore file.
function getLocalWalletAddress(): string | null {
  try {
    const walletPath = path.join(os.homedir(), ".noelclaw", "wallet.json");
    if (!fs.existsSync(walletPath)) return null;
    const data = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    const addr: string | undefined = data.address;
    if (!addr) return null;
    return addr.startsWith("0x") ? addr : `0x${addr}`;
  } catch {
    return null;
  }
}

async function loginWithOtp(rl: readline.Interface): Promise<void> {
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  const email = (await ask(`  Email: `)).trim();
  if (!email) return;

  process.stdout.write(`  Sending code to ${email}...`);
  const sendRes = await fetch(`${CONVEX_SITE}/auth/otp/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!sendRes.ok) {
    const e = await sendRes.json().catch(() => ({})) as any;
    console.log(`\n  ${C.red}✗${C.reset} ${(e as any).error ?? "Failed to send code"}\n`);
    return;
  }
  console.log(` ${C.green}✓${C.reset}`);

  const code = (await ask(`  6-digit code: `)).trim();

  process.stdout.write(`  Verifying...`);
  const verifyRes = await fetch(`${CONVEX_SITE}/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  const data = await verifyRes.json() as any;
  if (!verifyRes.ok || !data.token) {
    console.log(`\n  ${C.red}✗${C.reset} ${data.error ?? "Invalid code"}\n`);
    return;
  }

  // OTP response nests user info under data.user
  const resolvedEmail: string = data.user?.email ?? email;
  const name: string | undefined = data.user?.displayName ?? data.user?.firstName ?? undefined;
  writeConfig({ sessionToken: data.token, email: resolvedEmail, name });
  printLoginSuccess({ email: resolvedEmail, name });
}

async function loginWithApiKey(rl: readline.Interface): Promise<void> {
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  console.log(`  ${C.dim}Generate an API key at app.noelclaw.com → Settings → API Keys${C.reset}`);
  console.log(`  ${C.dim}Or set env var: set NOELCLAW_API_KEY=noel_sk_xxx${C.reset}`);
  let apiKey = (await ask(`  API key (noel_sk_...): `)).trim();
  if (!apiKey) return;

  // Deduplicate doubled input (Clink v1.7.6 bug: "22" → should be "2", "noel_sk_xxnoel_sk_xx" → "noel_sk_xx")
  // If the string is exactly doubled (first half === second half), take first half
  if (apiKey.length > 0 && apiKey.length % 2 === 0) {
    const half = apiKey.length / 2;
    if (apiKey.slice(0, half) === apiKey.slice(half)) {
      apiKey = apiKey.slice(0, half);
    }
  }

  // Strip any non-ASCII that Clink might inject
  apiKey = apiKey.replace(/[^\x20-\x7E]/g, "").trim();

  if (!apiKey.startsWith("noel_sk_")) {
    console.log(`\n  ${C.red}✗${C.reset} API key must start with "noel_sk_". Got: "${apiKey.slice(0, 20)}..."\n`);
    return;
  }

  process.stdout.write(`  Authenticating...`);
  const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await res.json() as any;
  if (!res.ok || !data.token) {
    console.log(`\n  ${C.red}✗${C.reset} ${data.error ?? "Invalid API key"}\n`);
    return;
  }

  const email: string = data.email ?? "api-key-user";
  const name: string | undefined = data.displayName ?? undefined;
  writeConfig({ sessionToken: data.token, email, name });
  printLoginSuccess({ email, name });
}

async function loginFlow(loginRl?: readline.Interface): Promise<void> {
  const rl = loginRl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  // Check env var first — skip prompt entirely
  const envKey = process.env.NOELCLAW_API_KEY;
  if (envKey && envKey.startsWith("noel_sk_")) {
    console.log(`\n  ${C.dim}Found NOELCLAW_API_KEY in environment — authenticating...${C.reset}`);
    process.stdout.write(`  Authenticating...`);
    const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: envKey }),
    });
    const data = await res.json() as any;
    if (res.ok && data.token) {
      const email: string = data.email ?? "api-key-user";
      const name: string | undefined = data.displayName ?? undefined;
      writeConfig({ sessionToken: data.token, email, name });
      printLoginSuccess({ email, name });
      rl.close();
      return;
    }
    console.log(`\n  ${C.red}✗${C.reset} Env var NOELCLAW_API_KEY is invalid. Falling back to manual login.\n`);
  }

  console.log(`\n  ${C.cyan}${C.bold}Sign in to Noelclaw${C.reset}\n`);
  console.log(`  ${C.dim}[1] Email (OTP code sent to your email)${C.reset}`);
  console.log(`  ${C.dim}[2] API key (from app.noelclaw.com → Settings)${C.reset}\n`);

  let choice = (await ask(`  Choose [1/2]: `)).trim();

  // Deduplicate doubled input (Clink bug: "22" → "2")
  if (choice.length === 2 && choice[0] === choice[1]) {
    choice = choice[0];
  }
  // Also handle longer doubled strings
  if (choice.length > 0 && choice.length % 2 === 0) {
    const half = choice.length / 2;
    if (choice.slice(0, half) === choice.slice(half)) {
      choice = choice.slice(0, half);
    }
  }

  if (choice === "2" || choice === "api" || choice === "apikey" || choice === "key") {
    await loginWithApiKey(rl);
  } else if (choice === "1" || choice === "email" || choice === "otp") {
    await loginWithOtp(rl);
  } else {
    console.log(`  ${C.red}Invalid choice. Please enter 1 or 2.${C.reset}\n`);
    rl.close();
    return;
  }

  rl.close();
}

// ── Setup wizard: BYOK LLM provider + local memory ────────────────────────────
// Deduplicates doubled input from a known Clink terminal bug - same helper
// used throughout loginFlow/loginWithApiKey above.
function dedupClinkInput(s: string): string {
  if (s.length > 0 && s.length % 2 === 0) {
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) return s.slice(0, half);
  }
  return s;
}

const PROVIDER_CHOICES: Record<string, { configKey: "bankrApiKey" | "anthropicApiKey" | "openaiApiKey"; envVar: string; label: string }> = {
  "1": { configKey: "bankrApiKey",     envVar: "BANKR_API_KEY",     label: "Bankr" },
  "2": { configKey: "anthropicApiKey", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  "3": { configKey: "openaiApiKey",    envVar: "OPENAI_API_KEY",    label: "OpenAI" },
};

const LOCAL_MEMORY_INSTALL_CMD = ["npx", ["-y", "supermemory", "local"]] as const;
const LOCAL_MEMORY_POLL_MS = 2000;
const LOCAL_MEMORY_POLL_MAX_MS = 45_000;
const LOCAL_MEMORY_KEY_RE = /\b(sm_[A-Za-z0-9_-]{8,})\b/;

async function setupFlow(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  console.log(`\n  ${C.cyan}${C.bold}noelclaw setup${C.reset}`);
  console.log(`  ${C.dim}Bring your own LLM key and/or run memory fully local - zero cost, zero lock-in.${C.reset}\n`);

  // ── Step 1: LLM provider ──────────────────────────────────────────────────
  console.log(`  ${C.dim}[1] Bankr   [2] Anthropic   [3] OpenAI   [4] Custom endpoint (self-hosted/VPS)   [5] Skip${C.reset}\n`);
  const providerChoice = dedupClinkInput((await ask(`  Choose [1-5]: `)).trim());
  const provider = PROVIDER_CHOICES[providerChoice];

  // Tracks whatever key got configured in this step, regardless of which
  // branch set it, so step 2 can forward it to the local-memory subprocess
  // env uniformly instead of only handling the named-provider case.
  let chosenProviderKey: string | undefined;
  let chosenProviderEnvVar: string | undefined;
  if (provider) {
    const key = dedupClinkInput((await ask(`  ${provider.label} API key: `)).trim()).replace(/[^\x20-\x7E]/g, "").trim();
    if (key) {
      writeConfig({ [provider.configKey]: key } as any);
      process.env[provider.envVar] = key;
      chosenProviderKey = key;
      chosenProviderEnvVar = provider.envVar;
      console.log(`\n  ${C.green}✓${C.reset} Saved. ${provider.label} will be used for LLM calls in the interactive shell and MCP server.`);
      console.log(`  ${C.dim}(Stored in ~/.noelclaw/config.json, mode 0600 - same protection as your session token.)${C.reset}\n`);
    } else {
      console.log(`\n  ${C.dim}No key entered - skipped.${C.reset}\n`);
    }
  } else if (providerChoice === "4") {
    console.log(`  ${C.dim}Any OpenAI Chat Completions-compatible endpoint works (LiteLLM, vLLM, Ollama, OpenRouter, your own VPS gateway).${C.reset}`);
    const baseUrl = dedupClinkInput((await ask(`  Base URL (e.g. https://your-vps:8000/v1): `)).trim()).replace(/[^\x20-\x7E]/g, "").trim().replace(/\/+$/, "");
    if (baseUrl) {
      const key = dedupClinkInput((await ask(`  API key (leave blank if your endpoint doesn't need one): `)).trim()).replace(/[^\x20-\x7E]/g, "").trim();
      writeConfig({ openaiBaseUrl: baseUrl, openaiApiKey: key || "local" });
      process.env.OPENAI_BASE_URL = baseUrl;
      process.env.OPENAI_API_KEY = key || "local";
      chosenProviderKey = key || "local";
      chosenProviderEnvVar = "OPENAI_API_KEY";
      console.log(`\n  ${C.green}✓${C.reset} Saved. Requests route to ${baseUrl} using the OpenAI protocol.\n`);
    } else {
      console.log(`\n  ${C.dim}No URL entered - skipped.${C.reset}\n`);
    }
  } else {
    console.log(`\n  ${C.dim}Skipped - using Noelclaw proxy.${C.reset}\n`);
  }

  // ── Step 2: local memory ──────────────────────────────────────────────────
  console.log(`  ${C.cyan}${C.bold}Local memory${C.reset}  ${C.dim}(self-hosted supermemory - github.com/supermemoryai/supermemory)${C.reset}`);
  console.log(`  ${C.dim}Runs on your machine, MIT licensed, free. Replaces the Noelclaw-hosted memory proxy.${C.reset}\n`);
  const enableLocal = dedupClinkInput((await ask(`  Enable local memory? [y/N]: `)).trim()).toLowerCase();

  if (enableLocal === "y" || enableLocal === "yes") {
    const url = "http://localhost:6767";
    console.log(`\n  ${C.dim}Checking ${url}...${C.reset}`);

    let reachable = await isLocalMemoryReachableRaw(url);
    let installerError: string | undefined;
    if (!reachable) {
      console.log(`  ${C.dim}Not running - launching \`npx -y supermemory local\` in the background...${C.reset}`);
      const providerEnv = chosenProviderEnvVar && chosenProviderKey ? { [chosenProviderEnvVar]: chosenProviderKey } : {};
      const result = await launchLocalMemoryServer(url, providerEnv);
      reachable = result.reachable;
      installerError = result.installerError;
    }

    if (reachable) {
      const key = await readLocalMemoryKey();
      if (key) {
        writeConfig({ memoryBackend: "local", supermemoryUrl: url, supermemoryApiKey: key });
        console.log(`\n  ${C.green}✓${C.reset} Local memory enabled at ${url}. Memory tools now run fully local - zero cost, private to this machine.\n`);
      } else {
        console.log(`\n  ${C.yellow}⚠${C.reset}  Server is running but its API key couldn't be auto-detected.`);
        const manualKey = dedupClinkInput((await ask(`  Paste the key printed by the server (starts with sm_), or press Enter to skip: `)).trim());
        if (manualKey) {
          writeConfig({ memoryBackend: "local", supermemoryUrl: url, supermemoryApiKey: manualKey });
          console.log(`\n  ${C.green}✓${C.reset} Local memory enabled at ${url}.\n`);
        } else {
          console.log(`\n  ${C.dim}Skipped - memory tools will keep using the Noelclaw proxy. Run \`noelclaw setup\` again once you have the key.${C.reset}\n`);
        }
      }
    } else if (installerError) {
      console.log(`\n  ${C.yellow}⚠${C.reset}  Local install failed: ${installerError}`);
      console.log(`  ${C.dim}Memory tools keep using the Noelclaw proxy until this is resolved. Run \`noelclaw setup\` again after fixing it.${C.reset}\n`);
    } else {
      console.log(`\n  ${C.yellow}⚠${C.reset}  Couldn't reach a local supermemory server after ${LOCAL_MEMORY_POLL_MAX_MS / 1000}s.`);
      console.log(`  ${C.dim}Install it yourself in another terminal: ${C.cyan}npx -y supermemory local${C.reset}`);
      console.log(`  ${C.dim}Then run \`noelclaw setup\` again - memory tools keep using the Noelclaw proxy until then.${C.reset}\n`);
    }
  } else {
    console.log(`\n  ${C.dim}Skipped - memory tools use the Noelclaw-hosted proxy.${C.reset}\n`);
  }

  rl.close();
}

async function isLocalMemoryReachableRaw(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

// Spawns the local supermemory server detached so it survives after this CLI
// process exits (same lifecycle model as a local daemon, e.g. Ollama).
// Captures stdout briefly to look for a printed sm_... key (the binary's
// first-boot wizard prints one), then stops watching it - the process itself
// keeps running in the background regardless of whether we caught the key.
let capturedLocalMemoryKey: string | undefined;

// Known installer failure signatures worth surfacing verbatim instead of a
// generic "couldn't reach" message. Confirmed on Windows: the installer
// shells out via WSL, and fails immediately (before ever listening on the
// port) if WSL isn't installed/registered - waiting out the full poll
// window for that case just wastes the user's time.
const KNOWN_INSTALLER_FAILURES: Array<{ re: RegExp; hint: string }> = [
  { re: /unsupported OS/i, hint: "The installer doesn't support this shell/OS directly (seen from Git Bash/MINGW on Windows)." },
  { re: /REGDB_E_CLASSNOTREG|Class not registered/i, hint: "The installer needs WSL (Windows Subsystem for Linux) to run its install script, and WSL isn't set up on this machine. Install it with `wsl --install` (needs a restart), then try again." },
];

interface LaunchResult { reachable: boolean; installerError?: string }

async function launchLocalMemoryServer(url: string, providerEnv: Record<string, string>): Promise<LaunchResult> {
  const [cmd, args] = LOCAL_MEMORY_INSTALL_CMD;
  let installerError: string | undefined;
  // Authoritative "did the process die" signal - independent of whether the
  // regex hints below happen to match. A spawn failure (e.g. npx not found)
  // emits an async 'error' event rather than throwing synchronously, so it
  // is NOT caught by the try/catch around spawn() itself; without this
  // listener it becomes an uncaught exception that crashes the whole CLI.
  let exited = false;
  // Accumulated across all chunks (not tested per-chunk) so a known error
  // string split across two writes still matches.
  let outputBuffer = "";

  try {
    const child = child_process.spawn(cmd, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...providerEnv },
    });
    child.on("error", (err) => {
      exited = true;
      if (!installerError) installerError = `Couldn't launch \`${cmd}\`: ${err.message}`;
    });
    child.on("exit", () => { exited = true; });
    const onData = (chunk: Buffer) => {
      outputBuffer += chunk.toString("utf8");
      const keyMatch = outputBuffer.match(LOCAL_MEMORY_KEY_RE);
      if (keyMatch) capturedLocalMemoryKey = keyMatch[1];
      if (!installerError) {
        const known = KNOWN_INSTALLER_FAILURES.find((k) => k.re.test(outputBuffer));
        if (known) installerError = known.hint;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.unref();
  } catch (err: any) {
    return { reachable: false, installerError: `Couldn't launch \`${cmd}\`: ${err.message}` };
  }

  const deadline = Date.now() + LOCAL_MEMORY_POLL_MAX_MS;
  while (Date.now() < deadline) {
    if (await isLocalMemoryReachableRaw(url)) return { reachable: true };
    // Fail fast once the process has died (confirmed via 'error'/'exit') or
    // a known error signature was recognized - polling further won't help.
    if (installerError || exited) return { reachable: false, installerError };
    await new Promise((r) => setTimeout(r, LOCAL_MEMORY_POLL_MS));
  }
  return { reachable: false, installerError };
}

async function readLocalMemoryKey(): Promise<string | undefined> {
  if (capturedLocalMemoryKey) return capturedLocalMemoryKey;
  // Fall back to the documented on-disk location ("everything lives in
  // ./.supermemory") - exact path may need adjusting once verified against
  // the real binary; this covers the most likely spot.
  try {
    const candidate = path.join(os.homedir(), ".supermemory", "config.json");
    if (fs.existsSync(candidate)) {
      const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const key = data?.apiKey ?? data?.api_key ?? data?.key;
      if (typeof key === "string" && LOCAL_MEMORY_KEY_RE.test(key)) return key;
    }
  } catch { /* best-effort only */ }
  return undefined;
}

// ── ANSI ─────────────────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  violet: "\x1b[35m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  white:  "\x1b[97m",
  bg:     "\x1b[48;5;17m",
};

// ── Banner ────────────────────────────────────────────────────────────────────
//
//   ███╗   ██╗ ██████╗ ███████╗██╗      ██████╗██╗      █████╗ ██╗    ██╗
//   ████╗  ██║██╔═══██╗██╔════╝██║     ██╔════╝██║     ██╔══██╗██║    ██║
//   ██╔██╗ ██║██║   ██║█████╗  ██║     ██║     ██║     ███████║██║ █╗ ██║
//   ██║╚██╗██║██║   ██║██╔══╝  ██║     ██║     ██║     ██╔══██║██║███╗██║
//   ██║ ╚████║╚██████╔╝███████╗███████╗╚██████╗███████╗██║  ██║╚███╔███╔╝
//   ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝

const LOGO_LINES = [
  `  ███╗   ██╗ ██████╗ ███████╗██╗      ██████╗██╗      █████╗ ██╗    ██╗`,
  `  ████╗  ██║██╔═══██╗██╔════╝██║     ██╔════╝██║     ██╔══██╗██║    ██║`,
  `  ██╔██╗ ██║██║   ██║█████╗  ██║     ██║     ██║     ███████║██║ █╗ ██║`,
  `  ██║╚██╗██║██║   ██║██╔══╝  ██║     ██║     ██║     ██╔══██║██║███╗██║`,
  `  ██║ ╚████║╚██████╔╝███████╗███████╗╚██████╗███████╗██║  ██║╚███╔███╔╝`,
  `  ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝`,
];

const SEP = `  ${"─".repeat(70)}`;

function buildBanner(): string {
  const cfg = readConfig();
  const walletAddr = getLocalWalletAddress();
  const provider = process.env.BANKR_API_KEY ? "Bankr"
    : process.env.ANTHROPIC_API_KEY ? "Anthropic"
    : process.env.OPENAI_API_KEY ? "OpenAI"
    : "Noelclaw proxy";

  const logo = LOGO_LINES.map(l => `${C.cyan}${C.bold}${l}${C.reset}`).join("\n");

  // ── meta row ──
  const meta = `\n${SEP}\n  ${C.dim}v${PKG_VERSION}  ·  ${TOTAL_TOOL_COUNT} tools  ·  noelclaw.com${C.reset}\n${SEP}`;

  // ── auth block ──
  let authBlock: string;
  if (cfg.sessionToken) {
    const displayName = cfg.name ? `${C.white}${C.bold}${cfg.name}${C.reset}` : "";
    const displayEmail = cfg.email ? `${C.dim}${cfg.email}${C.reset}` : "";
    const nameLine = displayName
      ? `  ${C.green}●${C.reset}  ${displayName}  ${displayEmail}`
      : `  ${C.green}●${C.reset}  ${displayEmail || `${C.green}Signed in${C.reset}`}`;
    const walletLine = walletAddr
      ? `     ${C.dim}Wallet${C.reset}  ${C.cyan}${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}${C.reset}  ${C.dim}· Base mainnet · keys never leave your machine${C.reset}`
      : `     ${C.dim}Wallet  not created yet · auto-creates on first DeFi call${C.reset}`;
    const llmLine = `     ${C.dim}LLM     ${C.reset}${C.green}${provider}${C.reset}  ${C.dim}· ${TOTAL_TOOL_COUNT} tools active${C.reset}`;
    authBlock = `\n${nameLine}\n${walletLine}\n${llmLine}`;
  } else {
    authBlock = [
      ``,
      `  ${C.yellow}○${C.reset}  ${C.yellow}Not signed in${C.reset}  ${C.dim}- tools that need your account will fail${C.reset}`,
      `     ${C.dim}Run ${C.reset}${C.cyan}/login${C.reset}${C.dim} to unlock all ${TOTAL_TOOL_COUNT} tools${C.reset}`,
      `     ${C.dim}LLM  ${provider}  · basic tools still work${C.reset}`,
    ].join("\n");
  }

  const hint = `\n${SEP}\n  ${C.dim}Type anything to chat · /help · Ctrl+C to exit${C.reset}\n`;

  return `\n${logo}\n${meta}\n${authBlock}\n${hint}`;
}

// ── Post-login success block ──────────────────────────────────────────────────
function printLoginSuccess({ email, name }: { email: string; name?: string }): void {
  const walletAddr = getLocalWalletAddress();
  const displayName = name ?? "";

  console.log(`\n${SEP}`);
  if (displayName) {
    console.log(`  ${C.green}✓${C.reset}  ${C.white}${C.bold}${displayName}${C.reset}  ${C.dim}${email}${C.reset}`);
  } else {
    console.log(`  ${C.green}✓${C.reset}  ${C.green}${C.bold}Signed in${C.reset}  ${C.dim}as ${email}${C.reset}`);
  }
  if (walletAddr) {
    console.log(`     ${C.dim}Wallet${C.reset}  ${C.cyan}${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}${C.reset}  ${C.dim}· Base mainnet${C.reset}`);
  } else {
    console.log(`     ${C.dim}Wallet  auto-creates on first DeFi tool call${C.reset}`);
  }
  console.log(`     ${C.dim}Token saved to ~/.noelclaw/config.json${C.reset}`);
  console.log(`     ${C.dim}All ${TOTAL_TOOL_COUNT} tools unlocked${C.reset}`);
  console.log(`${SEP}\n`);
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function spinner(label: string): () => void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(`\r  ${C.dim}${frames[i % frames.length]} ${label}${C.reset}  `);
    i++;
  }, 80);
  return () => {
    clearInterval(iv);
    process.stdout.write("\r" + " ".repeat(label.length + 12) + "\r");
  };
}

// ── Help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  const cfg = readConfig();
  const authLine = cfg.email
    ? `  ${C.dim}Signed in as ${C.reset}${C.green}${cfg.email}${C.reset}`
    : `  ${C.yellow}⚠${C.reset}  ${C.dim}Not signed in - run /login to unlock all tools${C.reset}`;

  console.log(`
  ${C.cyan}Commands:${C.reset}
    /login     Sign in to unlock all ${TOTAL_TOOL_COUNT} tools
    /logout    Sign out and clear saved token
    /clear     Clear conversation history
    /tools     List all available tools
    /quit      Exit

${authLine}

  ${C.dim}Examples:
    remember that I prefer concise answers
    search the web for recent AI news
    save a note to my vault
    research "top AI agent frameworks in 2025"
    spawn an agent to monitor competitor releases weekly${C.reset}
`);
}

// ── Version check ─────────────────────────────────────────────────────────────
async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch("https://registry.npmjs.org/@noelclaw/mcp/latest", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return;
    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === PKG_VERSION) return;
    const sep = `  ${"─".repeat(58)}`;
    console.log(`\n${sep}`);
    console.log(`  ${C.yellow}⚠${C.reset}  Update available: ${C.yellow}v${PKG_VERSION}${C.reset} → ${C.cyan}v${latest}${C.reset}`);
    console.log(`     ${C.dim}npm install -g @noelclaw/mcp@${latest}${C.reset}  ${C.dim}or restart your MCP client${C.reset}`);
    console.log(`${sep}\n`);
  } catch {
    // silently ignore
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Auto-login from env var if set and not already logged in
  const cfg = readConfig();
  const envKey = process.env.NOELCLAW_API_KEY;
  if (!cfg.sessionToken && envKey && envKey.startsWith("noel_sk_")) {
    process.stdout.write(`  ${C.dim}Auto-login from NOELCLAW_API_KEY...${C.reset} `);
    try {
      const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: envKey }),
      });
      const data = await res.json() as any;
      if (res.ok && data.token) {
        writeConfig({ sessionToken: data.token, email: data.email ?? "api-key-user", name: data.displayName ?? undefined });
        console.log(`${C.green}✓${C.reset} ${C.dim}Signed in as ${data.email}${C.reset}`);
      } else {
        console.log(`${C.red}✗${C.reset} ${C.dim}Invalid API key in env var${C.reset}`);
      }
    } catch (e) {
      console.log(`${C.red}✗${C.reset} ${C.dim}Login failed: ${(e as Error).message}${C.reset}`);
    }
  }

  process.stdout.write(buildBanner());

  // Check for updates in background - shows after banner, doesn't block prompt
  checkForUpdate().catch(() => {});

  const history: ChatMessage[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}>${C.reset} `,
  });

  rl.prompt();

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }

    // Built-in commands
    if (line === "/quit" || line === "/exit") {
      console.log(`\n  ${C.dim}Goodbye.${C.reset}\n`);
      process.exit(0);
    }

    if (line === "/clear") {
      history.length = 0;
      console.log(`  ${C.dim}History cleared.${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (line === "/help") {
      printHelp();
      rl.prompt();
      return;
    }

    if (line === "/login") {
      rl.pause();
      // Create fresh readline for login — reusing rl causes input conflicts
      const loginRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await loginFlow(loginRl);
      loginRl.close();
      rl.resume();
      rl.prompt();
      return;
    }

    if (line === "/logout") {
      writeConfig({ sessionToken: undefined, email: undefined });
      console.log(`  ${C.dim}Logged out. Token cleared from ~/.noelclaw/config.json${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (line === "/tools") {
      console.log(`\n  ${C.cyan}${ALL_TOOLS.length} tools:${C.reset}`);
      for (const t of ALL_TOOLS) {
        console.log(`  ${C.dim}·${C.reset} ${t.name}  ${C.dim}${(t.description as string ?? "").slice(0, 60)}${C.reset}`);
      }
      console.log();
      rl.prompt();
      return;
    }

    // Agent call
    const stop = spinner("thinking");
    let toolsUsed = 0;

    try {
      const result = await runAgent(line, history, (toolName) => {
        stop();
        toolsUsed++;
        process.stdout.write(`  ${C.dim}✦ ${toolName}${C.reset}\n`);
      });

      stop();

      // Update conversation history (keep last 20 turns)
      history.push({ role: "user", content: line });
      history.push({ role: "assistant", content: result.text });
      while (history.length > 20) history.splice(0, 2);

      // Output
      console.log();
      const lines = result.text.split("\n");
      for (const l of lines) {
        console.log(`  ${l}`);
      }
      console.log();
    } catch (err: any) {
      stop();
      console.log(`\n  ${C.red}✗${C.reset} ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n  ${C.dim}Goodbye.${C.reset}\n`);
    process.exit(0);
  });
}

// ── Install command ───────────────────────────────────────────────────────────
interface McpClient {
  name: string;
  configPath: string;
  // Which JSON key holds the servers map
  serversKey: "mcpServers";
}

function resolveClients(): McpClient[] {
  const home    = os.homedir();
  const plat    = os.platform();
  const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");

  const defs: { name: string; paths: Record<string, string> }[] = [
    {
      name: "Claude Desktop",
      paths: {
        darwin: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        win32:  path.join(appdata, "Claude", "claude_desktop_config.json"),
        linux:  path.join(home, ".config", "Claude", "claude_desktop_config.json"),
      },
    },
    {
      name: "Cursor",
      paths: {
        darwin: path.join(home, ".cursor", "mcp.json"),
        win32:  path.join(home, ".cursor", "mcp.json"),
        linux:  path.join(home, ".cursor", "mcp.json"),
      },
    },
    {
      name: "Windsurf",
      paths: {
        darwin: path.join(home, ".windsurf", "mcp.json"),
        win32:  path.join(home, ".windsurf", "mcp.json"),
        linux:  path.join(home, ".windsurf", "mcp.json"),
      },
    },
    {
      name: "VS Code",
      paths: {
        darwin: path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
        win32:  path.join(appdata, "Code", "User", "mcp.json"),
        linux:  path.join(home, ".config", "Code", "User", "mcp.json"),
      },
    },
    {
      name: "VS Code Insiders",
      paths: {
        darwin: path.join(home, "Library", "Application Support", "Code - Insiders", "User", "mcp.json"),
        win32:  path.join(appdata, "Code - Insiders", "User", "mcp.json"),
        linux:  path.join(home, ".config", "Code - Insiders", "User", "mcp.json"),
      },
    },
    {
      name: "Zed",
      paths: {
        darwin: path.join(home, ".config", "zed", "mcp.json"),
        win32:  path.join(home, ".config", "zed", "mcp.json"),
        linux:  path.join(home, ".config", "zed", "mcp.json"),
      },
    },
  ];

  return defs
    .map((d) => {
      const configPath = d.paths[plat] ?? d.paths.linux;
      return { name: d.name, configPath, serversKey: "mcpServers" as const };
    })
    .filter((c) => {
      // Include if the config file exists OR the parent directory exists (app installed but not yet configured)
      return fs.existsSync(c.configPath) || fs.existsSync(path.dirname(c.configPath));
    });
}

// `npx -y @noelclaw/mcp@version` alone fails with "could not determine
// executable to run" - the package ships two bins (noelclaw, noelclaw-mcp)
// and neither matches the unscoped package name npx resolves by default.
// -p ... noelclaw-mcp names the actual MCP-protocol server explicitly
// (not `noelclaw`, which is the human-interactive REPL and would break the
// JSON-RPC handshake if a host spawned it instead). Pinned to the currently
// installed version, never @latest - matches the security boundary
// documented in the README (wallet/credential access needs a stable,
// reviewable version, not a moving target).
const NOELCLAW_ENTRY = {
  command: "npx",
  args: ["-y", "-p", `@noelclaw/mcp@${PKG_VERSION}`, "noelclaw-mcp"],
  env: {} as Record<string, string>,
};

function installIntoConfig(configPath: string): "added" | "updated" | "error" {
  try {
    let json: any = {};

    if (fs.existsSync(configPath)) {
      try { json = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { json = {}; }
    } else {
      // Ensure parent dir exists
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }

    if (!json.mcpServers) json.mcpServers = {};
    const existed = !!json.mcpServers.noelclaw;
    json.mcpServers.noelclaw = NOELCLAW_ENTRY;

    fs.writeFileSync(configPath, JSON.stringify(json, null, 2), "utf8");
    return existed ? "updated" : "added";
  } catch {
    return "error";
  }
}

async function installFlow(): Promise<void> {
  console.log(`\n  ${C.cyan}${C.bold}noelclaw install${C.reset}\n`);
  console.log(`  ${C.dim}Scanning for MCP-compatible apps...${C.reset}\n`);

  const clients = resolveClients();

  if (clients.length === 0) {
    console.log(`  ${C.yellow}No MCP-compatible apps found.${C.reset}`);
    console.log(`  ${C.dim}Install Claude Desktop, Cursor, or Windsurf, then run this again.${C.reset}\n`);
    console.log(`  ${C.dim}Or add manually to your app's MCP config:${C.reset}`);
    console.log(`  ${C.dim}  "noelclaw": { "command": "npx", "args": ["-y", "@noelclaw/mcp"] }${C.reset}\n`);
    return;
  }

  let installed = 0;
  const toRestart: string[] = [];

  for (const client of clients) {
    const result = installIntoConfig(client.configPath);
    const short  = client.configPath.replace(os.homedir(), "~");

    if (result === "added") {
      console.log(`  ${C.green}✓${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ added${C.reset}`);
      console.log(`     ${C.dim}${short}${C.reset}`);
      installed++;
      toRestart.push(client.name);
    } else if (result === "updated") {
      console.log(`  ${C.green}↑${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ updated to latest${C.reset}`);
      console.log(`     ${C.dim}${short}${C.reset}`);
      installed++;
      toRestart.push(client.name);
    } else {
      console.log(`  ${C.yellow}✗${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ write failed (check permissions)${C.reset}`);
    }
  }

  console.log(`\n  ${C.dim}${"─".repeat(52)}${C.reset}\n`);

  if (installed === 0) {
    console.log(`  ${C.yellow}Nothing was installed. Check file permissions.${C.reset}\n`);
    return;
  }

  console.log(`  ${C.green}${C.bold}✓ Noelclaw installed in ${installed} app${installed === 1 ? "" : "s"}.${C.reset}\n`);

  if (toRestart.length > 0) {
    console.log(`  ${C.dim}Restart to activate:  ${toRestart.join("  ·  ")}${C.reset}`);
  }

  const cfg = readConfig();
  if (!cfg.sessionToken) {
    console.log(`\n  ${C.dim}Next step - sign in to unlock all tools:${C.reset}`);
    console.log(`  ${C.cyan}  noelclaw login${C.reset}\n`);
  } else {
    console.log(`\n  ${C.dim}Already signed in as ${cfg.email ?? "user"}.${C.reset}`);
    console.log(`  ${C.dim}Open your MCP client and start using Noelclaw.${C.reset}\n`);
  }
}

// ── doctor - comprehensive health check ──────────────────────────────────────
// Detects broken installs and missing config in <5s. Output is concise,
// scannable, and tells the user exactly what to fix next. Designed to be
// the first command a new user runs after install.

type DoctorCheck = { name: string; status: "✓" | "✗" | "⚠"; detail: string; fix?: string };

async function doctorFlow(): Promise<void> {
  console.log(`\n  ${C.cyan}${C.bold}noelclaw doctor${C.reset}  ${C.dim}v${PKG_VERSION}${C.reset}\n`);
  console.log(`  ${C.dim}Running diagnostic - this takes ~5 seconds.${C.reset}\n`);

  const checks: DoctorCheck[] = [];
  const cfg = readConfig();
  const authHeader = cfg.sessionToken ? { Authorization: `Bearer ${cfg.sessionToken}` } : {};

  // 1. LLM provider
  const provider = process.env.BANKR_API_KEY ? "bankr"
    : process.env.ANTHROPIC_API_KEY ? "anthropic"
    : process.env.OPENAI_API_KEY ? "openai"
    : "noelclaw-proxy";
  checks.push({
    name: "LLM provider",
    status: "✓",
    detail: provider === "noelclaw-proxy"
      ? `noelclaw proxy (no own key set) · all ${TOTAL_TOOL_COUNT} tools usable`
      : `${provider} (direct, full tool use unlocked)`,
    fix: provider === "noelclaw-proxy"
      ? `Set BANKR_API_KEY for faster + cheaper LLM calls`
      : undefined,
  });

  // 2. Backend reachable
  try {
    const t0 = Date.now();
    const res = await fetch(`${CONVEX_SITE}/memory/profile`, {
      headers: authHeader as any,
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - t0;
    if (res.status === 401) {
      checks.push({
        name: "Backend reachable", status: "⚠",
        detail: `${CONVEX_SITE} → 401 (not signed in)`,
        fix: `Run \`noelclaw login\` to authenticate.`,
      });
    } else if (res.ok) {
      checks.push({
        name: "Backend reachable", status: "✓",
        detail: `${CONVEX_SITE} → ${res.status} (${latency}ms)`,
      });
    } else {
      checks.push({
        name: "Backend reachable", status: "✗",
        detail: `${CONVEX_SITE} → ${res.status}`,
        fix: `Check NOELCLAW_CONVEX_URL env var, or wait if the service is down.`,
      });
    }
  } catch (err: any) {
    checks.push({
      name: "Backend reachable", status: "✗",
      detail: `${CONVEX_SITE} → ${err.message}`,
      fix: `Network issue or wrong URL. Default: https://befitting-porcupine-276.convex.site`,
    });
  }

  // 3. Auth state
  if (cfg.sessionToken) {
    checks.push({
      name: "Authentication",
      status: "✓",
      detail: cfg.email
        ? `Signed in as ${cfg.email}`
        : `Session token present`,
    });
  } else {
    checks.push({
      name: "Authentication",
      status: "⚠",
      detail: `No session token - running with local wallet signature only`,
      fix: `Run \`noelclaw login\` for persistent identity across MCP clients.`,
    });
  }

  // 4. Local wallet
  const walletPath = path.join(os.homedir(), ".noelclaw", "wallet.json");
  if (fs.existsSync(walletPath)) {
    try {
      const wallet = JSON.parse(fs.readFileSync(walletPath, "utf8"));
      const addr = wallet.address ? (wallet.address.startsWith("0x") ? wallet.address : `0x${wallet.address}`) : "unknown";
      checks.push({
        name: "Local wallet", status: "✓",
        detail: `${addr.slice(0, 6)}...${addr.slice(-4)} at ~/.noelclaw/wallet.json`,
      });
    } catch {
      checks.push({
        name: "Local wallet", status: "⚠",
        detail: `wallet.json present but unreadable`,
        fix: `Delete ~/.noelclaw/wallet.json and re-run noelclaw - new wallet auto-creates.`,
      });
    }
  } else {
    checks.push({
      name: "Local wallet", status: "⚠",
      detail: `Not created yet`,
      fix: `Auto-creates on first DeFi tool call (base_mcp_balance, etc).`,
    });
  }

  // 5. Profile entries
  if (cfg.sessionToken) {
    try {
      const res = await fetch(`${CONVEX_SITE}/vault/profile-context?maxChars=100`, {
        headers: authHeader as any,
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json() as any;
      if (data?.hasProfile) {
        checks.push({
          name: "Profile context", status: "✓",
          detail: `Profile entries found - Claude auto-loads your context across sessions`,
        });
      } else {
        checks.push({
          name: "Profile context", status: "⚠",
          detail: `No profile entries yet`,
          fix: `Run: vault_save type=memory key=profile/business content="<who you are, what you build>"`,
        });
      }
    } catch {
      checks.push({
        name: "Profile context", status: "⚠",
        detail: `Could not fetch (backend issue)`,
      });
    }
  }

  // 6. Tool palette mode
  const toolMode = process.env.NOELCLAW_TOOLS ?? "core";
  checks.push({
    name: "Tool palette",
    status: "✓",
    detail: `Mode: ${toolMode}${toolMode === "core" ? ` (default - ${CORE_TOOL_COUNT} essential tools)` : toolMode === "all" ? ` (power user - ${TOTAL_TOOL_COUNT} tools)` : ` (custom subset)`}`,
    fix: toolMode === "core"
      ? `Set NOELCLAW_TOOLS=all to expose all ${TOTAL_TOOL_COUNT} tools (raises LLM context cost).`
      : undefined,
  });

  // 7. MEV-protect broadcast (optional belt-and-suspenders for swaps)
  if (process.env.NOELCLAW_BROADCAST_RPC) {
    const host = (() => {
      try { return new URL(process.env.NOELCLAW_BROADCAST_RPC!).host; } catch { return "custom"; }
    })();
    checks.push({
      name: "MEV-protect", status: "✓",
      detail: `Broadcasts routed through ${host} (private/MEV-protected)`,
    });
  } else {
    checks.push({
      name: "MEV-protect", status: "⚠",
      detail: `Standard Base RPC (sequencer is centralized, MEV is naturally low)`,
      fix: `Optional: set NOELCLAW_BROADCAST_RPC=<private-relay-url> for belt-and-suspenders routing.`,
    });
  }

  // 8. GITHUB_TOKEN (optional but affects github_search_code)
  if (process.env.GITHUB_TOKEN) {
    checks.push({
      name: "GitHub token", status: "✓",
      detail: `GITHUB_TOKEN set - github_search_code + private repos work`,
    });
  } else {
    checks.push({
      name: "GitHub token", status: "⚠",
      detail: `No GITHUB_TOKEN - github_search_code disabled, other tools rate-limited to 60/hr`,
      fix: `Optional. Create at https://github.com/settings/tokens (scopes: public_repo) and add to MCP env.`,
    });
  }

  // 9. Local memory (self-hosted supermemory) - optional, zero-cost alternative
  // to the Convex-proxied cloud memory backend.
  const localMemCfg = getLocalMemoryConfig();
  if (localMemCfg) {
    const reachable = await isLocalMemoryReachable(localMemCfg);
    checks.push(reachable ? {
      name: "Local memory", status: "✓",
      detail: `supermemory reachable at ${localMemCfg.url} - memory tools run fully local, zero cost`,
    } : {
      name: "Local memory", status: "⚠",
      detail: `memoryBackend is "local" but ${localMemCfg.url} isn't reachable`,
      fix: `Start the local server (see \`npx supermemory local\`), or run \`noelclaw setup\` again.`,
    });
  } else {
    checks.push({
      name: "Local memory", status: "⚠",
      detail: `Not configured - memory tools use the Noelclaw-hosted proxy`,
      fix: `Run \`noelclaw setup\` to switch to a free, self-hosted local memory backend.`,
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const colorFor = (s: DoctorCheck["status"]) => s === "✓" ? C.green : s === "⚠" ? C.yellow : C.red;
  const widest = Math.max(...checks.map((c) => c.name.length));

  for (const c of checks) {
    const pad = c.name.padEnd(widest);
    console.log(`  ${colorFor(c.status)}${c.status}${C.reset}  ${C.cyan}${pad}${C.reset}  ${c.detail}`);
    if (c.fix) console.log(`     ${" ".repeat(widest)}  ${C.dim}→ ${c.fix}${C.reset}`);
  }

  const counts = { "✓": 0, "⚠": 0, "✗": 0 };
  checks.forEach((c) => counts[c.status]++);
  console.log("");
  console.log(`  ${C.dim}Summary:${C.reset} ${C.green}${counts["✓"]} ok${C.reset} · ${C.yellow}${counts["⚠"]} warning${C.reset} · ${C.red}${counts["✗"]} critical${C.reset}`);
  console.log("");

  if (counts["✗"] > 0) {
    console.log(`  ${C.red}Critical issues found - fix the lines above before relying on noelclaw.${C.reset}\n`);
    process.exit(1);
  } else if (counts["⚠"] > 0) {
    console.log(`  ${C.dim}Warnings are non-blocking - noelclaw works but could be smoother.${C.reset}\n`);
  } else {
    console.log(`  ${C.green}All systems healthy.${C.reset}\n`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
const cmd = process.argv[2];

if (cmd === "install") {
  installFlow().catch((err) => {
    console.error(`  ${C.red}✗ install error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "login") {
    const envKey = process.env.NOELCLAW_API_KEY;
    if (envKey && envKey.startsWith("noel_sk_")) {
        console.log(`  ${C.dim}Found NOELCLAW_API_KEY in environment${C.reset}`);
        process.stdout.write(`  Authenticating...`);
        fetch(`${CONVEX_SITE}/auth/apikey/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey: envKey }),
        })
            .then(res => res.json())
            .then((data: any) => {
                if (data.token) {
                    const email = data.email ?? "api-key-user";
                    const name = data.displayName ?? undefined;
                    writeConfig({ sessionToken: data.token, email, name });
                    printLoginSuccess({ email, name });
                    process.exit(0);
                }
                console.log(`\n  ${C.red}✗${C.reset} ${data.error ?? "Invalid API key"}\n`);
                process.exit(1);
            })
            .catch((err) => {
                console.log(`\n  ${C.red}✗${C.reset} Login failed: ${err.message}\n`);
                process.exit(1);
            });
    }
    else {
        loginFlow().catch((err) => {
            console.error(`  ${C.red}✗ login error: ${err.message}${C.reset}`);
            process.exit(1);
        });
    }
}else if (cmd === "doctor") {
  doctorFlow().catch((err) => {
    console.error(`  ${C.red}✗ doctor error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "setup") {
  setupFlow().catch((err) => {
    console.error(`  ${C.red}✗ setup error: ${err.message}${C.reset}`);
    process.exit(1);
  });
} else if (cmd === "logout") {
  const cfg = readConfig();
  if (!cfg.sessionToken) {
    console.log(`\n  ${C.dim}Already signed out.${C.reset}\n`);
  } else {
    writeConfig({ sessionToken: undefined, email: undefined });
    console.log(`\n  ${C.green}✓${C.reset} Signed out${cfg.email ? ` (${cfg.email})` : ""}. Token cleared from ~/.noelclaw/config.json\n`);
  }
} else if (cmd === "status") {
  const cfg = readConfig();
  const walletAddr = getLocalWalletAddress();
  const provider = process.env.BANKR_API_KEY ? "Bankr"
    : process.env.ANTHROPIC_API_KEY ? "Anthropic"
    : process.env.OPENAI_API_KEY ? "OpenAI"
    : "Noelclaw proxy";
  const SEP_S = `  ${"─".repeat(52)}`;
  console.log(`\n${SEP_S}`);
  if (cfg.sessionToken) {
    const displayName = cfg.name ? `${C.white}${C.bold}${cfg.name}${C.reset}  ` : "";
    const displayEmail = cfg.email ? `${C.dim}${cfg.email}${C.reset}` : "";
    console.log(`  ${C.green}●${C.reset}  ${displayName}${displayEmail}`);
    if (walletAddr) {
      console.log(`     ${C.dim}Wallet  ${C.reset}${C.cyan}${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}${C.reset}  ${C.dim}· Base mainnet${C.reset}`);
    } else {
      console.log(`     ${C.dim}Wallet  not created yet${C.reset}`);
    }
    console.log(`     ${C.dim}LLM     ${C.reset}${C.green}${provider}${C.reset}  ${C.dim}· ${TOTAL_TOOL_COUNT} tools · v${PKG_VERSION}${C.reset}`);
  } else {
    console.log(`  ${C.yellow}○${C.reset}  ${C.yellow}Not signed in${C.reset}`);
    console.log(`     ${C.dim}→ run \`noelclaw login\` to unlock all ${TOTAL_TOOL_COUNT} tools${C.reset}`);
    console.log(`     ${C.dim}LLM  ${provider}  · v${PKG_VERSION}${C.reset}`);
  }
  console.log(`${SEP_S}\n`);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`
  ${C.cyan}${C.bold}noelclaw${C.reset}  ${C.dim}runtime layer for Agentic AI · terminal CLI${C.reset}

  ${C.cyan}Commands:${C.reset}
    noelclaw              Start interactive AI terminal
    noelclaw install      Auto-configure all detected MCP clients
    noelclaw login        Sign in to unlock all tools
    noelclaw logout       Sign out and clear saved token
    noelclaw status       Show auth state and version (quick check)
    noelclaw doctor       Run a full health check + suggest fixes
    noelclaw setup        Configure your own LLM key and/or local memory
    noelclaw help         Show this help

  ${C.dim}Claude Code / Cursor / Windsurf / Codex / Aeon / Antigravity / Zed — anywhere MCP runs.${C.reset}
`);
} else {
  main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
