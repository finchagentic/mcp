import { signRequest } from "./wallet.js";
import { getSavedToken } from "./config.js";

export const CONVEX_SITE = process.env.FINCH_CONVEX_URL ?? "https://befitting-porcupine-276.convex.site";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [500, 1000, 2000];

export class PaymentRequiredError extends Error {
  readonly details: unknown;
  constructor(details: unknown) {
    super("Payment required");
    this.name = "PaymentRequiredError";
    this.details = details;
  }
}

export function buildPaymentHeader(txHash: string, requestId: string): string {
  return Buffer.from(`${txHash}:${requestId}`).toString("base64");
}

async function attemptConvex(url: string, method: string, headers: Record<string, string>, body?: unknown, timeoutMs = 30_000): Promise<Response> {
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function callConvex(path: string, method: string, body?: unknown, toolName = "unknown", timeoutMs = 30_000): Promise<any> {
  const url = `${CONVEX_SITE}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  const apiKey      = process.env.FINCH_API_KEY;
  const sessionToken = getSavedToken(); // env var → saved config fallback
  // Prefer session token (resolved by backend) over API key for Convex API calls
  const authHeader  = sessionToken
    ? `Bearer ${sessionToken}`
    : apiKey
    ? `Bearer ${apiKey}`
    : null;
  if (authHeader) {
    headers["Authorization"] = authHeader;
  } else {
    try {
      const { address, signature, timestamp } = await signRequest(toolName);
      headers["X-Wallet-Address"] = address;
      headers["X-Wallet-Signature"] = signature;
      headers["X-Wallet-Timestamp"] = timestamp;
    } catch {
      // continue without wallet headers - server will respond with 401/402
    }
  }

  const paymentHeader = process.env.FINCH_PAYMENT_HEADER;
  if (paymentHeader) headers["X-Payment"] = paymentHeader;

  // BYOK headers - user pays for their own AI/service costs
  if (process.env.ANTHROPIC_API_KEY) headers["X-User-Anthropic-Key"] = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) headers["X-User-OpenAI-Key"] = process.env.OPENAI_API_KEY;
  if (process.env.GROK_API_KEY) headers["X-User-Grok-Key"] = process.env.GROK_API_KEY;
  if (process.env.BANKR_API_KEY) headers["X-User-Bankr-Key"] = process.env.BANKR_API_KEY;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1]));
    }
    let res: Response;
    try {
      res = await attemptConvex(url, method, headers, body, timeoutMs);
    } catch (err: any) {
      lastError = err;
      continue;
    }

    if (res.status === 402) {
      const b = await res.json().catch(() => ({}));
      throw new PaymentRequiredError(b);
    }

    if (res.status === 401) {
      const b = await res.json().catch(() => ({})) as {
        message?: string; url?: string; hint?: string; alternative?: string;
      };
      throw new Error(
        `🔑 ${b.message || "Authentication required"}\n\n` +
        `→ Sign in at: ${b.url || "https://finchagentic.com"}\n\n` +
        `Hint: ${b.hint || 'Add FINCH_SESSION_TOKEN=… to the env block in your MCP config'}\n\n` +
        `${b.alternative ? `Alternative: ${b.alternative}` : ""}`
      );
    }

    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS.length) {
      // Capture the actual body so a deterministic error (e.g. "unknown
      // token") that happens to come back on a 500 still surfaces its real
      // message if retries exhaust - previously this discarded the body
      // entirely and threw a bare "Finch API error: 500", hiding exactly the
      // information the caller needed to fix the request.
      const bodyText = await res.text().catch(() => "");
      lastError = new Error(`Finch API error ${res.status}: ${bodyText.slice(0, 300) || "(no body)"}`);
      continue;
    }

    if (!res.ok) throw new Error(`Finch API error: ${res.status} ${await res.text()}`);
    return res.json() as Promise<any>;
  }

  throw lastError ?? new Error("Request failed after retries");
}

// Variant that returns the response body as raw text. Used for endpoints
// that stream non-JSON content like /vault/blob (large vault entries that
// were offloaded to Convex File Storage).
export async function callConvexRaw(path: string, toolName = "unknown", timeoutMs = 60_000): Promise<string> {
  const url = `${CONVEX_SITE}${path}`;
  const headers: Record<string, string> = {};

  const apiKey       = process.env.FINCH_API_KEY;
  const sessionToken = getSavedToken();
  const authHeader   = apiKey
    ? `Bearer ${apiKey}`
    : sessionToken
    ? `Bearer ${sessionToken}`
    : null;
  if (authHeader) {
    headers["Authorization"] = authHeader;
  } else {
    try {
      const { address, signature, timestamp } = await signRequest(toolName);
      headers["X-Wallet-Address"] = address;
      headers["X-Wallet-Signature"] = signature;
      headers["X-Wallet-Timestamp"] = timestamp;
    } catch {
      // No local wallet available to sign with - continue without wallet
      // headers, server will respond with 401/402 if auth was required.
    }
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Finch API error: ${res.status}`);
  return res.text();
}
