/**
 * Sherlock-Front runner.
 *
 * Spawns a fresh local SDK agent per iMessage turn (hybrid memory model:
 * conversation history is loaded from conversations.sqlite and rendered
 * into the prompt). The agent has these MCP tools:
 *   - context.search   (local SQLite FTS5 over sherlock-context)
 *   - parallel-search  (Parallel Search MCP, quick web)
 *
 * The bluebubbles-out MCP for in-flight progress messages will be added in
 * M3. For now Front only sends one final reply per turn.
 */

import { Agent, type SDKAgent } from "@cursor/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../shared/paths.js";
import { requireEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { recentMessages, type StoredMessage } from "./conversation.js";

const log = createLogger("bridge:front-runner");

const SYSTEM_PROMPT_PATH    = resolve(PROJECT_ROOT, "src", "prompts", "front.system.md");
const CONTEXT_SEARCH_MCP    = resolve(PROJECT_ROOT, "src", "tools", "context-search",   "server.ts");
const RESEARCH_CONTROL_MCP  = resolve(PROJECT_ROOT, "src", "tools", "research-control", "server.ts");
const SOURCES_MCP           = resolve(PROJECT_ROOT, "src", "tools", "sources",          "server.ts");

let cachedSystemPrompt: string | null = null;
function loadSystemPrompt(): string {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  cachedSystemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  return cachedSystemPrompt;
}

function renderHistory(history: StoredMessage[]): string {
  if (history.length === 0) return "(no prior conversation)";
  return history.map((m) => {
    const tag = m.role === "user" ? "USER" : m.role === "assistant" ? "SHERLOCK" : "SYSTEM";
    const ago = Math.round((Date.now() - m.ts) / 60_000);
    return `[${tag} ${ago}m ago] ${m.text}`;
  }).join("\n\n");
}

function buildTurnPrompt(history: StoredMessage[], userText: string): string {
  return [
    loadSystemPrompt(),
    "",
    "# Recent conversation",
    renderHistory(history),
    "",
    "# New user message",
    userText,
  ].join("\n");
}

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
  const apiKey = requireEnv("CURSOR_API_KEY");

  // Pull recent transcript (excludes the brand-new user message — caller appends after this).
  const history = recentMessages(opts.chat_guid, 12);
  const prompt = buildTurnPrompt(history, opts.userText);

  log.info(
    { chat_guid: opts.chat_guid, historyLen: history.length, promptChars: prompt.length },
    "spawning Sherlock-Front local agent"
  );

  let agent: SDKAgent | undefined;
  try {
    // Inject the chat_guid into research-control's spawn env so research.start
    // doesn't need it as an argument every time.
    const childEnv = {
      ...process.env,
      SHERLOCK_DEFAULT_CHAT_GUID: opts.chat_guid,
    };
    agent = await Agent.create({
      apiKey,
      model: { id: "composer-2" },
      local: { cwd: PROJECT_ROOT, settingSources: [] },
      mcpServers: {
        "context-search": {
          command: "npx",
          args: ["tsx", CONTEXT_SEARCH_MCP],
          env: childEnv,
        },
        "research-control": {
          command: "npx",
          args: ["tsx", RESEARCH_CONTROL_MCP],
          env: childEnv,
        },
        "sources": {
          command: "npx",
          args: ["tsx", SOURCES_MCP],
          env: childEnv,
        },
        // Parallel-search MCP (HTTP transport).
        "parallel-search": {
          url: "https://search-mcp.parallel.ai/mcp",
          headers: {
            "x-api-key": requireEnv("PARALLEL_API_KEY"),
          },
        },
      },
    });

    const run = await agent.send(prompt);
    log.info({ agentId: agent.agentId, runId: run.id }, "send acknowledged");

    let reply = "";
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") reply += block.text;
        }
      }
    }
    const result = await run.wait();
    const durationMs = Date.now() - t0;
    log.info(
      { runId: run.id, status: result.status, replyChars: reply.length, durationMs },
      "front turn complete"
    );

    return {
      reply: reply.trim() || "(no reply)",
      agentId: agent.agentId,
      runId: run.id,
      status: result.status,
      durationMs,
    };
  } finally {
    if (agent) {
      await agent[Symbol.asyncDispose]().catch((err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "agent dispose failed")
      );
    }
  }
}
