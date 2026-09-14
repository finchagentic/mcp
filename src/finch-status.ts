import * as fs from "fs";
import * as path from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolResult } from "./types.js";
import { getSavedToken } from "./config.js";
import { callConvex } from "./convex.js";

// Same pattern as server.ts's own PKG_VERSION - fs.readFileSync, not
// require(), since this project's eslint config forbids require() imports.
function readPkgVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Local-only, no-auth-required status check. Replaces the old finch_status
// (which lived in tools/os.ts, made 6 Promise.allSettled backend calls, and
// silently defaulted every field to zero/basic on ANY failure - including a
// 401 - producing a dashboard that read "empty but healthy" instead of
// surfacing the real problem). This version makes exactly ONE cheap authed
// call when a token is configured, and reports the REAL auth state instead.
export const FINCH_STATUS_TOOL: Tool = {
  name: "finch_status",
  description:
    "Check Finch MCP is working - no sign-in needed. Returns the version, how many tools are available, " +
    "whether the session token is configured, and a ready-to-paste MCP client config snippet. Run this FIRST " +
    "if anything feels off: it tells you instantly whether the problem is auth (missing token), network " +
    "(backend unreachable), or the tool itself.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } as Tool["inputSchema"],
  annotations: { title: "Finch status", readOnlyHint: true, openWorldHint: false },
};

type AuthState = "none" | "valid" | "invalid" | "rejected" | "unreachable";
type CredentialKind = "session token" | "API key";

// Mirrors convex.ts's own precedence exactly (explicit env var of either
// kind beats a cached ~/.finch/config.json sessionToken from a past `finch
// login`) - this tool previously only checked getSavedToken(), which never
// considered FINCH_API_KEY at all. A user who configured FINCH_API_KEY
// fresh (the documented way to authenticate) but still had a stale cached
// session token file from months ago got told "not set" and pointed at
// sign-in instructions, when a perfectly valid credential was right there.
function resolveCredential(): { value: string; kind: CredentialKind } | null {
  if (process.env.FINCH_SESSION_TOKEN) return { value: process.env.FINCH_SESSION_TOKEN, kind: "session token" };
  if (process.env.FINCH_API_KEY) return { value: process.env.FINCH_API_KEY, kind: "API key" };
  let cached: string | undefined;
  try {
    cached = getSavedToken();
  } catch {
    cached = undefined;
  }
  return cached ? { value: cached, kind: "session token" } : null;
}

export async function handleFinchStatus(toolCount: number): Promise<ToolResult> {
  const version = readPkgVersion();

  const credential = resolveCredential();
  const tokenSet = credential !== null;
  const credentialLabel: CredentialKind = credential?.kind ?? "session token";
  let authState: AuthState = "none";
  let authDetail = "";

  if (tokenSet) {
    try {
      const data = await callConvex("/memory/profile", "GET", undefined, "finch_status", 8000, true);
      authState = (data?.status === "ok") ? "valid" : "rejected";
      if (authState === "rejected") {
        authDetail = `the ${credentialLabel} was rejected by the backend - re-copy it from app.finchagentic.com`;
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes("Authentication required")) {
        authState = "invalid";
        authDetail = `the backend rejected the ${credentialLabel} as expired or invalid - re-copy it from app.finchagentic.com`;
      } else {
        authState = "unreachable";
        authDetail = msg.slice(0, 120);
      }
    }
  }

  const configJson = JSON.stringify(
    {
      mcpServers: {
        finch: {
          command: "npx",
          args: ["-y", `@finchagentic/mcp@${version}`],
          env: { FINCH_SESSION_TOKEN: "<your token>" },
        },
      },
    },
    null,
    2,
  );

  const lines =
    tokenSet && authState === "valid"
      ? [
          `**Finch MCP v${version}** - runtime layer for agentic AI`,
          "",
          `- Auth: ✅ ${credentialLabel} valid (verified against the backend)`,
          `- Tools: **${toolCount}** registered (surface depends on FINCH_TOOLS filter)`,
          "- Resources: finch://vault/<key> - Prompts: crypto-thesis and friends",
          "- Tool presets: FINCH_PRESET=core|defi|research|memory (default core) - FINCH_TOOLS=all for everything",
          "",
          "All set. Good first calls: `memory_add` (persist a note instantly), `get_market_data` (live prices), `deep_research` (multi-step reports, streaming progress).",
        ]
      : tokenSet
      ? [
          `**Finch MCP v${version}** - runtime layer for agentic AI`,
          "",
          `- Auth: ⚠️ ${credentialLabel} configured but **${authState}**`,
          authDetail ? `- ${authDetail}` : "",
          "- Tools are registered, but every backend-backed call will fail until it's replaced.",
          "",
          `**Fix:** re-copy a fresh ${credentialLabel} from app.finchagentic.com, update ${credentialLabel === "API key" ? "FINCH_API_KEY" : "FINCH_SESSION_TOKEN"} in your MCP config, restart the client.`,
        ]
      : [
          `**Finch MCP v${version}** - runtime layer for agentic AI`,
          "",
          "- Auth: ❌ not set",
          "",
          "**To sign in (60 seconds):**",
          "",
          "1. Sign in at https://app.finchagentic.com (wallet or Google)",
          "2. Copy your session token from the app",
          "3. Add to your MCP client config:",
          "```json",
          configJson,
          "```",
          "",
          "Once the token is set, restart the MCP client and re-run this tool.",
        ];

  return { content: [{ type: "text", text: lines.filter((l) => l !== undefined).join("\n") }] };
}
