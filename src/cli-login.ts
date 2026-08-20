// `finch login` - API-key sign-in, both the interactive prompt and the
// FINCH_API_KEY env-var fast path.

import * as readline from "readline";
import { isApiKey, writeConfig } from "./config.js";
import { dedupClinkInput } from "./clink-input.js";
import { C, printLoginSuccess } from "./cli-ui.js";
import { CONVEX_SITE } from "./cli-env.js";

export async function loginWithApiKey(rl: readline.Interface): Promise<void> {
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

  console.log(`  ${C.dim}Generate an API key at app.finchagentic.com → Settings → API Keys${C.reset}`);
  console.log(`  ${C.dim}Or set env var: set FINCH_API_KEY=finch_sk_... (or noel_sk_...)${C.reset}`);
  let apiKey = (await ask(`  API key (finch_sk_... / noel_sk_...): `)).trim();
  if (!apiKey) return;

  // Deduplicates doubled input from a known Clink v1.7.6 terminal bug (e.g.
  // "finch_sk_xxfinch_sk_xx" → "finch_sk_xx"); also strips non-ASCII Clink can inject.
  apiKey = dedupClinkInput(apiKey).replace(/[^\x20-\x7E]/g, "").trim();

  if (!isApiKey(apiKey)) {
    console.log(`\n  ${C.red}✗${C.reset} API key must start with "finch_sk_" or "noel_sk_". Got: "${apiKey.slice(0, 20)}..."\n`);
    return;
  }

  process.stdout.write(`  Authenticating...`);
  const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await res.json() as any;
  if (!res.ok || !data.token) {
    console.log(`\n  ${C.red}✗${C.reset} ${data.error ?? "Invalid API key"}\n`);
    return;
  }

  const email: string = data.email ?? "api-key-user";
  const name: string | undefined = data.displayName ?? undefined;
  writeConfig({ sessionToken: data.token, email, name, walletAddress: data.walletAddress });
  printLoginSuccess({ email, name, walletAddress: data.walletAddress });
}

export async function loginFlow(loginRl?: readline.Interface): Promise<void> {
  const rl = loginRl ?? readline.createInterface({ input: process.stdin, output: process.stdout });

  // Check env var first — skip prompt entirely
  const envKey = process.env.FINCH_API_KEY;
  if (envKey && isApiKey(envKey)) {
    console.log(`\n  ${C.dim}Found FINCH_API_KEY in environment — authenticating...${C.reset}`);
    process.stdout.write(`  Authenticating...`);
    const res = await fetch(`${CONVEX_SITE}/auth/apikey/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: envKey }),
    });
    const data = await res.json() as any;
    if (res.ok && data.token) {
      const email: string = data.email ?? "api-key-user";
      const name: string | undefined = data.displayName ?? undefined;
      writeConfig({ sessionToken: data.token, email, name, walletAddress: data.walletAddress });
      printLoginSuccess({ email, name, walletAddress: data.walletAddress });
      rl.close();
      return;
    }
    console.log(`\n  ${C.red}✗${C.reset} Env var FINCH_API_KEY is invalid. Falling back to manual login.\n`);
  }

  console.log(`\n  ${C.cyan}${C.bold}Sign in to Finch${C.reset}\n`);
  await loginWithApiKey(rl);
  rl.close();
}
