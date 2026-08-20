// `finch install` - auto-configure detected MCP clients (Claude Desktop,
// Cursor, Windsurf, VS Code, Zed).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readConfig } from "./config.js";
import { C } from "./cli-ui.js";
import { PKG_VERSION, CORE_TOOL_COUNT, TOTAL_TOOL_COUNT } from "./cli-env.js";

interface McpClient {
  name: string;
  configPath: string;
  // Config schema differs per client - writing the wrong shape produces a
  // config the client silently ignores:
  //   mcpServers      - Claude Desktop, Cursor, Windsurf (entry: {command,args,env})
  //   servers         - VS Code mcp.json               (entry needs "type": "stdio")
  //   context_servers - Zed settings.json              (entry needs "source": "custom")
  serversKey: "mcpServers" | "servers" | "context_servers";
  entryStyle: "standard" | "vscode" | "zed";
}

function resolveClients(): McpClient[] {
  const home    = os.homedir();
  const plat    = os.platform();
  const appdata = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");

  type Def = { name: string; serversKey: McpClient["serversKey"]; entryStyle: McpClient["entryStyle"]; paths: Record<string, string> };
  const defs: Def[] = [
    {
      name: "Claude Desktop", serversKey: "mcpServers", entryStyle: "standard",
      paths: {
        darwin: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        win32:  path.join(appdata, "Claude", "claude_desktop_config.json"),
        linux:  path.join(home, ".config", "Claude", "claude_desktop_config.json"),
      },
    },
    {
      name: "Cursor", serversKey: "mcpServers", entryStyle: "standard",
      paths: {
        darwin: path.join(home, ".cursor", "mcp.json"),
        win32:  path.join(home, ".cursor", "mcp.json"),
        linux:  path.join(home, ".cursor", "mcp.json"),
      },
    },
    {
      name: "Windsurf", serversKey: "mcpServers", entryStyle: "standard",
      paths: {
        darwin: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
        win32:  path.join(home, ".codeium", "windsurf", "mcp_config.json"),
        linux:  path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      },
    },
    // VS Code: user-level mcp.json uses the top-level `servers` key (NOT
    // mcpServers) and each entry needs `"type": "stdio"`.
    {
      name: "VS Code", serversKey: "servers", entryStyle: "vscode",
      paths: {
        darwin: path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
        win32:  path.join(appdata, "Code", "User", "mcp.json"),
        linux:  path.join(home, ".config", "Code", "User", "mcp.json"),
      },
    },
    {
      name: "VS Code Insiders", serversKey: "servers", entryStyle: "vscode",
      paths: {
        darwin: path.join(home, "Library", "Application Support", "Code - Insiders", "User", "mcp.json"),
        win32:  path.join(appdata, "Code - Insiders", "User", "mcp.json"),
        linux:  path.join(home, ".config", "Code - Insiders", "User", "mcp.json"),
      },
    },
    // Zed: MCP servers live in settings.json under `context_servers`, and each
    // entry needs `"source": "custom"`. (Not a separate mcp.json file.)
    {
      name: "Zed", serversKey: "context_servers", entryStyle: "zed",
      paths: {
        darwin: path.join(home, ".config", "zed", "settings.json"),
        win32:  path.join(appdata, "Zed", "settings.json"),
        linux:  path.join(home, ".config", "zed", "settings.json"),
      },
    },
  ];

  return defs
    .map((d): McpClient => {
      const configPath = d.paths[plat] ?? d.paths.linux;
      return { name: d.name, configPath, serversKey: d.serversKey, entryStyle: d.entryStyle };
    })
    .filter((c) => {
      // Include if the config file exists OR the parent directory exists (app installed but not yet configured)
      return fs.existsSync(c.configPath) || fs.existsSync(path.dirname(c.configPath));
    });
}

// `npx -y @finchagentic/mcp@version` alone fails with "could not determine
// executable to run" - the package ships two bins (finch, finch-mcp)
// and neither matches the unscoped package name npx resolves by default.
// -p ... finch-mcp names the actual MCP-protocol server explicitly
// (not `finch`, which is the human-interactive REPL and would break the
// JSON-RPC handshake if a host spawned it instead). Pinned to the currently
// installed version, never @latest - matches the security boundary
// documented in the README (wallet/credential access needs a stable,
// reviewable version, not a moving target).
function buildEntry(style: McpClient["entryStyle"]): Record<string, unknown> {
  const base = {
    command: "npx",
    args: ["-y", "-p", `@finchagentic/mcp@${PKG_VERSION}`, "finch-mcp"],
    env: {} as Record<string, string>,
  };
  if (style === "vscode") return { type: "stdio", ...base };
  if (style === "zed")    return { source: "custom", ...base };
  return base;
}

// Returns "skipped" (distinct from "error") when an existing config file can't
// be parsed - overwriting it would destroy the user's real config (VS Code
// mcp.json and Zed settings.json are JSONC and routinely contain comments,
// which JSON.parse rejects). In that case we leave the file untouched and the
// caller prints a manual-add snippet instead.
function installIntoConfig(client: McpClient): "added" | "updated" | "error" | "skipped" {
  try {
    let json: any = {};

    if (fs.existsSync(client.configPath)) {
      const raw = fs.readFileSync(client.configPath, "utf8");
      try {
        json = JSON.parse(raw);
      } catch {
        return "skipped"; // don't clobber an unparseable (likely JSONC) file
      }
    } else {
      // Ensure parent dir exists
      fs.mkdirSync(path.dirname(client.configPath), { recursive: true });
    }

    const key = client.serversKey;
    if (!json[key] || typeof json[key] !== "object") json[key] = {};
    const existed = !!json[key].finch;
    json[key].finch = buildEntry(client.entryStyle);

    fs.writeFileSync(client.configPath, JSON.stringify(json, null, 2), "utf8");
    return existed ? "updated" : "added";
  } catch {
    return "error";
  }
}

export async function installFlow(): Promise<void> {
  console.log(`\n  ${C.cyan}${C.bold}finch install${C.reset}\n`);
  console.log(`  ${C.dim}Scanning for MCP-compatible apps...${C.reset}\n`);

  const clients = resolveClients();

  if (clients.length === 0) {
    console.log(`  ${C.yellow}No MCP-compatible apps found.${C.reset}`);
    console.log(`  ${C.dim}Install Claude Desktop, Cursor, or Windsurf, then run this again.${C.reset}\n`);
    console.log(`  ${C.dim}Or add manually to your app's MCP config:${C.reset}`);
    console.log(`  ${C.dim}  "finch": { "command": "npx", "args": ["-y", "-p", "@finchagentic/mcp@${PKG_VERSION}", "finch-mcp"] }${C.reset}\n`);
    return;
  }

  let installed = 0;
  const toRestart: string[] = [];

  const manual: string[] = [];
  for (const client of clients) {
    const result = installIntoConfig(client);
    const short  = client.configPath.replace(os.homedir(), "~");

    if (result === "added") {
      console.log(`  ${C.green}✓${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ added${C.reset}`);
      console.log(`     ${C.dim}${short}${C.reset}`);
      installed++;
      toRestart.push(client.name);
    } else if (result === "updated") {
      console.log(`  ${C.green}↑${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ updated (re-pinned to v${PKG_VERSION})${C.reset}`);
      console.log(`     ${C.dim}${short}${C.reset}`);
      installed++;
      toRestart.push(client.name);
    } else if (result === "skipped") {
      // Existing config couldn't be parsed (likely has comments) - never
      // overwrite it. Show the user exactly what to paste under which key.
      console.log(`  ${C.yellow}⚠${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ has an existing config we won't overwrite${C.reset}`);
      console.log(`     ${C.dim}${short}${C.reset}`);
      manual.push(`  ${C.dim}${client.name}: add under ${C.reset}${C.cyan}"${client.serversKey}"${C.reset}${C.dim}:${C.reset}\n     ${C.dim}${JSON.stringify({ finch: buildEntry(client.entryStyle) })}${C.reset}`);
    } else {
      console.log(`  ${C.yellow}✗${C.reset}  ${C.bold}${client.name}${C.reset}  ${C.dim}→ write failed (check permissions)${C.reset}`);
    }
  }

  if (manual.length) {
    console.log(`\n  ${C.dim}Add these by hand (we didn't touch your existing config):${C.reset}`);
    for (const m of manual) console.log(m);
  }

  console.log(`\n  ${C.dim}${"─".repeat(52)}${C.reset}\n`);

  if (installed === 0) {
    console.log(`  ${C.yellow}Nothing was installed. Check file permissions.${C.reset}\n`);
    return;
  }

  console.log(`  ${C.green}${C.bold}✓ Finch installed in ${installed} app${installed === 1 ? "" : "s"}.${C.reset}\n`);

  if (toRestart.length > 0) {
    console.log(`  ${C.dim}Restart to activate:  ${toRestart.join("  ·  ")}${C.reset}`);
  }

  // Tool palette: the server exposes the CORE subset by default to keep the
  // client's context lean. Everything else stays callable by name, and power
  // users can flip on the full surface. Surfaced here so the count a user sees
  // in their client (CORE) doesn't silently contradict the "all tools" framing.
  console.log(
    `\n  ${C.dim}Your client will see the ${CORE_TOOL_COUNT} core tools by default. ` +
    `Add ${C.reset}${C.cyan}"env": { "FINCH_TOOLS": "all" }${C.reset}${C.dim} to the finch entry for all ${TOTAL_TOOL_COUNT}.${C.reset}`
  );

  const cfg = readConfig();
  if (!cfg.sessionToken) {
    console.log(`\n  ${C.dim}Next step - sign in to unlock all tools:${C.reset}`);
    console.log(`  ${C.cyan}  finch login${C.reset}\n`);
  } else {
    console.log(`\n  ${C.dim}Already signed in as ${cfg.email ?? "user"}.${C.reset}`);
    console.log(`  ${C.dim}Open your MCP client and start using Finch.${C.reset}\n`);
  }
}
