import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  // Optional machine-readable payload (MCP spec 2025-06-18). When a tool
  // declares an `outputSchema`, its result SHOULD also carry `structuredContent`
  // conforming to it - the human-readable `content` text stays for backward
  // compatibility with clients that don't consume structured output.
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type { Tool };
