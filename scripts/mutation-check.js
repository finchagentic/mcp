#!/usr/bin/env node
/**
 * Mutation check for the numeric-accuracy invariants.
 *
 * A passing test proves nothing on its own — it has to fail when the bug comes
 * back. Each entry below reintroduces a defect that actually shipped, runs the
 * suite that is meant to catch it, and reports whether the suite noticed.
 *
 * This exists because all three accuracy bugs found in July 2026 produced
 * confident, well-formatted, wrong numbers, and every one of them passed a
 * "does the tool return output" check. One of the first regression tests
 * written for them also passed against the broken code — it was surviving on
 * fixture ordering rather than on the rule under test. That is exactly what
 * this catches.
 *
 * Usage: npm run test:mutation
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const EQUITY = path.join(ROOT, "src/tools/equity.ts");
const RH_MCP = path.join(ROOT, "src/tools/rh-mcp.ts");
const BASE_MCP = path.join(ROOT, "src/tools/base-mcp.ts");
const WALLET = path.join(ROOT, "src/tools/wallet.ts");
const RESEARCH = path.join(ROOT, "src/tools/research.ts");
const MEMORY = path.join(ROOT, "src/tools/memory.ts");
const AUTOMATION = path.join(ROOT, "src/tools/automation.ts");
const PUBLIC_URL = path.join(ROOT, "src/public-url.ts");
const DEX_PAIR = path.join(ROOT, "src/dex-pair.ts");

/** Each mutant is a real defect, paired with the suite that must reject it. */
const MUTANTS = [
  {
    name: "Day change reads chartPreviousClose (multi-day move shown as one day)",
    file: EQUITY,
    from: "prevClose: prev.close, prevDate: prev.day",
    to: "prevClose: m.chartPreviousClose, prevDate: prev.day",
    test: "test/equity-prev-close.test.ts",
  },
  {
    name: "XBRL tag selection takes the first candidate (stale series wins)",
    file: EQUITY,
    from: "if (!prev || latest > prev.latest) chosen.set(j.key, { tag: j.tag, facts, latest });",
    to: "if (!prev) chosen.set(j.key, { tag: j.tag, facts, latest });",
    test: "test/equity-xbrl-tag.test.ts",
  },
  {
    name: "Period spans unseparated (year-to-date counted as a quarter)",
    file: EQUITY,
    from: 'quarterly[c.key] = dedupe(facts.filter((f) => spanKind(f) === "quarter")).slice(-periods);',
    to: "quarterly[c.key] = dedupe(facts).slice(-periods);",
    test: "test/equity-period-span.test.ts",
  },
  {
    // Shared by rh_analyze/rh_safety_check (feeds TP/SL) and get_base_token_data,
    // so one mutant covers both call sites.
    name: "Pool chosen by depth regardless of side (another token's price reported)",
    file: DEX_PAIR,
    from: "    .filter((p) => p.baseToken?.address?.toLowerCase() === want)",
    to: "    .filter(() => true)",
    test: "test/rh-dex-base-price.test.ts test/market-base-token.test.ts",
  },
  {
    name: "Base send/swap broadcast without confirmation",
    file: BASE_MCP,
    from: "if (a?.confirm === true) return null;",
    to: "if (a?.confirm !== true) return null;",
    test: "test/execution-guards.test.ts",
  },
  {
    name: "Wallet signs attacker-supplied text without confirmation",
    file: WALLET,
    from: "if (confirm !== true) {",
    to: "if (confirm === true) {",
    test: "test/execution-guards.test.ts",
  },
  {
    name: "web_scrape reaches loopback and LAN from the user's machine",
    file: RESEARCH,
    from: "    const unsafe = await assertPublicUrl(url);\n    if (unsafe) {",
    to: "    const unsafe = await assertPublicUrl(url);\n    if (!unsafe) {",
    test: "test/execution-guards.test.ts",
  },
  {
    name: "memory_add indexes a private address via sourceUrl",
    file: MEMORY,
    from: "        const unsafe = await assertPublicUrl(sourceUrl);\n        if (unsafe) {",
    to: "        const unsafe = await assertPublicUrl(sourceUrl);\n        if (!unsafe) {",
    test: "test/execution-guards.test.ts",
  },
  {
    name: "delete_automation destroys config without asking",
    file: AUTOMATION,
    from: 'if ((args as { confirm?: boolean })?.confirm !== true) {',
    to: 'if ((args as { confirm?: boolean })?.confirm === true) {',
    test: "test/execution-guards.test.ts",
  },
  {
    name: "Private-address detection accepts link-local (cloud metadata reachable)",
    file: PUBLIC_URL,
    from: "    (a === 169 && b === 254) ||            // link-local, incl. cloud metadata",
    to: "    false ||",
    test: "test/execution-guards.test.ts",
  },
  {
    name: "Split-shaped EPS break passes silently (75% collapse reads as real)",
    file: EQUITY,
    from: "      if ((epsChange < -0.4 && niChange > -0.1) || (epsChange > 0.6 && niChange < 0.1)) {",
    to: "      if (false && ((epsChange < -0.4 && niChange > -0.1) || (epsChange > 0.6 && niChange < 0.1))) {",
    test: "test/equity-period-span.test.ts",
  },
];
let escaped = 0;

for (const m of MUTANTS) {
  const original = fs.readFileSync(m.file, "utf8");

  if (!original.includes(m.from)) {
    console.log(`⚠️  STALE     ${m.name}`);
    console.log(`             anchor no longer in ${path.relative(ROOT, m.file)} — update this mutant`);
    escaped++;
    continue;
  }

  fs.writeFileSync(m.file, original.replace(m.from, m.to));
  let caught = false;
  try {
    execSync(`npx vitest run ${m.test}`, { cwd: ROOT, stdio: "pipe" });
  } catch {
    caught = true;
  } finally {
    // Restore unconditionally: an interrupted run must never leave the mutant behind.
    fs.writeFileSync(m.file, original);
  }

  console.log(`${caught ? "✅ CAUGHT   " : "❌ ESCAPED  "} ${m.name}`);
  if (!caught) {
    console.log(`             ${m.test} passes against the broken code — it locks nothing`);
    escaped++;
  }
}

if (escaped) {
  console.log(`\n${escaped} mutant(s) survived. Those suites do not protect the invariant they claim to.`);
  process.exit(1);
}
console.log(`\nAll ${MUTANTS.length} mutants caught.`);
