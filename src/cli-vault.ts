// `finch vault` - inspect the local, user-owned vault.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readConfig } from "./config.js";
import { C } from "./cli-ui.js";

export function vaultFlow(): void {
  const cfg = readConfig();
  const dir = path.join(os.homedir(), ".finch", "vault");
  const shortDir = dir.replace(os.homedir(), "~");
  const SEP_V = `  ${"─".repeat(52)}`;

  console.log(`\n  ${C.cyan}${C.bold}finch vault${C.reset}\n`);

  if (cfg.vaultBackend !== "local") {
    console.log(`  ${C.yellow}○${C.reset}  Local vault is ${C.yellow}off${C.reset} - vault tools use the hosted store (needs \`finch login\`).`);
    console.log(`     ${C.dim}Turn it on:${C.reset} ${C.cyan}finch setup${C.reset} ${C.dim}(answer "y" to local vault) - then your data lives here, on your machine.${C.reset}\n`);
    return;
  }

  let entries = 0, versions = 0, creds = 0;
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    const e = idx.entries ?? {};
    entries = Object.keys(e).length;
    versions = Object.values(e).reduce((n: number, x: any) => n + (x?.versions?.length ?? 0), 0);
  } catch { /* no index yet */ }
  try { creds = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8"))).length; } catch { /* none */ }

  console.log(`  ${C.green}●${C.reset}  Local vault is ${C.green}on${C.reset} - your data, on your machine, no account.`);
  console.log(`${SEP_V}`);
  console.log(`     ${C.dim}Location   ${C.reset}${shortDir}`);
  console.log(`     ${C.dim}Contents   ${C.reset}${entries} entr${entries === 1 ? "y" : "ies"} ${C.dim}·${C.reset} ${versions} version${versions === 1 ? "" : "s"} ${C.dim}·${C.reset} ${creds} credential${creds === 1 ? "" : "s"} ${C.dim}(encrypted)${C.reset}`);
  console.log(`${SEP_V}`);
  console.log(`  ${C.dim}It's a plain folder - back it up or sync it however you like:${C.reset}`);
  console.log(`     ${C.cyan}cp -r ${shortDir} ~/backup${C.reset}   ${C.dim}# copy${C.reset}`);
  console.log(`     ${C.cyan}git -C ${shortDir} init${C.reset}      ${C.dim}# version-control it${C.reset}`);
  console.log(`  ${C.dim}Nothing leaves this machine unless you move it.${C.reset}\n`);
}
