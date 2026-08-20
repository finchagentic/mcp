// `finch orders` - Robinhood Chain order scheduler.
//
// rh_dca_create/rh_bracket_create (src/tools/rh-orders.ts) only ever write a
// LOCAL pending order - nothing executes it. Only rh_orders_tick does, and
// per that file's own header comment, "an always-on scheduler must call
// rh_orders_tick {execute:true} periodically" - which this package never
// actually set up. A user who creates a daily DCA and closes their laptop
// got nothing, silently: no error, no warning, the order just sat there.
// These three subcommands are that missing scheduler, reusing the existing
// tick/lock/kill-switch logic as-is - "wire up the missing piece", not
// "build order execution from scratch".

import * as os from "os";
import * as path from "path";
import * as child_process from "child_process";
import { C } from "./cli-ui.js";
import { PKG_VERSION } from "./cli-env.js";

export async function runOrdersTick(execute: boolean): Promise<{ text: string; isError: boolean }> {
  const { handleRhOrderTool } = await import("./tools/rh-orders.js");
  const result = await handleRhOrderTool("rh_orders_tick", { execute });
  const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "(no output)";
  return { text, isError: !!result?.isError };
}

export function installOrdersScheduler(): void {
  // Version-pinned npx invocation, not a hardcoded path to this process's
  // own binary - matches this package's own "always pin the version, never
  // @latest" security guidance (README), and survives regardless of whether
  // the user got here via a global install or a one-off `npx -p`, whose
  // resolved path may not exist by the time the scheduler fires later.
  const invocation = `npx -y -p @finchagentic/mcp@${PKG_VERSION} finch orders tick --execute`;

  if (process.platform === "win32") {
    const taskName = "FinchOrdersTick";
    try {
      child_process.execSync(
        `schtasks /Create /TN "${taskName}" /TR "${invocation}" /SC MINUTE /MO 15 /F`,
        { stdio: "pipe" }
      );
      console.log(`\n  ${C.green}✓${C.reset} Registered Windows Task Scheduler task "${taskName}" - ticks every 15 min, survives reboots.`);
      console.log(`     ${C.dim}Remove it:${C.reset} schtasks /Delete /TN "${taskName}" /F`);
    } catch (err: any) {
      console.error(`  ${C.red}✗ schtasks failed: ${err.message}${C.reset}`);
      console.error(`     ${C.dim}Try running as Administrator, or use \`finch orders daemon\` instead.${C.reset}\n`);
      process.exit(1);
    }
  } else {
    const logFile = path.join(os.homedir(), ".finch", "orders-tick.log");
    const line = `*/15 * * * * ${invocation} >> ${logFile} 2>&1`;
    try {
      const existing = (() => {
        try { return child_process.execSync("crontab -l", { stdio: ["pipe", "pipe", "ignore"] }).toString(); }
        catch { return ""; } // no crontab yet for this user - not an error
      })();
      if (existing.includes("finch orders tick")) {
        console.log(`\n  ${C.yellow}○${C.reset} A finch orders tick entry already exists in crontab - not adding a duplicate.\n`);
        return;
      }
      const next = existing.trim().length > 0 ? `${existing.trim()}\n${line}\n` : `${line}\n`;
      child_process.execSync("crontab -", { input: next });
      console.log(`\n  ${C.green}✓${C.reset} Added a crontab entry - ticks every 15 min, survives reboots.`);
      console.log(`     ${C.dim}Remove it:${C.reset} crontab -e  ${C.dim}(delete the finch orders line)${C.reset}`);
      console.log(`     ${C.dim}Logs:${C.reset} ${logFile}`);
    } catch (err: any) {
      console.error(`  ${C.red}✗ crontab failed: ${err.message}${C.reset}`);
      console.error(`     ${C.dim}Try \`finch orders daemon\` instead.${C.reset}\n`);
      process.exit(1);
    }
  }
  console.log(`  ${C.dim}Only the local wallet's own default key is needed for signing - set FINCH_WALLET_PASSPHRASE as a persistent system env var (not just your shell rc file) if you use one, since scheduled tasks don't inherit an interactive shell's environment.${C.reset}\n`);
}

export async function ordersFlow(): Promise<void> {
  const sub = process.argv[3];

  if (sub === "tick") {
    const execute = process.argv.includes("--execute");
    const { text, isError } = await runOrdersTick(execute);
    console.log(`\n${text}\n`);
    if (isError) process.exit(1);
    return;
  }

  if (sub === "daemon") {
    const intervalFlag = process.argv.indexOf("--interval");
    const intervalMinutes = intervalFlag !== -1 ? Number(process.argv[intervalFlag + 1]) : 15;
    if (!(intervalMinutes > 0)) {
      console.error(`  ${C.red}✗ --interval must be a positive number of minutes${C.reset}\n`);
      process.exit(1);
    }
    console.log(`\n  ${C.cyan}${C.bold}finch orders daemon${C.reset} ${C.dim}- ticking every ${intervalMinutes}m, Ctrl+C to stop${C.reset}`);
    console.log(`  ${C.dim}Kill-switch: RH_ORDERS_DISABLED=1 or create ~/.finch/rh-orders.OFF${C.reset}`);
    console.log(`  ${C.dim}Note: this only runs while this process stays alive - for something that${C.reset}`);
    console.log(`  ${C.dim}survives reboots/terminal closure, use \`finch orders install-scheduler\` instead.${C.reset}\n`);

    let running = false; // skip a tick if the previous one is still in flight (slow RPC), don't queue up
    const tick = async () => {
      if (running) return;
      running = true;
      const ts = new Date().toISOString();
      try {
        const { text } = await runOrdersTick(true);
        console.log(`  ${C.dim}[${ts}]${C.reset}`);
        console.log(text.split("\n").map((l) => `  ${l}`).join("\n") + "\n");
      } catch (err: any) {
        console.error(`  ${C.red}[${ts}] tick error: ${err.message ?? err}${C.reset}\n`);
      } finally {
        running = false;
      }
    };

    await tick();
    const timer = setInterval(tick, intervalMinutes * 60_000);
    const shutdown = () => {
      clearInterval(timer);
      console.log(`\n  ${C.dim}Stopped.${C.reset}\n`);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return; // process stays alive via the interval timer
  }

  if (sub === "install-scheduler") {
    installOrdersScheduler();
    return;
  }

  console.log(`
  ${C.cyan}${C.bold}finch orders${C.reset}  ${C.dim}- Robinhood Chain DCA/TP-SL orders (rh_dca_create/rh_bracket_create)${C.reset}
  ${C.dim}do nothing on their own until one of these is running - creating an order${C.reset}
  ${C.dim}only ever writes it locally, nothing executes it automatically by itself.${C.reset}

  ${C.cyan}Commands:${C.reset}
    finch orders tick [--execute]         Run one tick now and exit (preview by default)
    finch orders daemon [--interval N]    Run in the foreground, ticking every N min (default 15)
    finch orders install-scheduler        Register an OS-level recurring task (Task Scheduler / cron)
`);
}
