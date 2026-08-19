import { z } from "zod";
import type { ToolResult } from "./types.js";

// Every tool handler used to open with the same 2-line block, copy-pasted
// independently 53 times across 15+ files:
//   const parsed = XSchema.safeParse(args);
//   if (!parsed.success) return { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true };
// One shared helper instead - kept the success field named `data` (matching
// Zod's own SafeParseReturnType) so every existing `parsed.data.foo` call
// site downstream needed zero changes, only the two lines above did.

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: ToolResult };

export function parseOrError<T>(schema: z.ZodType<T>, args: unknown): ParseResult<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: { content: [{ type: "text", text: `${parsed.error.issues[0].message}` }], isError: true } };
  }
  return { ok: true, data: parsed.data };
}
