// Solidity static analysis.
//
// This module used to also generate, explain and review code via a server-side
// LLM. Those were removed: the MCP client (Claude Code, Cursor, the CLI's own
// agent loop) is already a model, and it does that work better because it has
// the repository in context. What survives here is the part a model cannot do
// for itself — a deterministic pattern scan over the source.

import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { staticScanSolidity, formatFindings, AUDIT_DISCLAIMER } from "./_solidity-scan.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const CODER_TOOLS: Tool[] = [
  {
    name: "audit_contract",
    description:
      "Run a deterministic static scan over Solidity source for common antipatterns " +
      "(tx.origin auth, reentrancy ordering, unchecked low-level calls, delegatecall hijack, " +
      "floating pragma, etc). Returns the findings with severities plus a review rubric for YOU " +
      "to work through — you are the reviewer, and you have the repo in context. " +
      "Needs no API key. Not a substitute for a professional audit (CertiK, Trail of Bits, " +
      "OpenZeppelin) or formal verification.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The full Solidity contract source code to audit",
        },
        focus: {
          type: "array",
          items: { type: "string" },
          description: "Optional: specific areas to focus on, e.g. ['reentrancy', 'access control', 'overflow']",
        },
      },
      required: ["code"],
    },
  },
];

const AuditSchema = z.object({
  code: z.string().min(10),
  focus: z.array(z.string()).optional(),
});

export async function handleCoderTool(name: string, args: unknown): Promise<ToolResult | null> {
  if (name !== "audit_contract") return null;

  const p = AuditSchema.safeParse(args);
  if (!p.success) return err(p.error.issues[0].message);
  const { code, focus = [] } = p.data;

  // The pattern scan grounds the review. Without it an audit is pure model
  // opinion — someone might trust "looks safe" with nothing behind it.
  const findings = staticScanSolidity(code);
  const findingsBlock = formatFindings(findings);
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;

  // The rubric travels with the findings rather than being applied out of sight,
  // so the discipline the old server-side prompt enforced is preserved.
  const rubric =
    (focus.length ? `**User-requested focus:** ${focus.join(", ")}\n\n` : "") +
    `## How to review this\n\n` +
    `**Overall risk** — Critical / High / Medium / Low / Informational, plus one sentence of ` +
    `justification. The scan found **${criticalCount} critical** and **${highCount} high**; where that ` +
    `is ≥1 critical or ≥2 high, your rating must be at least High unless you explicitly refute those ` +
    `findings with reasoning.\n\n` +
    `**Static findings review** — one line per finding, none skipped:\n` +
    `\`- **<ID>** — confirmed / refuted / needs-context — (1-3 sentences)\`\n\n` +
    `**Additional findings** the scan cannot catch (severity, location, description, recommendation), ` +
    `or "No additional findings."\n\n` +
    `**Gas optimizations** — 2-5 concrete savings, skip if already tight.\n\n` +
    `**Positive patterns** — 3-5 bullets max.\n\n` +
    `Never call the contract "secure" or "safe" — that implies a guarantee no review can make. ` +
    `Prefer "no obvious issues found in X under Y", and say where you are uncertain.`;

  return ok(
    [
      `# Smart Contract Audit — static scan`,
      ``,
      `**${findings.length} finding(s)** — ${criticalCount} critical · ${highCount} high · ` +
        `${findings.length - criticalCount - highCount} medium/low/info`,
      ``,
      `## Automated static scan findings`,
      ``,
      findingsBlock,
      ``,
      `---`,
      ``,
      rubric,
      AUDIT_DISCLAIMER,
    ].join("\n")
  );
}
