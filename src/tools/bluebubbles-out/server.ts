/**
 * BlueBubbles-out MCP — exposed to Sherlock-Researcher only (and Front in M3+
 * for in-flight progress messages).
 *
 * Tools:
 *   - bluebubbles.notify_complete(research_id, vault_path, tldr)
 *       Sends a final iMessage with an obsidian:// deep-link.
 *   - bluebubbles.send_followup(text)  (optional, for Front later)
 *
 * The MCP needs to know the chat_guid to send to. It accepts it as input on
 * each call, OR uses an env-var default (BLUEBUBBLES_DEFAULT_CHAT_GUID set
 * by the bridge when spawning the Researcher).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { sendIMessageChunked } from "../../bridge/bluebubbles.js";
import { STATE_DIR, VAULT_PATH } from "../../shared/paths.js";
import { loadEnv, optionalEnv } from "../../shared/env.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mcp:bluebubbles-out");
const DIAG = resolve(STATE_DIR, "mcp-bluebubbles-out.log");
function diag(line: string): void {
  try { mkdirSync(dirname(DIAG), { recursive: true }); appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`, "utf-8"); } catch { /* ignore */ }
}

const NotifyInput = z.object({
  research_id: z.number().int(),
  vault_path: z.string().min(1),
  tldr: z.string().min(1).describe("2-3 sentence TL;DR for the iMessage."),
  chat_guid: z.string().optional().describe(
    "Defaults to BLUEBUBBLES_DEFAULT_CHAT_GUID env var (set by the bridge per spawn)."
  ),
});

const SendFollowupInput = z.object({
  text: z.string().min(1).max(2000),
  chat_guid: z.string().optional(),
});

function obsidianDeepLink(absVaultPath: string): string {
  // Convert /Users/.../sherlock-vault/Reports/2026-05/foo.md → relative path inside the vault
  const rel = relative(VAULT_PATH, absVaultPath);
  // Encode each path segment so spaces/special chars are safe in obsidian://
  const encoded = rel.split("/").map(encodeURIComponent).join("/");
  return `obsidian://open?vault=sherlock-vault&file=${encoded}`;
}

async function main(): Promise<void> {
  loadEnv();
  diag(`SPAWN pid=${process.pid} default_chat=${optionalEnv("BLUEBUBBLES_DEFAULT_CHAT_GUID") ?? "<unset>"}`);

  const server = new Server(
    { name: "sherlock-bluebubbles-out", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "bluebubbles.notify_complete",
        description: "Send the final 'report ready' iMessage to the user. Includes the obsidian:// deep-link to the report and a TL;DR. Call exactly once at the end of a researcher run.",
        inputSchema: {
          type: "object",
          properties: {
            research_id: { type: "integer" },
            vault_path: { type: "string", description: "Absolute path returned by report.finalize." },
            tldr: { type: "string", description: "2-3 sentence summary." },
            chat_guid: { type: "string" },
          },
          required: ["research_id", "vault_path", "tldr"],
        },
      },
      {
        name: "bluebubbles.send_followup",
        description: "Send a brief progress message in-flight. Avoid; default to silent operation. Only useful if the user explicitly asked for updates.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            chat_guid: { type: "string" },
          },
          required: ["text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    try {
      if (name === "bluebubbles.notify_complete") {
        const a = NotifyInput.parse(rawArgs ?? {});
        const chat = a.chat_guid ?? optionalEnv("BLUEBUBBLES_DEFAULT_CHAT_GUID");
        if (!chat) throw new Error("no chat_guid (and no BLUEBUBBLES_DEFAULT_CHAT_GUID env)");
        const link = obsidianDeepLink(a.vault_path);
        const text = `Report #${a.research_id} ready: ${link}\n\nTL;DR: ${a.tldr}`;
        diag(`NOTIFY research_id=${a.research_id} chat=${chat} link=${link}`);
        const ok = await sendIMessageChunked(chat, text);
        return { content: [{ type: "text", text: JSON.stringify({ ok, chat, sent_chars: text.length }) }] };
      }

      if (name === "bluebubbles.send_followup") {
        const a = SendFollowupInput.parse(rawArgs ?? {});
        const chat = a.chat_guid ?? optionalEnv("BLUEBUBBLES_DEFAULT_CHAT_GUID");
        if (!chat) throw new Error("no chat_guid (and no BLUEBUBBLES_DEFAULT_CHAT_GUID env)");
        diag(`FOLLOWUP chat=${chat} chars=${a.text.length}`);
        const ok = await sendIMessageChunked(chat, a.text);
        return { content: [{ type: "text", text: JSON.stringify({ ok }) }] };
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
  log.info("bluebubbles-out MCP server connected");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "bluebubbles-out crashed");
  process.exit(1);
});
