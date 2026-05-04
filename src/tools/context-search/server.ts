/**
 * stdio MCP server exposing `context.search` over the local sherlock-context
 * SQLite FTS5 index. Wired into Sherlock-Front and Sherlock-Researcher local
 * agents via the SDK's `mcpServers` config.
 *
 * Tools:
 *   - context.search(query, filters?, limit?) → SearchHit[]
 *   - context.stats() → { total, bySource }
 *
 * Run as: node dist/tools/context-search/server.js
 *      or: tsx src/tools/context-search/server.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { search, getStats, type SearchFilters } from "../../index/sqlite-fts.js";
import { loadEnv } from "../../shared/env.js";
import { STATE_DIR } from "../../shared/paths.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:context-search");

// Diagnostic file log so we can see when the MCP is spawned and what queries
// it receives, even when its stdout is consumed by the SDK's MCP transport.
const DIAG = resolve(STATE_DIR, "mcp-context-search.log");
function diag(line: string): void {
  try {
    mkdirSync(dirname(DIAG), { recursive: true });
    appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch { /* ignore */ }
}

const SearchInputSchema = z.object({
  query: z.string().min(1).describe("Free-text search query. Words are AND'd; FTS5 stemming and tokenization are applied."),
  filters: z.object({
    sources: z.array(z.enum(["youtube", "substack", "twitter-people", "twitter-bookmarks", "blog"])).optional()
      .describe("Restrict to one or more source types."),
    source_ids: z.array(z.string()).optional()
      .describe("Restrict to specific channel IDs / handles / subdomains. e.g. ['UCM1guA1E-RHLO2OyfQPOkEQ'] for Stripe."),
    authors: z.array(z.string()).optional()
      .describe("Restrict to specific authors / channel display names."),
    since: z.string().optional()
      .describe("ISO date inclusive lower bound on published_at, e.g. '2026-04-01'"),
    until: z.string().optional()
      .describe("ISO date inclusive upper bound on published_at."),
    language: z.string().optional()
      .describe("ISO 639-1 language code, e.g. 'en'."),
  }).optional(),
  limit: z.number().int().min(1).max(50).default(10)
    .describe("Max hits to return. Default 10."),
});

const StatsInputSchema = z.object({});

async function main(): Promise<void> {
  loadEnv();
  const { INDEX_DB, PROJECT_ROOT, STATE_DIR } = await import("../../shared/paths.js");
  // Belt-and-suspenders diag write to a known-absolute /tmp path so we can rule
  // out cwd / HOME issues even if the in-state diag write silently fails.
  try {
    const fs = await import("node:fs");
    fs.appendFileSync("/tmp/sherlock-mcp-context.log",
      `${new Date().toISOString()} SPAWN pid=${process.pid} cwd=${process.cwd()} HOME=${process.env["HOME"] ?? "<unset>"} SHERLOCK_PROJECT_ROOT=${process.env["SHERLOCK_PROJECT_ROOT"] ?? "<unset>"} INDEX_DB=${INDEX_DB} PROJECT_ROOT=${PROJECT_ROOT} STATE_DIR=${STATE_DIR}\n`);
  } catch { /* ignore */ }
  diag(`SPAWN pid=${process.pid} cwd=${process.cwd()} HOME=${process.env["HOME"] ?? "<unset>"} INDEX_DB=${INDEX_DB}`);

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
        description: "Search Sherlock's local context corpus (YouTube transcripts, Substack posts, Twitter posts, blog articles) via SQLite FTS5. Returns ranked excerpts with metadata. Use filters to scope by source type, channel, author, date range.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: SearchInputSchema.shape.query.description },
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
        description: "Return total document count and breakdown by source. Use to check whether the corpus is ready before searching.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;

    try {
      if (name === "context.search") {
        const args = SearchInputSchema.parse(rawArgs ?? {});
        const hits = search(args.query, (args.filters ?? {}) as SearchFilters, args.limit);
        diag(`SEARCH query=${JSON.stringify(args.query)} filters=${JSON.stringify(args.filters ?? {})} hits=${hits.length}`);
        log.info({ query: args.query, filters: args.filters, hits: hits.length }, "search");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  hits: hits.map((h) => ({
                    title: h.title,
                    author: h.author,
                    source: h.source,
                    url: h.url,
                    published_at: h.published_at,
                    snippet: h.snippet,
                    rank: Number(h.rank.toFixed(3)),
                    path: h.path,
                  })),
                  total_returned: hits.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === "context.stats") {
        StatsInputSchema.parse(rawArgs ?? {});
        const stats = getStats();
        diag(`STATS total=${stats.total} bySource=${JSON.stringify(stats.bySource)}`);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      }

      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: name, err: msg }, "tool error");
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("context-search MCP server connected on stdio");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "mcp server crashed");
  process.exit(1);
});
