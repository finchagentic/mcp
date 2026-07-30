import { describe, it, expect } from "vitest";
import { ALL_TOOLS, HANDLER_MAP } from "../src/server.js";
import { annotationsFor, withAnnotations, MUTATING_TOOL_NAMES } from "../src/annotations.js";

describe("tool registration", () => {
  it("registers a non-trivial number of tools", () => {
    // Not pinned to an exact count (that drifts every release) - just guards
    // against ALL_TOOLS silently collapsing to empty/near-empty.
    expect(ALL_TOOLS.length).toBeGreaterThan(50);
  });

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("gives every tool a name, a description, and an object input schema", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name, `tool missing name: ${JSON.stringify(tool)}`).toBeTruthy();
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(tool.inputSchema?.type, `${tool.name} inputSchema.type`).toBe("object");
    }
  });

  it("has a handler registered for every declared tool (and vice versa)", () => {
    const declaredNames = new Set(ALL_TOOLS.map((t) => t.name));
    const handlerNames = new Set(HANDLER_MAP.keys());

    const missingHandler = [...declaredNames].filter((n) => !handlerNames.has(n));
    const orphanedHandler = [...handlerNames].filter((n) => !declaredNames.has(n));

    expect(missingHandler, "tools declared in ALL_TOOLS with no HANDLER_MAP entry").toEqual([]);
    expect(orphanedHandler, "handlers registered for tools not in ALL_TOOLS").toEqual([]);
  });
});

describe("tool annotations", () => {
  const annotated = withAnnotations(ALL_TOOLS);

  it("attaches annotations with a boolean readOnlyHint to every tool", () => {
    for (const tool of annotated) {
      expect(tool.annotations, `${tool.name} has no annotations`).toBeTruthy();
      expect(
        typeof tool.annotations?.readOnlyHint,
        `${tool.name} readOnlyHint not a boolean`
      ).toBe("boolean");
    }
  });

  it("never marks a tool both read-only and destructive", () => {
    for (const tool of annotated) {
      const a = tool.annotations!;
      if (a.readOnlyHint) {
        expect(a.destructiveHint ?? false, `${tool.name} is read-only AND destructive`).toBe(false);
      }
    }
  });

  it("flags known fund-moving / irreversible tools as destructive and not read-only", () => {
    // These MUST prompt the user - a regression that silently makes one of them
    // read-only would let a client auto-run a real swap/send/delete.
    const mustBeDestructive = [
      "base_mcp_send",
      "base_mcp_swap",
      "base_mcp_lend",
      "rh_mcp_swap",
      "rh_dca_create",
      "rh_bracket_create",
      "rh_orders_tick",
      "run_automation",
      "run_playbook",
      "packet_run",
      "vault_delete",
      "memory_delete",
      "memory_publish",
      "rh_order_cancel",
    ];
    for (const name of mustBeDestructive) {
      const a = annotationsFor(name);
      expect(a.readOnlyHint, `${name} must not be read-only`).toBe(false);
      expect(a.destructiveHint, `${name} must be destructive`).toBe(true);
    }
  });

  it("keeps pure reads read-only (so clients can auto-run them)", () => {
    const mustBeReadOnly = [
      "get_market_data",
      "list_agents",
      "memory_search",
      "vault_read",
      "web_search",
      "audit_contract",
      "hire_agent", // returns a persona, does not write
      "rh_safety_check",
      "base_mcp_estimate",
    ];
    for (const name of mustBeReadOnly) {
      expect(annotationsFor(name).readOnlyHint, `${name} should be read-only`).toBe(true);
    }
  });

  it("audit_contract is the offline read (openWorldHint false)", () => {
    expect(annotationsFor("audit_contract").openWorldHint).toBe(false);
    // A networked read stays open-world.
    expect(annotationsFor("get_market_data").openWorldHint).toBe(true);
  });

  it("only classifies real, registered tool names (no typos / stale entries)", () => {
    const declared = new Set(ALL_TOOLS.map((t) => t.name));
    const unknown = MUTATING_TOOL_NAMES.filter((n) => !declared.has(n));
    expect(unknown, "annotation sets reference tools not in ALL_TOOLS").toEqual([]);
  });
});

describe("tool-filter presets", () => {
  it("matches every registered tool against at least one FINCH_TOOLS preset", async () => {
    // A tool that matches no preset's regex is invisible under every
    // FINCH_TOOLS setting except "all" - this silently happened to 33/121
    // tools (rh_* order management, *_automation, packets, playbooks, wallet
    // balance/sign, miroshark, stock_*) before this test existed. New tools
    // MUST be added to a preset or this fails, instead of quietly vanishing.
    const { filterTools } = await import("../src/tool-filter.js");
    const originalEnv = process.env.FINCH_TOOLS;
    const presetKeys = ["core", "defi", "research", "memory", "coder"];
    try {
      const matchedByAny = new Set<string>();
      for (const key of presetKeys) {
        process.env.FINCH_TOOLS = key;
        for (const t of filterTools(ALL_TOOLS)) matchedByAny.add(t.name);
      }
      const unmatched = ALL_TOOLS.map((t) => t.name).filter((n) => !matchedByAny.has(n));
      expect(unmatched, "tools matching no FINCH_TOOLS preset - add them to one in tool-filter.ts").toEqual([]);
    } finally {
      if (originalEnv === undefined) delete process.env.FINCH_TOOLS;
      else process.env.FINCH_TOOLS = originalEnv;
    }
  });
});
