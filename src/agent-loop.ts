import { ALL_TOOLS, HANDLER_MAP } from "./server.js";
import { callLLM, type ChatMessage } from "./llm.js";
import { callConvex } from "./convex.js";

const SYSTEM_PROMPT = [
  `You are Finch, the runtime layer for Agentic AI - with ${ALL_TOOLS.length} tools spanning memory, vault, deep research, persistent agents, code, automations, DeFi, and GitHub.`,
  "Be direct and concise. Pick the right tool - don't narrate the choice. Summarize tool results in plain English.",
  "",
  "CRITICAL - on-chain / financial actions (swap, send, transfer, buy, sell, bridge, lend, deposit, withdraw, balance):",
  "- You MUST call the corresponding tool. NEVER write 'Sent', 'Swapped', 'Tx confirmed', or any execution claim without an actual tool call returning a result first.",
  "- Tx hash and basescan/explorer URL from the tool output are MANDATORY in your reply - show them verbatim, do not omit or paraphrase.",
  "- NEVER fabricate a post-transaction balance with arithmetic. If user wants the new balance, call the balance tool again - do not compute it from a prior balance + amount.",
  "- For ALL Base chain operations, you MUST use the base_mcp_* family: base_mcp_swap (NOT swap_tokens), base_mcp_send (NOT send_token), base_mcp_balance (NOT get_portfolio), base_mcp_estimate, base_mcp_resolve, base_mcp_lend, base_mcp_status. This is non-negotiable - Base operations go through the Base MCP skill, period.",
  "- For Robinhood Chain tokenized stocks (chainId 4663, NVDA/AAPL/etc on Uniswap V4), you MUST use rh_mcp_*: rh_mcp_status, rh_mcp_list_stocks, rh_mcp_balance, rh_mcp_estimate, rh_mcp_swap. Never use base_mcp_* or 0x for RH stocks. rh_mcp_swap requires confirm:true. Explorer = robinhoodchain.blockscout.com. This is NOT Robinhood Agentic brokerage (agent.robinhood.com).",
  "- Do NOT claim an address belongs to the user (e.g. 'your own address') unless you have verified ownership. Resolving a basename returns whoever owns that name - usually NOT the caller.",
  "- The Finch wallet is the SAME address on both Base and Robinhood Chain, but they are separate ledgers - a balance on one tells you nothing about the other. If the user asks a chain-unspecified question ('what's my balance', 'do I have any funds') call BOTH base_mcp_balance AND rh_mcp_balance before answering. Never report only one chain's result as 'your balance' or 'your wallet is empty' - say which chain(s) you checked, and give both figures.",
  "- Swap/send requests are only chain-unambiguous when the token itself pins the chain (a RH catalog stock like NVDA/AAPL, or a token you already know only exists on one side). A bare request like 'swap 0.001 ETH to a stablecoin' with no chain named is NOT unambiguous just because you picked one - ETH and 'stablecoin' both exist on Base (USDC/USDT/DAI) and Robinhood Chain (USDG). Before estimating or executing an ambiguous swap, call both base_mcp_balance and rh_mcp_balance first: if only one chain actually holds enough of the source token, use that chain and say which one and why; if neither holds enough, say so plainly instead of quoting a swap the wallet can't cover; if both hold enough, ask the user which chain before proceeding.",
  "- There is NO send/transfer tool for Robinhood Chain - base_mcp_send only moves assets on Base mainnet. If the user asks to send/transfer USDG or any RH catalog stock (NVDA, AAPL, etc.), do NOT call base_mcp_send with that token name hoping it resolves - it will either error or, worse, silently match an unrelated Base token with the same symbol. Tell the user directly that on-chain sends are not yet supported on Robinhood Chain.",
  "- Never state a balance, price, quote, token address, or transaction result from memory or inference - every number in your answer must trace to a tool call you made THIS turn. If you are not sure which chain, token, or address a term refers to, ask or resolve it (rh_token_resolve / base_mcp_resolve) before answering - do not guess and present the guess as fact.",
  "",
  "For deep research: prefer deep_research (multi-stage, saves to vault). Use continueFrom when extending prior reports.",
  "For live web info: use web_search. For market questions: use get_market_data or market_thesis.",
  "Save substantive findings to vault; do not save thin or empty outputs.",
  "",
  "NEVER call ask_finch from this shell. It exists for MCP clients that have no reasoning model of their own - you already are one. Calling it mid-task means asking a second model to think for you, which produces nothing you couldn't write yourself from the data you already have, and repeating it when unsatisfied just burns turns. If a tool's result already answers the question, write the answer yourself.",
  "Do not call the same tool with the same or near-identical arguments more than once in a single answer. If deep_research, a search, or an analysis tool already returned data, synthesize from that - do not re-run it hoping for a different result, and do not chain more tool calls than the question actually needs. Stop calling tools and answer as soon as you have enough to answer well.",
].join("\n");

export type AgentResult = {
  text: string;
  toolCalls: Array<{ name: string }>;
};

export async function runAgent(
  userMessage: string,
  history: ChatMessage[],
  onToolCall: (name: string) => void,
): Promise<AgentResult> {
  const provider     = process.env.FINCH_PROVIDER?.toLowerCase().trim();
  const bankrKey     = process.env.BANKR_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;

  // Explicit override - lets FINCH_PROVIDER=openai win even when BANKR_API_KEY
  // is also set (e.g. as a persistent shell env var), same as llm.ts's callLLM.
  if (provider === "bankr" && bankrKey)         return runBankrLoop(bankrKey, userMessage, history, onToolCall);
  if (provider === "anthropic" && anthropicKey) return runAnthropicLoop(anthropicKey, userMessage, history, onToolCall);
  if (provider === "openai" && openaiKey)       return runOpenAILoop(openaiKey, userMessage, history, onToolCall);

  // Auto-priority
  if (bankrKey)     return runBankrLoop(bankrKey, userMessage, history, onToolCall);
  if (anthropicKey) return runAnthropicLoop(anthropicKey, userMessage, history, onToolCall);
  if (openaiKey)    return runOpenAILoop(openaiKey, userMessage, history, onToolCall);

  // No direct key - proxy through Finch backend. Wallet auto-creates at ~/.finch/wallet.json
  // on first use and signs requests transparently. No account or config needed.
  try {
    return await runConvexProxiedLoop(userMessage, history, onToolCall);
  } catch {
    // Network down or backend unavailable - plain chat fallback
    const text = await callLLM(SYSTEM_PROMPT, userMessage, 1024, history);
    return { text, toolCalls: [] };
  }
}

// ── Anthropic agent loop ─────────────────────────────────────────────────────

function toAnthropicTool(tool: any) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema ?? { type: "object", properties: {} },
  };
}

async function runAnthropicLoop(
  apiKey: string,
  userMessage: string,
  history: ChatMessage[],
  onToolCall: (name: string) => void,
): Promise<AgentResult> {
  const model = process.env.FINCH_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  const tools = ALL_TOOLS.map(toAnthropicTool);
  const toolCalls: Array<{ name: string }> = [];

  const messages: any[] = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  for (let turn = 0; turn < 10; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM_PROMPT, tools, messages }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as any;
    messages.push({ role: "assistant", content: data.content });

    if (data.stop_reason !== "tool_use") {
      const text = (data.content as any[])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      return { text, toolCalls };
    }

    // Execute all tool_use blocks
    const toolResults: any[] = [];
    for (const block of data.content as any[]) {
      if (block.type !== "tool_use") continue;

      let resultText: string;
      try {
        const handler = HANDLER_MAP.get(block.name);
        if (!handler) throw new Error(`Unknown tool: ${block.name}`);
        // Recorded only once the handler is confirmed to exist - an "Unknown
        // tool" miss is a model error, not a real tool execution, and callers
        // reading AgentResult.toolCalls should be able to trust every entry
        // actually ran.
        onToolCall(block.name);
        toolCalls.push({ name: block.name });
        const result = await handler(block.name, block.input ?? {});
        resultText = result?.content?.[0]?.text ?? "Done.";
      } catch (err: any) {
        resultText = `Error: ${err.message}`;
      }

      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Hit the turn cap without a final answer - rather than hand back nothing,
  // force one more call with no tools available so the model has to
  // synthesize a real answer from whatever it already gathered.
  return finishWithoutTools(
    async (msgs) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM_PROMPT, messages: msgs }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return "";
      const data = await res.json() as any;
      return ((data.content as any[]) ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    },
    messages,
    toolCalls,
  );
}

// Shared turn-cap fallback: rather than "Reached max tool iterations." with
// nothing useful, ask the model to synthesize a real answer from whatever
// conversation history (including every tool result so far) it already has,
// with no tools offered so it can't keep deferring.
async function finishWithoutTools(
  call: (messages: any[]) => Promise<string>,
  messages: any[],
  toolCalls: Array<{ name: string }>,
): Promise<AgentResult> {
  try {
    const closingMessages = [
      ...messages,
      { role: "user", content: "Stop calling tools. Summarize what you found above into a direct answer for the user right now." },
    ];
    const text = await call(closingMessages);
    if (text.trim()) return { text, toolCalls };
  } catch { /* fall through to the honest failure message below */ }
  return {
    text: "I gathered some information but ran out of turns before finishing the analysis. Try a narrower question, or ask me to continue from what I found.",
    toolCalls,
  };
}

// ── Convex-proxied Anthropic loop (session token only - platform covers LLM) ──

async function runConvexProxiedLoop(
  userMessage: string,
  history: ChatMessage[],
  onToolCall: (name: string) => void,
): Promise<AgentResult> {
  const model = process.env.FINCH_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  const tools = ALL_TOOLS.map(toAnthropicTool);
  const toolCalls: Array<{ name: string }> = [];

  const messages: any[] = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  for (let turn = 0; turn < 10; turn++) {
    // callConvex handles wallet/session auth automatically; 90s timeout matches the proxy endpoint
    const data = await callConvex("/llm/complete", "POST", {
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    }, "llm_complete", 90_000);

    messages.push({ role: "assistant", content: data.content });

    if (data.stop_reason !== "tool_use") {
      const text = (data.content as any[])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      return { text, toolCalls };
    }

    const toolResults: any[] = [];
    for (const block of data.content as any[]) {
      if (block.type !== "tool_use") continue;

      let resultText: string;
      try {
        const handler = HANDLER_MAP.get(block.name);
        if (!handler) throw new Error(`Unknown tool: ${block.name}`);
        // Recorded only once the handler is confirmed to exist - an "Unknown
        // tool" miss is a model error, not a real tool execution, and callers
        // reading AgentResult.toolCalls should be able to trust every entry
        // actually ran.
        onToolCall(block.name);
        toolCalls.push({ name: block.name });
        const result = await handler(block.name, block.input ?? {});
        resultText = result?.content?.[0]?.text ?? "Done.";
      } catch (err: any) {
        resultText = `Error: ${err.message}`;
      }

      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return finishWithoutTools(
    async (msgs) => {
      const data = await callConvex("/llm/complete", "POST", {
        model, max_tokens: 4096, system: SYSTEM_PROMPT, messages: msgs,
      }, "llm_complete", 90_000);
      return ((data.content as any[]) ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    },
    messages,
    toolCalls,
  );
}

// ── Bankr (OpenAI-compatible) agent loop ─────────────────────────────────────

function toBankrTool(tool: any) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

// Shared tool-calling loop for any OpenAI Chat Completions-compatible
// endpoint (Bankr's LLM gateway and OpenAI itself both speak this format).
// Only the URL, auth header, and model differ per provider.
async function runOpenAICompatibleLoop(
  url: string,
  authHeaders: Record<string, string>,
  model: string,
  providerLabel: string,
  userMessage: string,
  history: ChatMessage[],
  onToolCall: (name: string) => void,
): Promise<AgentResult> {
  const tools = ALL_TOOLS.map(toBankrTool);
  const toolCalls: Array<{ name: string }> = [];

  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  for (let turn = 0; turn < 10; turn++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ model, messages, tools, max_tokens: 4096 }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${providerLabel} ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error(`Empty response from ${providerLabel}`);

    messages.push(choice);

    if (!choice.tool_calls?.length) {
      return { text: choice.content ?? "", toolCalls };
    }

    for (const call of choice.tool_calls) {
      let resultText: string;
      try {
        const args = JSON.parse(call.function.arguments ?? "{}");
        const handler = HANDLER_MAP.get(call.function.name);
        if (!handler) throw new Error(`Unknown tool: ${call.function.name}`);
        // Recorded only once the handler is confirmed to exist - see the
        // matching comment in runAnthropicLoop/runConvexProxiedLoop.
        onToolCall(call.function.name);
        toolCalls.push({ name: call.function.name });
        const result = await handler(call.function.name, args);
        resultText = result?.content?.[0]?.text ?? "Done.";
      } catch (err: any) {
        resultText = `Error: ${err.message}`;
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }

  return finishWithoutTools(
    async (msgs) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ model, messages: msgs, max_tokens: 4096 }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return "";
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content ?? "";
    },
    messages,
    toolCalls,
  );
}

async function runBankrLoop(
  apiKey: string,
  userMessage: string,
  history: ChatMessage[],
  onToolCall: (name: string) => void,
): Promise<AgentResult> {
  const model = process.env.FINCH_MODEL ?? process.env.BANKR_MODEL ?? "claude-haiku-4-5-20251001";
  return runOpenAICompatibleLoop(
    "https://llm.bankr.bot/v1/chat/completions",
    { "X-API-Key": apiKey },
    model,
    "Bankr",
    userMessage,
    history,
    onToolCall,
  );
}

// Same OPENAI_BASE_URL override as llm.ts's callOpenAI - lets tool-calling
// route to a self-hosted OpenAI-compatible gateway too.
function openAiChatUrl(): string {
  const base = process.env.OPENAI_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}/chat/completions` : "https://api.openai.com/v1/chat/completions";
}

async function runOpenAILoop(
  apiKey: string,
  userMessage: string,
  history: ChatMessage[],
  onToolCall: (name: string) => void,
): Promise<AgentResult> {
  const model = process.env.FINCH_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  return runOpenAICompatibleLoop(
    openAiChatUrl(),
    { Authorization: `Bearer ${apiKey}` },
    model,
    "OpenAI",
    userMessage,
    history,
    onToolCall,
  );
}
