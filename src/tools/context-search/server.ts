/**
 * stdio MCP server exposing Sherlock's shared-context retrieval tools.
 *
 * The runtime is remote-only: `context.*` calls always go through
 * `SHERLOCK_CONTEXT_API_URL`, which is the single source of retrieval truth for
 * Sherlock-Front, Sherlock-Researcher, and the admin surfaces.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv, optionalEnv } from "../../shared/env.js";
import { STATE_DIR } from "../../shared/paths.js";
import { createLogger } from "../../shared/logger.js";
import {
  BriefInputSchema,
  FollowupsInputSchema,
  SearchInputSchema,
  StatsInputSchema,
} from "../../retrieval/contracts.js";
import { remoteBrief, remoteFollowups, remoteSearch, remoteStats } from "../../retrieval/api-client.js";

const log = createLogger("mcp:context-search");

const DIAG = resolve(STATE_DIR, "mcp-context-search.log");
function diag(line: string): void {
  try {
    mkdirSync(dirname(DIAG), { recursive: true });
    appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch { /* ignore */ }
}

function requireRemoteContextApi(): string {
  const url = optionalEnv("SHERLOCK_CONTEXT_API_URL");
  if (!url) {
    throw new Error("SHERLOCK_CONTEXT_API_URL is required for Sherlock runtime retrieval");
  }
  return url;
}

async function main(): Promise<void> {
  loadEnv();
  const remoteApiUrl = requireRemoteContextApi();

  try {
    const fs = await import("node:fs");
    fs.appendFileSync(
      "/tmp/sherlock-mcp-context.log",
      `${new Date().toISOString()} SPAWN pid=${process.pid} cwd=${process.cwd()} HOME=${process.env["HOME"] ?? "<unset>"} SHERLOCK_CONTEXT_API_URL=${remoteApiUrl} STATE_DIR=${STATE_DIR}\n`,
    );
  } catch { /* ignore */ }
  diag(`SPAWN pid=${process.pid} cwd=${process.cwd()} HOME=${process.env["HOME"] ?? "<unset>"} api=${remoteApiUrl}`);

  const server = new Server(
    {
      name: "sherlock-context-search",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "context.search",
        description: "Search Sherlock's shared indexed corpus via the configured retrieval API.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free-text search query." },
            filters: {
              type: "object",
              properties: {
                sources: { type: "array", items: { type: "string", enum: ["youtube", "substack", "twitter-people", "twitter-bookmarks", "blog"] } },
                source_ids: { type: "array", items: { type: "string" } },
                authors: { type: "array", items: { type: "string" } },
                since: { type: "string", description: "ISO date YYYY-MM-DD" },
                until: { type: "string", description: "ISO date YYYY-MM-DD" },
                language: { type: "string" },
              },
            },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
          required: ["query"],
        },
      },
      {
        name: "context.stats",
        description: "Return shared corpus totals, per-source counts, and freshness fields.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "context.brief",
        description: "Summarize what the shared indexed corpus says about a topic, including coverage shape, gaps, contradictions, and recommended angles for a follow-up question or research handoff.",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            user_question: { type: "string" },
            filters: {
              type: "object",
              properties: {
                sources: { type: "array", items: { type: "string", enum: ["youtube", "substack", "twitter-people", "twitter-bookmarks", "blog"] } },
                source_ids: { type: "array", items: { type: "string" } },
                authors: { type: "array", items: { type: "string" } },
                since: { type: "string" },
                until: { type: "string" },
                language: { type: "string" },
              },
            },
            limit: { type: "integer", minimum: 3, maximum: 20, default: 8 },
          },
          required: ["topic"],
        },
      },
      {
        name: "context.followups",
        description: "Generate pointed, evidence-backed follow-up questions and a handoff note grounded in the shared indexed corpus.",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            user_question: { type: "string" },
            filters: {
              type: "object",
              properties: {
                sources: { type: "array", items: { type: "string", enum: ["youtube", "substack", "twitter-people", "twitter-bookmarks", "blog"] } },
                source_ids: { type: "array", items: { type: "string" } },
                authors: { type: "array", items: { type: "string" } },
                since: { type: "string" },
                until: { type: "string" },
                language: { type: "string" },
              },
            },
            limit: { type: "integer", minimum: 3, maximum: 20, default: 8 },
          },
          required: ["topic"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;

    try {
      if (name === "context.search") {
        const args = SearchInputSchema.parse(rawArgs ?? {});
        const result = await remoteSearch(args);
        diag(`SEARCH query=${JSON.stringify(args.query)} filters=${JSON.stringify(args.filters ?? {})} hits=${result.hits.length}`);
        log.info({ query: args.query, filters: args.filters, hits: result.hits.length, api: remoteApiUrl }, "search");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === "context.stats") {
        StatsInputSchema.parse(rawArgs ?? {});
        const stats = await remoteStats({});
        diag(`STATS total=${stats.total} bySource=${JSON.stringify(stats.bySource)}`);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      }

      if (name === "context.brief") {
        const args = BriefInputSchema.parse(rawArgs ?? {});
        const result = await remoteBrief(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === "context.followups") {
        const args = FollowupsInputSchema.parse(rawArgs ?? {});
        const result = await remoteFollowups(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, err: msg, api: remoteApiUrl }, "tool error");
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ api: remoteApiUrl }, "context-search MCP server connected on stdio");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "mcp server crashed");
  process.exit(1);
});
