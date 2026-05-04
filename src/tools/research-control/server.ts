/**
 * Research-control MCP — Sherlock-Front's interface to the bridge's job manager.
 *
 * Implementation: thin HTTP client to the bridge. The bridge is the single
 * source of truth for the in-memory researcher registry; this MCP just
 * marshals the tool calls. Pattern keeps state consistent across the
 * bridge process and the spawned MCP child processes.
 *
 * Tools (Front-only — Researcher does NOT get this MCP):
 *   - research.start({ topic, dimensions?, time_horizon?, sources_focus?, urgency?, notes? })
 *       Non-blocking. Returns { research_id, queue_position, eta_minutes, active_count }.
 *   - research.list_active()
 *   - research.cancel({ research_id })
 *
 * The MCP gets `chat_guid` from env (`SHERLOCK_DEFAULT_CHAT_GUID`, set by
 * the bridge when spawning Front).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { STATE_DIR } from "../../shared/paths.js";
import { loadEnv, optionalEnv } from "../../shared/env.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:research-control");

const DIAG = resolve(STATE_DIR, "mcp-research-control.log");
function diag(line: string): void {
  try { mkdirSync(dirname(DIAG), { recursive: true }); appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`, "utf-8"); } catch { /* ignore */ }
}

const BRIDGE = `http://127.0.0.1:${optionalEnv("BRIDGE_PORT") ?? "18790"}`;

async function bridge(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${BRIDGE}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`bridge ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const StartInput = z.object({
  topic: z.string().min(3),
  dimensions: z.array(z.string()).optional(),
  time_horizon: z.string().optional(),
  sources_focus: z.array(z.string()).optional(),
  urgency: z.enum(["low", "normal", "high"]).default("normal"),
  notes: z.string().optional(),
  chat_guid: z.string().optional(),
  parent_msg_id: z.string().optional(),
});
const CancelInput = z.object({ research_id: z.number().int() });

async function main(): Promise<void> {
  loadEnv();
  const defaultChatGuid = optionalEnv("SHERLOCK_DEFAULT_CHAT_GUID");
  diag(`SPAWN pid=${process.pid} default_chat=${defaultChatGuid ?? "<unset>"} bridge=${BRIDGE}`);

  const server = new Server(
    { name: "sherlock-research-control", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "research.start",
        description: "Spawn a Sherlock-Researcher sub-agent that produces a deep analytical report on the topic and writes it as a Markdown file to the user's Obsidian vault. Non-blocking — returns immediately with a research_id and queue position. Capped at 3 concurrent; over-cap requests are queued FIFO. The Researcher will DM the user via iMessage when the report is ready.",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Concise research topic. The Researcher will use this to drive the analysis." },
            dimensions: { type: "array", items: { type: "string" }, description: "Optional explicit dimensions to analyze." },
            time_horizon: { type: "string", description: "e.g. 'last 6 months', 'since Apr 2026'" },
            sources_focus: { type: "array", items: { type: "string" }, description: "Optional preferred sources: ['youtube','substack','twitter-people','web']." },
            urgency: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
            notes: { type: "string", description: "Anything else the user said about how they want this approached." },
            chat_guid: { type: "string", description: defaultChatGuid ? `Defaults to ${defaultChatGuid}` : "Required" },
            parent_msg_id: { type: "string" },
          },
          required: defaultChatGuid ? ["topic"] : ["topic", "chat_guid"],
        },
      },
      {
        name: "research.list_active",
        description: "List currently-running and queued researcher sub-agents. Use to truthfully answer 'what are you working on?'.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "research.cancel",
        description: "Cancel a running researcher by its research_id.",
        inputSchema: {
          type: "object",
          properties: { research_id: { type: "integer" } },
          required: ["research_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    try {
      if (name === "research.start") {
        const a = StartInput.parse({
          ...(rawArgs ?? {}),
          chat_guid: (rawArgs as Record<string, unknown> | undefined)?.["chat_guid"] ?? defaultChatGuid,
        });
        if (!a.chat_guid) throw new Error("chat_guid required (no SHERLOCK_DEFAULT_CHAT_GUID env)");
        const result = await bridge("POST", "/research/start", a);
        diag(`START result=${JSON.stringify(result)}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "research.list_active") {
        const result = (await bridge("GET", "/research/active")) as { ok: boolean; active: unknown[] };
        diag(`LIST count=${result.active?.length ?? 0}`);
        return { content: [{ type: "text", text: JSON.stringify(result.active, null, 2) }] };
      }

      if (name === "research.cancel") {
        const a = CancelInput.parse(rawArgs ?? {});
        const result = await bridge("POST", `/research/${a.research_id}/cancel`);
        diag(`CANCEL research_id=${a.research_id} result=${JSON.stringify(result)}`);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }

      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag(`ERROR tool=${name} err=${msg}`);
      log.error({ tool: name, err: msg }, "tool error");
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("research-control MCP connected (bridge proxy)");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "research-control crashed");
  process.exit(1);
});
