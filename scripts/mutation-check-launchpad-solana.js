#!/usr/bin/env node
/**
 * Mutation check for the Solana launchpad guards (launchpad_buy / launchpad_sell / launchpad_launch_token, chain=solana).
 * Each mutant breaks ONE guard; the named suite must fail. Restores the file unconditionally.
 * Usage: node scripts/mutation-check-launchpad-solana.js
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const TOOL = path.join(ROOT, "src/tools/launchpad-solana.ts");
const LIB = path.join(ROOT, "src/launchpad-solana.ts");
const SUITE = "test/launchpad-solana.test.ts";
const PARITY = "test/launchpad-solana-parity.test.ts";

const MUTANTS = [
  { name: "program allowlist gains an arbitrary program (Jupiter) / loses cp-amm", file: LIB,
    from: `  METEORA_CP_AMM_PROGRAM.toBase58(),\n];`, to: `  METEORA_CP_AMM_PROGRAM.toBase58(),\n  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",\n];`, test: PARITY },
  { name: "assertSafeTx is given an allowlist without the cp-amm program", file: TOOL,
    from: `allowedPrograms: SOLANA_SWAP_PROGRAMS,`, to: `allowedPrograms: SOLANA_SWAP_PROGRAMS.filter((p) => p !== METEORA_CP_AMM_PROGRAM.toBase58()),`, test: SUITE },
  { name: "minOut ignores slippage (min = expected out, or 0)", file: LIB,
    from: `const minOut = bps > 0n ? (outAmount * (10_000n - bps)) / 10_000n : outAmount;`, to: `const minOut = 0n;`, test: SUITE },
  { name: "swap built with minimumAmountOut = 0", file: LIB,
    from: `amountIn: p.amountIn, minimumAmountOut: p.minOut,`, to: `amountIn: p.amountIn, minimumAmountOut: 0n,`, test: SUITE },
  { name: "quote drift check removed", file: TOOL,
    from: `if (qt.minOut * 10_000n < prev!.minOut * BigInt(10_000 - MAX_QUOTE_DRIFT_BPS)) {`, to: `if (false) {`, test: SUITE },
  { name: "quote drift tolerance widened to 50%", file: TOOL,
    from: `prev!.minOut * BigInt(10_000 - MAX_QUOTE_DRIFT_BPS)`, to: `prev!.minOut * 5_000n`, test: SUITE },
  { name: "buy cap not enforced", file: TOOL,
    from: `if (a.amountIn > cap) throw new Error(\`Buy amount`, to: `if (false) throw new Error(\`Buy amount`, test: SUITE },
  { name: "buy cap default raised to 100 SOL", file: TOOL,
    from: `solanaCapLamports("FINCH_LAUNCHPAD_MAX_BUY_SOL", "0.5")`, to: `solanaCapLamports("FINCH_LAUNCHPAD_MAX_BUY_SOL", "100")`, test: SUITE },
  { name: "junk cap env no longer fails closed (falls back to default)", file: TOOL,
    from: `  catch { throw new Error(\`\${name}=\${JSON.stringify(raw)} is not a valid positive SOL amount; refusing (fail closed).\`); }`, to: `  catch { return parseHumanToBaseUnits(dflt, 9); }`, test: SUITE },
  { name: "default-deny spend gate removed", file: TOOL,
    from: `export const launchpadSolanaSpendEnabled = (): boolean => process.env.FINCH_LAUNCHPAD_ALLOW_SPEND === "1";`, to: `export const launchpadSolanaSpendEnabled = (): boolean => true;`, test: SUITE },
  { name: "spend gate accepts any truthy value", file: TOOL,
    from: `process.env.FINCH_LAUNCHPAD_ALLOW_SPEND === "1";`, to: `!!process.env.FINCH_LAUNCHPAD_ALLOW_SPEND;`, test: SUITE },
  { name: "'needs finch login' check removed (API key accepted as a session)", file: TOOL,
    from: `if (!t || isApiKey(t)) throw new Error(LOGIN_REQUIRED_MSG);`, to: `if (!t) throw new Error(LOGIN_REQUIRED_MSG);`, test: SUITE },
  { name: "'needs finch login' check removed entirely (launch contacts backend without a session)", file: TOOL,
    from: `if (!t || isApiKey(t)) throw new Error(LOGIN_REQUIRED_MSG);\n  return t.trim();`, to: `return (t ?? "anon").trim();`, test: SUITE },
  { name: "launch cap not enforced", file: TOOL,
    from: `if (totalNeed > cap) throw`, to: `if (false) throw`, test: SUITE },
  { name: "launch POST contacted in preview (no confirmed gate)", file: TOOL,
    from: `if (a.confirmed !== true) {\n    const short`, to: `if (a.confirmed === "never") {\n    const short`, test: SUITE },
  { name: "price impact limit disabled", file: TOOL,
    from: `if (qt.priceImpactPct > MAX_PRICE_IMPACT_PCT) {`, to: `if (false) {`, test: SUITE },
  { name: "quoteId binding removed (confirmed=true alone executes)", file: TOOL,
    from: `if (a.confirmed !== true || !matches) {`, to: `if (a.confirmed !== true) {`, test: SUITE },
  { name: "non-Finch tokens tradable (source check removed)", file: TOOL,
    from: `if ((t?.source ?? r?.source) !== "finch") throw`, to: `if (false) throw`, test: SUITE },
  { name: "pool owner check removed", file: TOOL,
    from: `if (acc.owner !== METEORA_CP_AMM_PROGRAM.toBase58()) throw`, to: `if (false) throw`, test: SUITE },
  { name: "pool/token mint match check removed", file: TOOL,
    from: `if (other.toBase58() !== mint) throw`, to: `if (false) throw`, test: SUITE },
  { name: "simulation guard: SOL decrease cap removed", file: TOOL,
    from: `maxSolDecrease: (a.side === "buy" ? a.amountIn : 0n) + SWAP_RESERVE,`, to: `maxSolDecrease: 10n ** 18n,`, test: SUITE },
  { name: "plan-vs-tx instruction check removed", file: TOOL,
    from: `  assertTxMatchesPlan(tx, ixs);`, to: ``, test: SUITE },
  { name: "swap account order: pool vaults swapped by direction (parity break)", file: LIB,
    from: `meta(a.tokenAVault, false, true),\n      meta(a.tokenBVault, false, true),`, to: `meta(a.tokenBVault, false, true),\n      meta(a.tokenAVault, false, true),`, test: PARITY },
  { name: "WSOL ATA not closed after a buy (parity break)", file: LIB,
    from: `if (inIsSol) ixs.push(closeAccountIx(inputAta, wallet, wallet, TOKEN_PROGRAM));`, to: ``, test: PARITY },
  { name: "wallet change between preview and execution tolerated", file: TOOL,
    from: `if (wallet.toBase58() !== prev!.wallet) throw`, to: `if (false) throw`, test: SUITE },
];

let escaped = 0;
for (const m of MUTANTS) {
  const original = fs.readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) { console.log(`⚠️  STALE     ${m.name}`); escaped++; continue; }
  fs.writeFileSync(m.file, original.replace(m.from, m.to));
  let caught = false;
  try { execSync(`npx vitest run ${m.test} --testTimeout=60000`, { cwd: ROOT, stdio: "pipe" }); } catch { caught = true; }
  finally { fs.writeFileSync(m.file, original); }
  console.log(`${caught ? "✅ CAUGHT   " : "❌ ESCAPED  "} ${m.name}`);
  if (!caught) escaped++;
}
if (escaped) { console.log(`\n${escaped} mutant(s) survived or were stale.`); process.exit(1); }
console.log(`\nAll ${MUTANTS.length} mutants caught.`);
