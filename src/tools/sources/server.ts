/**
 * Sources MCP — exposed to Sherlock-Front. Lets the user add / list / remove
 * sources by pasting a URL into iMessage.
 *
 * Tools:
 *   - sources.add(url)              — paste-a-URL onboarding (uses url-resolver)
 *   - sources.list()                — what's currently tracked
 *   - sources.remove(type, sourceId) — remove a tracked source
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { resolveAndAdd, listAllSources, removeSource } from "../../shared/url-resolver.js";
import { STATE_DIR } from "../../shared/paths.js";
import { loadEnv } from "../../shared/env.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:sources");

const DIAG = resolve(STATE_DIR, "mcp-sources.log");
function diag(line: string): void {
  try { mkdirSync(dirname(DIAG), { recursive: true }); appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`, "utf-8"); } catch { /* ignore */ }
}

const AddInput = z.object({
  url: z.string().min(1).describe("Any URL: YouTube channel/handle, x.com/<handle>, <name>.substack.com, blog homepage, or direct RSS/Atom feed URL."),
});

const RemoveInput = z.object({
  type: z.enum(["youtube", "substack", "twitter-people", "twitter-bookmarks", "blog"]),
  source_id: z.string(),
});

async function main(): Promise<void> {
  loadEnv();
  diag(`SPAWN pid=${process.pid}`);

  const server = new Server(
    { name: "sherlock-sources", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "sources.add",
        description: "Paste any source URL — Sherlock figures out the type, resolves canonical IDs, dedupes, validates, patches sources.json, and commits to sherlock-context. Returns { ok, status:'added'|'duplicate'|'error', type, sourceId, name, message, warnings? }. Use this when the user says 'add this source: <url>' or pastes a URL with intent to subscribe.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: AddInput.shape.url.description },
          },
          required: ["url"],
        },
      },
      {
        name: "sources.list",
        description: "List all currently-tracked sources across all types. Use this to answer 'what are you tracking?' / 'what are my sources?'.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "sources.remove",
        description: "Remove a tracked source by canonical id. Use sources.list first to find the right id.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["youtube", "substack", "twitter-people", "twitter-bookmarks", "blog"] },
            source_id: { type: "string" },
          },
          required: ["type", "source_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    try {
      if (name === "sources.add") {
        const a = AddInput.parse(rawArgs ?? {});
        diag(`ADD url=${a.url}`);
        const result = await resolveAndAdd(a.url);
        diag(`ADD_RESULT ${JSON.stringify(result)}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "sources.list") {
        const rows = listAllSources();
        diag(`LIST count=${rows.length}`);
        return { content: [{ type: "text", text: JSON.stringify({ sources: rows, total: rows.length }, null, 2) }] };
      }

      if (name === "sources.remove") {
        const a = RemoveInput.parse(rawArgs ?? {});
        const result = await removeSource(a.type, a.source_id);
        diag(`REMOVE type=${a.type} id=${a.source_id} result=${JSON.stringify(result)}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
  log.info("sources MCP server connected");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "sources MCP crashed");
  process.exit(1);
});
