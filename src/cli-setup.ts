// `finch setup` - BYOK LLM provider + local memory/vault configuration wizard.

import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as child_process from "child_process";
import { writeConfig } from "./config.js";
import { dedupClinkInput } from "./clink-input.js";
import { C } from "./cli-ui.js";

const PROVIDER_CHOICES: Record<string, { configKey: "bankrApiKey" | "anthropicApiKey" | "openaiApiKey"; envVar: string; label: string }> = {
  "1": { configKey: "bankrApiKey",     envVar: "BANKR_API_KEY",     label: "Bankr" },
  "2": { configKey: "anthropicApiKey", envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  "3": { configKey: "openaiApiKey",    envVar: "OPENAI_API_KEY",    label: "OpenAI" },
};

const LOCAL_MEMORY_INSTALL_CMD = ["npx", ["-y", "supermemory", "local"]] as const;
const LOCAL_MEMORY_POLL_MS = 2000;
const LOCAL_MEMORY_POLL_MAX_MS = 45_000;
const LOCAL_MEMORY_KEY_RE = /\b(sm_[A-Za-z0-9_-]{8,})\b/;

export async function setupFlow(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  console.log(`\n  ${C.cyan}${C.bold}finch setup${C.reset}`);
  console.log(`  ${C.dim}Bring your own LLM key and/or run memory fully local - zero cost, zero lock-in.${C.reset}\n`);

  // ── Step 1: LLM provider ──────────────────────────────────────────────────
  // Say plainly that skipping is fine. Tools return data and structure for the
  // calling model; only `finch run` and scheduled agents need a key of
  // their own, because nothing else is there to do the thinking.
  console.log(`  ${C.dim}Optional. Every MCP tool works without a key - your client's model does the reasoning.${C.reset}`);
  console.log(`  ${C.dim}A key is what lets finch think on its own: \`finch run\` and scheduled agents.${C.reset}\n`);
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
      console.log(`  ${C.dim}(Stored in ~/.finch/config.json, mode 0600 - same protection as your session token.)${C.reset}\n`);
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
    console.log(`\n  ${C.dim}Skipped - using Finch proxy.${C.reset}\n`);
  }

  // ── Step 2: local memory ──────────────────────────────────────────────────
  console.log(`  ${C.cyan}${C.bold}Local memory${C.reset}  ${C.dim}(self-hosted - your choice of backend)${C.reset}`);
  console.log(`  ${C.dim}[1] Simple file-based (recommended) - zero dependency, JSON on disk at ~/.finch/memory/, keyword search only.${C.reset}`);
  console.log(`  ${C.dim}[2] Supermemory server - real semantic/embedding search, but you run a separate process yourself.${C.reset}`);
  console.log(`  ${C.dim}[3] Skip - memory tools use the Finch-hosted proxy.${C.reset}\n`);
  const memChoice = dedupClinkInput((await ask(`  Choose [1-3]: `)).trim());

  if (memChoice === "1") {
    writeConfig({ memoryBackend: "local-file" });
    console.log(`\n  ${C.green}✓${C.reset} Local file memory enabled at ~/.finch/memory/. No server, no key - memory tools run fully local.\n`);
  } else if (memChoice === "2") {
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
          console.log(`\n  ${C.dim}Skipped - memory tools will keep using the Finch proxy. Run \`finch setup\` again once you have the key.${C.reset}\n`);
        }
      }
    } else if (installerError) {
      console.log(`\n  ${C.yellow}⚠${C.reset}  Local install failed: ${installerError}`);
      console.log(`  ${C.dim}Memory tools keep using the Finch proxy until this is resolved. Run \`finch setup\` again after fixing it.${C.reset}\n`);
    } else {
      console.log(`\n  ${C.yellow}⚠${C.reset}  Couldn't reach a local supermemory server after ${LOCAL_MEMORY_POLL_MAX_MS / 1000}s.`);
      console.log(`  ${C.dim}Install it yourself in another terminal: ${C.cyan}npx -y supermemory local${C.reset}`);
      console.log(`  ${C.dim}Then run \`finch setup\` again - memory tools keep using the Finch proxy until then.${C.reset}\n`);
    }
  } else {
    console.log(`\n  ${C.dim}Skipped - memory tools use the Finch-hosted proxy.${C.reset}\n`);
  }

  // ── Step 3: local vault ───────────────────────────────────────────────────
  // Unlike local memory, this needs no server - it's a plain on-disk store, so
  // enabling it is a config flip. Data lives under ~/.finch/vault/.
  console.log(`  ${C.cyan}${C.bold}Local vault${C.reset}  ${C.dim}(versioned artifacts on your own disk - ~/.finch/vault/)${C.reset}`);
  console.log(`  ${C.dim}No account, no Convex, no cost. vault_save/read/search/history/diff run fully local.${C.reset}\n`);
  const enableVault = dedupClinkInput((await ask(`  Enable local vault? [y/N]: `)).trim()).toLowerCase();
  if (enableVault === "y" || enableVault === "yes") {
    writeConfig({ vaultBackend: "local" });
    console.log(`\n  ${C.green}✓${C.reset} Local vault enabled. All vault tools now store on this machine - you own the data, no account needed.\n`);
  } else {
    console.log(`\n  ${C.dim}Skipped - vault tools use the Finch-hosted store (needs \`finch login\`).${C.reset}\n`);
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
