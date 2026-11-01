import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALL_TOOLS } from "../src/server.js";

const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

describe("README accuracy", () => {
  it("states the real tool count everywhere", () => {
    const n = ALL_TOOLS.length;
    expect(readme).toContain(`**${n} tools**`);
    expect(readme).toContain(`of ${n} tools`);
    const nums = [...readme.matchAll(/\*\*(\d+) tools\*\*/g)].map((m) => Number(m[1]));
    expect(nums.every((x) => x === n)).toBe(true);
  });
  it("pins the current package version, not a stale one", () => {
    const pins = [...readme.matchAll(/@finchagentic\/mcp@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([pkg.version]));
  });
  it("CHANGELOG has an entry for the package version", () => {
    expect(fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8")).toContain(`## [${pkg.version}]`);
  });
});
