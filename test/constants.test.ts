import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { FINCH_RH_ADDRESS } from "../src/constants.js";

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
const ROOT = path.join(__dirname, "..");

describe("FINCH contract addresses", () => {
  it("stale addresses never reappear in src/, README or CHANGELOG", () => {
    const stale = [/0x4b524015d54a27d4472f5c59c570730d69499ba3/i, /0xce1981b0431fb495912cab057d2877a290199824/i];
    const files = [...walk(path.join(ROOT, "src")), path.join(ROOT, "README.md"), path.join(ROOT, "CHANGELOG.md")].filter((f) => fs.existsSync(f));
    const bad = files.filter((f) => { const t = fs.readFileSync(f, "utf8"); return stale.some((r) => r.test(t)); });
    expect(bad).toEqual([]);
  });
  it("stake.ts and the gate use the constants module (no inline FINCH CA literals)", () => {
    const lit = new RegExp(FINCH_RH_ADDRESS, "i");
    for (const f of ["src/tools/stake.ts", "src/token-gate.ts"]) expect(lit.test(fs.readFileSync(path.join(ROOT, f), "utf8"))).toBe(false);
    expect(FINCH_RH_ADDRESS).toBe("0x879f29204a5ff842c66f0f65e0f2e422073acce7");
  });
});
