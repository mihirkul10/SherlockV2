/**
 * Sherlock-Front runner.
 *
 * Calls the Anthropic Messages API directly (NOT the Cursor SDK).
 *
 * Why direct: the Cursor SDK injects a "you are a Cursor coding assistant"
 * system prompt that the model treats as authoritative and refuses to leave,
 * even when our prompt explicitly establishes the Sherlock persona. The
 * Cursor SDK exposes no public override for that system prompt. So Front
 * uses the Anthropic SDK + a tool-use loop, with a small adapter that
 * proxies Anthropic tool_use calls into our existing MCP servers.
 *
 * Sherlock-Researcher remains on the Cursor SDK.
 *
 * Per-turn flow:
 *   1. Pull recent conversation from conversations.sqlite.
 *   2. Build the Anthropic messages array (system prompt + history + new user msg).
 *   3. Connect to all Front-side MCPs and enumerate their tools.
 *   4. Loop: Anthropic.messages.create → if stop_reason='tool_use', execute every
 *      tool_use block via the MCP adapter, append tool_result blocks, repeat.
 *      If stop_reason='end_turn' or 'max_tokens', collect final text and return.
 *   5. Always close MCP transports.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../shared/paths.js";
import { requireEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { recentMessages, type StoredMessage } from "./conversation.js";
import { connectMcps, type ConnectedMcps, type McpConfig } from "./mcp-adapter.js";

const log = createLogger("bridge:front-runner");

const SYSTEM_PROMPT_PATH    = resolve(PROJECT_ROOT, "src", "prompts", "front.system.md");
const CONTEXT_SEARCH_MCP    = resolve(PROJECT_ROOT, "src", "tools", "context-search",   "server.ts");
const RESEARCH_CONTROL_MCP  = resolve(PROJECT_ROOT, "src", "tools", "research-control", "server.ts");
const SOURCES_MCP           = resolve(PROJECT_ROOT, "src", "tools", "sources",          "server.ts");

const MODEL_ID = "claude-haiku-4-5";          // Latest Haiku (matches what we used via Cursor SDK).
const MAX_TURNS_IN_TOOL_LOOP = 8;             // Safety net: cap tool_use ↔ tool_result iterations.
const MAX_OUTPUT_TOKENS = 1500;               // Front replies cap. Plenty for ≤4 sentences.

let cachedSystemPrompt: string | null = null;
function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  cachedSystemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  return cachedSystemPrompt;
}

// ─── Conversation history → Anthropic messages ─────────────────────────

type AnthropicMsg = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

function historyToMessages(history: StoredMessage[]): AnthropicMsg[] {
  // Filter out system rows (they came from older internal events) and map
  // user/assistant roles directly. Empty texts are dropped.
  const out: AnthropicMsg[] = [];
  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.text || !m.text.trim()) continue;
    out.push({ role: m.role, content: m.text });
  }
  return out;
}

// ─── Public API ────────────────────────────────────────────────────────

export interface FrontTurnResult {
  reply: string;
  agentId: string;
  runId: string;
  status: string;
  durationMs: number;
}

export async function runFrontTurn(opts: {
  chat_guid: string;
  userText: string;
}): Promise<FrontTurnResult> {
  const t0 = Date.now();
  const apiKey = requireEnv("ANTHROPIC_API_KEY");
  const parallelKey = requireEnv("PARALLEL_API_KEY");

  const history = recentMessages(opts.chat_guid, 12);
  const systemPrompt = loadSystemPrompt();

  // Build messages: prior turns + the new user message.
  const messages: AnthropicMsg[] = [
    ...historyToMessages(history),
    { role: "user", content: opts.userText },
  ];

  // Per-turn injected env so child MCPs know which chat to attribute
  // research jobs to (research.start uses SHERLOCK_DEFAULT_CHAT_GUID).
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SHERLOCK_DEFAULT_CHAT_GUID: opts.chat_guid,
  };

  const mcpConfigs: Record<string, McpConfig> = {
    "context-search":   { command: "npx", args: ["tsx", CONTEXT_SEARCH_MCP],   env: childEnv },
    "research-control": { command: "npx", args: ["tsx", RESEARCH_CONTROL_MCP], env: childEnv },
    "sources":          { command: "npx", args: ["tsx", SOURCES_MCP],          env: childEnv },
    "parallel-search":  {
      url: "https://search-mcp.parallel.ai/mcp",
      // Parallel's MCP server (unlike its REST API) requires Bearer auth.
      headers: { "Authorization": `Bearer ${parallelKey}` },
    },
  };

  log.info(
    { chat_guid: opts.chat_guid, historyLen: history.length, userTextLen: opts.userText.length, model: MODEL_ID },
    "spawning Sherlock-Front via Anthropic API"
  );

  let mcps: ConnectedMcps | undefined;
  const runId = `front-${t0.toString(36)}`;
  try {
    mcps = await connectMcps(mcpConfigs);
    log.info({ toolCount: mcps.tools.length }, "MCPs connected");

    const client = new Anthropic({ apiKey });

    // ─── Tool-use loop ────────────────────────────────────────────

    let stopReason: string | null = null;
    let finalText = "";

    for (let turn = 0; turn < MAX_TURNS_IN_TOOL_LOOP; turn++) {
      const resp = await client.messages.create({
        model: MODEL_ID,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: messages as Anthropic.MessageParam[],
        tools: mcps.tools,
      });

      stopReason = resp.stop_reason ?? null;

      // Append assistant turn (preserving content blocks for the next request).
      messages.push({
        role: "assistant",
        content: resp.content as unknown as Array<Record<string, unknown>>,
      });

      if (stopReason !== "tool_use") {
        // Collect final text blocks.
        for (const block of resp.content) {
          if (block.type === "text") finalText += block.text;
        }
        break;
      }

      // tool_use stop: execute every tool_use block in this turn, accumulate
      // tool_result blocks, append as a single user message.
      const toolResults: Array<Record<string, unknown>> = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const callT0 = Date.now();
        let resultText: string;
        let isError = false;
        try {
          resultText = await mcps.callTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        } catch (err) {
          isError = true;
          resultText = `[tool error] ${err instanceof Error ? err.message : String(err)}`;
        }
        log.info(
          { tool: block.name, ms: Date.now() - callT0, ok: !isError, resultChars: resultText.length },
          "tool call"
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultText,
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    if (!finalText.trim()) {
      finalText = "(I ran out of room — try asking again, or be more specific?)";
    }

    const durationMs = Date.now() - t0;
    log.info(
      { runId, stopReason, replyChars: finalText.length, durationMs },
      "front turn complete"
    );

    return {
      reply: finalText.trim(),
      agentId: `anthropic:${MODEL_ID}`,
      runId,
      status: stopReason === "end_turn" || stopReason === "max_tokens" ? "finished" : `stop:${stopReason ?? "unknown"}`,
      durationMs,
    };
  } finally {
    if (mcps) {
      await mcps.close().catch((err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "MCP close failed")
      );
    }
  }
}
