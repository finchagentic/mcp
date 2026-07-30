import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Checks provider routing priority by inspecting source text rather than
// exercising the LLM calls themselves (those need live provider keys/network).
// This catches the common regression: someone reorders an `if (xKey) ... else
// if (yKey)` chain and silently changes which provider gets picked first.

const here = dirname(fileURLToPath(import.meta.url));
const src = (relPath: string) => readFileSync(join(here, "..", "src", relPath), "utf8");

describe("provider routing priority", () => {
  it("llm.ts: checks BANKR_API_KEY before ANTHROPIC_API_KEY in callLLM()", () => {
    const text = src("llm.ts");
    const bankrIdx = text.indexOf("const bankrKey");
    const anthropicIdx = text.indexOf("const anthropicKey");
    expect(bankrIdx).toBeGreaterThan(-1);
    expect(anthropicIdx).toBeGreaterThan(-1);
    expect(bankrIdx).toBeLessThan(anthropicIdx);
  });

  it("llm.ts: FINCH_MODEL overrides every provider-specific *_MODEL var", () => {
    const text = src("llm.ts");
    const modelLines = [...text.matchAll(/const model = modelOverride \?\? process\.env\.FINCH_MODEL \?\? process\.env\.(\w+)_MODEL/g)];
    expect(modelLines.length).toBeGreaterThanOrEqual(3);
  });

  it("llm.ts and agent-loop.ts have no hardcoded grok-3 model id", () => {
    expect(src("llm.ts")).not.toContain("grok-3");
    expect(src("agent-loop.ts")).not.toContain("grok-3");
  });

  it("agent-loop.ts: runAgent() checks bankrKey before anthropicKey", () => {
    const text = src("agent-loop.ts");
    const runAgentStart = text.indexOf("export async function runAgent");
    const runAgentEnd = text.indexOf("function runAnthropicLoop");
    expect(runAgentStart).toBeGreaterThan(-1);
    expect(runAgentEnd).toBeGreaterThan(runAgentStart);

    const body = text.slice(runAgentStart, runAgentEnd);
    const bankrIdx = body.indexOf("bankrKey");
    const anthropicIdx = body.indexOf("anthropicKey");
    expect(bankrIdx).toBeGreaterThan(-1);
    expect(bankrIdx).toBeLessThan(anthropicIdx);
  });
});
