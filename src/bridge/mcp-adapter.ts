/**
 * MCP-to-Anthropic-tools adapter.
 *
 * Spawns the SherlockV2 MCP servers (stdio + HTTP), enumerates each server's
 * tools via `listTools()`, and exposes them in the shape Anthropic's
 * Messages API expects:
 *
 *   tools: Array<{ name, description, input_schema }>
 *
 * Anthropic tool names must match `[a-zA-Z0-9_-]{1,64}` and must be unique
 * across all tools in a single Messages call. Many of our MCPs ship tools
 * named with dots (e.g. `context.search`). We namespace + sanitize them as
 * `<server>__<tool_with_dots_replaced>` and remember the mapping so we can
 * route `tool_use` blocks back to the correct MCP.
 *
 * Used by Sherlock-Front (which calls Anthropic API directly because the
 * Cursor SDK forces a "you are a Cursor coding assistant" persona that
 * overrides our system prompt). Sherlock-Researcher remains on Cursor SDK.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("bridge:mcp-adapter");

// ─── Types ────────────────────────────────────────────────────────────

export type StdioMcpConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};
export type HttpMcpConfig = {
  url: string;
  headers?: Record<string, string>;
};
export type McpConfig = StdioMcpConfig | HttpMcpConfig;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
  };
}

export interface ConnectedMcps {
  /** Anthropic-shaped tool definitions (already namespaced + sanitized). */
  tools: AnthropicTool[];
  /** Route a tool_use call (Anthropic-shaped name) to the right MCP. */
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Close all client transports. */
  close(): Promise<void>;
}

// ─── Tool name sanitization ───────────────────────────────────────────

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function safeName(serverName: string, toolName: string): string {
  // Replace dots and other invalid chars with underscores; keep the result
  // under Anthropic's 64-char cap. Server prefix collision-resolves tools
  // that happen to have the same name across MCPs.
  const cleanedTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanedServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  let combined = `${cleanedServer}__${cleanedTool}`;
  if (combined.length > 64) combined = combined.slice(0, 64);
  if (!TOOL_NAME_RE.test(combined)) {
    throw new Error(`Could not sanitize tool name '${serverName}/${toolName}' -> '${combined}'`);
  }
  return combined;
}

// ─── Connect a single MCP ─────────────────────────────────────────────

async function connectOne(serverName: string, cfg: McpConfig): Promise<{
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}> {
  if ("url" in cfg) {
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
    });
    const client = new Client({ name: `sherlock-front-${serverName}`, version: "0.1.0" });
    await client.connect(transport);
    return { client, transport };
  }
  // Stdio transport. The SDK launches the child process for us.
  // We pass through the child env so MCP servers see (e.g.) DATABASE paths.
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
  });
  const client = new Client({ name: `sherlock-front-${serverName}`, version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

// ─── Public: connect all MCPs and produce an Anthropic tool surface ───

export async function connectMcps(configs: Record<string, McpConfig>): Promise<ConnectedMcps> {
  const clients: Array<{ name: string; client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport }> = [];
  const tools: AnthropicTool[] = [];
  // Map sanitized Anthropic tool name → { client, originalToolName }
  const route = new Map<string, { client: Client; originalToolName: string; serverName: string }>();

  // Connect each MCP and enumerate its tools.
  for (const [name, cfg] of Object.entries(configs)) {
    try {
      const { client, transport } = await connectOne(name, cfg);
      clients.push({ name, client, transport });

      const list = await client.listTools();
      for (const t of list.tools) {
        const safe = safeName(name, t.name);
        if (route.has(safe)) {
          // Should be unreachable because of the server prefix, but guard anyway.
          log.warn({ safe, serverName: name, toolName: t.name }, "tool name collision; skipping");
          continue;
        }
        const description = t.description
          ? `[from ${name}] ${t.description}`
          : `[from ${name}] (no description)`;
        tools.push({
          name: safe,
          description,
          input_schema: {
            type: "object",
            properties: (t.inputSchema?.properties ?? {}) as Record<string, object>,
            required: t.inputSchema?.required,
          },
        });
        route.set(safe, { client, originalToolName: t.name, serverName: name });
      }

      log.info({ server: name, toolCount: list.tools.length }, "MCP connected");
    } catch (err) {
      log.error(
        { server: name, err: err instanceof Error ? err.message : String(err) },
        "MCP connect failed"
      );
      // Continue without this MCP rather than aborting; Front can still
      // partially function (e.g. without web.search) and Mihir will see
      // Sherlock acknowledge the limitation.
    }
  }

  // ─── Tool-use dispatch ────────────────────────────────────────────

  async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r = route.get(name);
    if (!r) throw new Error(`Unknown tool: ${name}`);

    const result = await r.client.callTool({ name: r.originalToolName, arguments: args });
    // Result content can be array of text/image/resource blocks. We only
    // forward text to Anthropic; non-text blocks get a placeholder note.
    const content = result.content as Array<Record<string, unknown>> | undefined;
    if (!content) return JSON.stringify(result);

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (typeof block.type === "string") {
        parts.push(`[${block.type} block omitted]`);
      }
    }
    if (result.isError) {
      return `[tool error] ${parts.join("\n") || "(empty error)"}`;
    }
    return parts.join("\n");
  }

  async function close(): Promise<void> {
    for (const { name, transport } of clients) {
      try {
        await transport.close();
      } catch (err) {
        log.warn(
          { server: name, err: err instanceof Error ? err.message : String(err) },
          "MCP close failed"
        );
      }
    }
  }

  return { tools, callTool, close };
}
