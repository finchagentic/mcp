import { describe, it, expect } from "vitest";
import { ALL_TOOLS } from "../src/server.js";
import { annotationsFor, isExplicitlyClassified } from "../src/annotations.js";

describe("annotations are fail-closed", () => {
  it("every registered tool has an explicit classification", () => {
    const missing = ALL_TOOLS.map((t) => t.name).filter((n) => !isExplicitlyClassified(n));
    expect(missing, "add these to a set in src/annotations.ts").toEqual([]);
  });
  it("an unknown tool defaults to destructive, not read-only", () => {
    const a = annotationsFor("totally_new_tool_xyz");
    expect(a.readOnlyHint).toBe(false);
    expect(a.destructiveHint).toBe(true);
  });
  it("vault_get_credential is not auto-runnable (not readOnly); web_scrape / memory_search are read-only open-world", () => {
    expect(annotationsFor("vault_get_credential").readOnlyHint).toBe(false);
    expect(annotationsFor("web_scrape")).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(annotationsFor("memory_search")).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
