import { ToolResult } from "./types.js";

/**
 * Output quality post-processor (CallTool choke point).
 * Normalizes every tool response before it reaches the client:
 *   1. Money/percent/date formatting inside the text payload (safe regex,
 *      only touches patterns that are unambiguous).
 *   2. Long-response triage: >200 lines get a "showing first N" head +
 *      pointer instead of silently dumping (context window hygiene).
 *   3. Never touches isError responses or JSON-only structuredContent-only
 *      shapes - the client renders those natively.
 */
const MAX_LINES = 200;

const MONEY_RE = /\$\s?([\d,]+\.\d{4,})/g; // $0.00012345 -> $0.00012 (4dp cap)

export function formatMoney(text: string): string {
  // Cap runaway precision: $0.00345678 -> $0.00346. Keeps tokens readable.
  return text.replace(MONEY_RE, (m, num: string) => {
    const n = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(n)) return m;
    const trimmed = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return `$${trimmed}`;
  });
}

export function truncate(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const head = lines.slice(0, MAX_LINES).join("\n");
  return `${head}\n\n… ${lines.length - MAX_LINES} more lines — narrow your query (smaller limit, fewer fields) for the full output.`;
}

export function processResponse(response: ToolResult | null | undefined): ToolResult | null | undefined {
  if (!response || (response as { isError?: boolean }).isError) return response;
  const first = response.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return response;
  let text = first.text;
  text = formatMoney(text);
  text = truncate(text);
  if (text !== first.text) {
    return { ...response, content: [{ ...first, text }, ...response.content.slice(1)] };
  }
  return response;
}
