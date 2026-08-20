// Bootstrap state shared across every cli-*.ts module: env hydration (must
// run before anything else reads process.env), tool counts, backend URL,
// package version, and the local wallet address reader.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ALL_TOOLS } from "./server.js";
import { filterTools } from "./tool-filter.js";
import { hydrateEnvFromConfig } from "./config.js";

hydrateEnvFromConfig();

// Derived tool counts - single source of truth, kept in sync with the
// actual registered tools. Updates here propagate to banner, login,
// and doctor without manual edits.
export const TOTAL_TOOL_COUNT = ALL_TOOLS.length;
export const CORE_TOOL_COUNT = (() => {
  const prev = process.env.FINCH_TOOLS;
  try {
    process.env.FINCH_TOOLS = "core";
    return filterTools(ALL_TOOLS).length;
  } finally {
    if (prev === undefined) delete process.env.FINCH_TOOLS;
    else process.env.FINCH_TOOLS = prev;
  }
})();

export const CONVEX_SITE = process.env.FINCH_CONVEX_URL ?? "https://befitting-porcupine-276.convex.site";

export const PKG_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// Read wallet address from the encrypted JSON without decrypting -
// ethers stores the address in plaintext inside the keystore file.
export function getLocalWalletAddress(): string | null {
  try {
    const walletPath = path.join(os.homedir(), ".finch", "wallet.json");
    if (!fs.existsSync(walletPath)) return null;
    const data = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    const addr: string | undefined = data.address;
    if (!addr) return null;
    return addr.startsWith("0x") ? addr : `0x${addr}`;
  } catch {
    return null;
  }
}
