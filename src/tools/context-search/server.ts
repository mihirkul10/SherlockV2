/**
 * stdio MCP server exposing Sherlock's context retrieval tools.
 *
 * Modes:
 *   - shared mode (preferred): forwards requests to SHERLOCK_CONTEXT_API_URL
 *   - local fallback mode: reads the legacy local SQLite FTS5 index directly
 *
 * Tools:
 *   - context.search(query, filters?, limit?)
 *   - context.stats()
 *   - context.brief(topic, user_question?, filters?, limit?)
 *   - context.followups(topic, user_question?, filters?, limit?)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { search, getStats, type SearchFilters as LegacySearchFilters, type SearchHit as LegacySearchHit } from "../../index/sqlite-fts.js";
import { loadEnv } from "../../shared/env.js";
import { STATE_DIR } from "../../shared/paths.js";
import { createLogger } from "../../shared/logger.js";
import {
  BriefInputSchema,
  FollowupsInputSchema,
  SearchInputSchema,
  StatsInputSchema,
  type ContextStats,
  type SearchHit,
} from "../../retrieval/contracts.js";
import { buildBrief, buildFollowups } from "../../retrieval/planner.js";
import { hasRemoteContextApi, remoteBrief, remoteFollowups, remoteSearch, remoteStats } from "../../retrieval/api-client.js";

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

function mapLegacyHit(hit: LegacySearchHit): SearchHit {
  const lexicalScore = 1 / (1 + Math.abs(hit.rank));
  return {
    title: hit.title,
    author: hit.author,
    source: hit.source,
    source_id: hit.source_id,
    content_id: hit.content_id,
    url: hit.url,
    published_at: hit.published_at,
    snippet: hit.snippet,
    path: hit.path,
    score: lexicalScore,
    lexical_score: lexicalScore,
    semantic_score: 0,
  };
}

async function localSearch(args: {
  query: string;
  filters?: LegacySearchFilters;
  limit: number;
}): Promise<{ hits: SearchHit[]; total_returned: number }> {
  const hits = search(args.query, args.filters ?? {}, args.limit).map(mapLegacyHit);
  return { hits, total_returned: hits.length };
}

function localStats(): ContextStats {
  const stats = getStats();
  return {
    total: stats.total,
    bySource: stats.bySource,
  };
}

async function preferredSearch(
  remote: boolean,
  args: { query: string; filters?: LegacySearchFilters; limit: number },
): Promise<{ hits: SearchHit[]; total_returned: number }> {
  if (!remote) return localSearch(args);
  try {
    return await remoteSearch(args);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "remote context.search failed; falling back to local index");
    return localSearch(args);
  }
}

async function preferredStats(remote: boolean): Promise<ContextStats> {
  if (!remote) return localStats();
  try {
    return await remoteStats({});
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "remote context.stats failed; falling back to local index");
    return localStats();
  }
}

async function preferredBrief(
  remote: boolean,
  args: { topic: string; user_question?: string; filters?: LegacySearchFilters; limit: number },
): Promise<unknown> {
  const retrievalQuery = args.user_question ? `${args.topic} ${args.user_question}` : args.topic;
  if (remote) {
    try {
      return await remoteBrief(args);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "remote context.brief failed; falling back to local index");
    }
  }
  return buildBrief(
    args.topic,
    (await localSearch({
      query: retrievalQuery,
      filters: args.filters ?? {},
      limit: args.limit,
    })).hits,
    localStats(),
  );
}

async function preferredFollowups(
  remote: boolean,
  args: { topic: string; user_question?: string; filters?: LegacySearchFilters; limit: number },
): Promise<unknown> {
  const retrievalQuery = args.user_question ? `${args.topic} ${args.user_question}` : args.topic;
  if (remote) {
    try {
      return await remoteFollowups(args);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "remote context.followups failed; falling back to local index");
    }
  }
  const searchResult = await localSearch({
    query: retrievalQuery,
    filters: args.filters ?? {},
    limit: args.limit,
  });
  const brief = buildBrief(args.topic, searchResult.hits, localStats());
  return buildFollowups(args.topic, searchResult.hits, brief);
}

async function main(): Promise<void> {
  loadEnv();
  const { INDEX_DB, PROJECT_ROOT, STATE_DIR } = await import("../../shared/paths.js");
  const remote = hasRemoteContextApi();
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
        description: "Search Sherlock's indexed context corpus. In shared mode this uses the cloud-maintained index; otherwise it falls back to the local SQLite corpus index.",
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
        description: "Return corpus totals, per-source counts, and freshness fields when available.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "context.brief",
        description: "Summarize what the indexed corpus says about a topic, including coverage shape, gaps, contradictions, and recommended angles for a follow-up question or research handoff.",
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
        description: "Generate pointed, evidence-backed follow-up questions and a handoff note the backend researcher can use directly.",
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
        const result = await preferredSearch(remote, {
          query: args.query,
          filters: (args.filters ?? {}) as LegacySearchFilters,
          limit: args.limit,
        });
        diag(`SEARCH query=${JSON.stringify(args.query)} filters=${JSON.stringify(args.filters ?? {})} hits=${result.hits.length}`);
        log.info({ query: args.query, filters: args.filters, hits: result.hits.length, remote }, "search");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === "context.stats") {
        StatsInputSchema.parse(rawArgs ?? {});
        const stats = await preferredStats(remote);
        diag(`STATS total=${stats.total} bySource=${JSON.stringify(stats.bySource)}`);
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
        };
      }

      if (name === "context.brief") {
        const args = BriefInputSchema.parse(rawArgs ?? {});
        const result = await preferredBrief(remote, {
          topic: args.topic,
          user_question: args.user_question,
          filters: (args.filters ?? {}) as LegacySearchFilters,
          limit: args.limit,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === "context.followups") {
        const args = FollowupsInputSchema.parse(rawArgs ?? {});
        const result = await preferredFollowups(remote, {
          topic: args.topic,
          user_question: args.user_question,
          filters: (args.filters ?? {}) as LegacySearchFilters,
          limit: args.limit,
        });
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
      log.error({ tool: name, err: msg }, "tool error");
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ remote }, "context-search MCP server connected on stdio");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "mcp server crashed");
  process.exit(1);
});
