/**
 * SherlockV2 bridge process — the always-running launchd service.
 *
 * Responsibilities (M2 cut):
 *   - HTTP server listening on 127.0.0.1:18790
 *   - POST /webhook/bluebubbles  → BlueBubbles forwards new iMessages here
 *   - POST /test/turn            → bypass iMessage; useful for E2E tests
 *   - GET  /healthz              → liveness probe
 *   - GET  /state                → bridge state for the Admin Canvas (M4)
 *
 * On a new iMessage:
 *   1. Parse webhook payload → IMessageIncoming
 *   2. Append to conversations.sqlite as a 'user' message
 *   3. Spawn Sherlock-Front via front-runner
 *   4. Append reply as 'assistant' message + send via BlueBubbles
 *
 * Started by:  npm run bridge          (foreground, dev)
 *              npm run bridge:dev       (watch mode)
 *              launchctl load com.sherlock.bridge.plist  (production)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, optionalEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { parseWebhook, sendIMessageChunked, registerWebhook } from "./bluebubbles.js";
import { appendMessage, recentRuns, startRun, setRunIds, finishRun } from "./conversation.js";
import { runFrontTurn } from "./front-runner.js";
// Importing researcher-runner registers the spawner with the job-manager (side effect).
import "./researcher-runner.js";
import { snapshot, cancelRun, recoverOrphans } from "./job-manager.js";

loadEnv();
const log = createLogger("bridge");

const PORT = parseInt(optionalEnv("BRIDGE_PORT") ?? "18790", 10);

// ─── Inbound handler ──────────────────────────────────────────────────

async function handleInbound(args: { chat_guid: string; from: string; text: string; message_id?: string }): Promise<void> {
  const runRow = startRun(args.chat_guid);
  appendMessage({
    chat_guid: args.chat_guid,
    role: "user",
    text: args.text,
    ...(args.message_id && { message_id: args.message_id }),
  });

  log.info({ from: args.from, chat_guid: args.chat_guid, textLen: args.text.length }, "user message received");

  try {
    const result = await runFrontTurn({ chat_guid: args.chat_guid, userText: args.text });
    setRunIds(runRow, result.agentId, result.runId);
    appendMessage({ chat_guid: args.chat_guid, role: "assistant", text: result.reply, run_id: result.runId });
    finishRun(runRow, result.status === "finished" ? "finished" : "error", result.status !== "finished" ? `status=${result.status}` : undefined);
    await sendIMessageChunked(args.chat_guid, result.reply);
    log.info({ chat_guid: args.chat_guid, runId: result.runId, durationMs: result.durationMs }, "reply sent");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ chat_guid: args.chat_guid, err: msg }, "front turn crashed");
    finishRun(runRow, "error", msg);
    await sendIMessageChunked(args.chat_guid, "I hit an error processing that. Try again in a moment?");
  }
}

// ─── HTTP routes ──────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/healthz" || url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "sherlock-v2-bridge", uptime_s: Math.round(process.uptime()) }));
    return;
  }

  if (req.method === "GET" && url === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      recent_runs: recentRuns(20),
      research: snapshot(),
    }, null, 2));
    return;
  }

  // POST /research/start  body: { topic, chat_guid, dimensions?, time_horizon?, sources_focus?, urgency?, notes?, parent_msg_id? }
  if (req.method === "POST" && url === "/research/start") {
    try {
      const body = await readJsonBody(req) as {
        topic?: string;
        chat_guid?: string;
        dimensions?: string[];
        time_horizon?: string;
        sources_focus?: string[];
        urgency?: "low" | "normal" | "high";
        notes?: string;
        parent_msg_id?: string;
      };
      if (!body.topic || !body.chat_guid) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "topic and chat_guid required" }));
        return;
      }
      const { requestResearch } = await import("./job-manager.js");
      const result = requestResearch({
        chat_guid: body.chat_guid,
        scope: {
          topic: body.topic,
          ...(body.dimensions && { dimensions: body.dimensions }),
          ...(body.time_horizon && { time_horizon: body.time_horizon }),
          ...(body.sources_focus && { sources_focus: body.sources_focus }),
          urgency: body.urgency ?? "normal",
          ...(body.notes && { notes: body.notes }),
        },
        ...(body.parent_msg_id && { parent_msg_id: body.parent_msg_id }),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // GET /research/active
  if (req.method === "GET" && url === "/research/active") {
    const { listActive } = await import("./job-manager.js");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, active: listActive() }));
    return;
  }

  // POST /research/:id/cancel
  if (req.method === "POST" && url.startsWith("/research/") && url.endsWith("/cancel")) {
    const idStr = url.slice("/research/".length, -"/cancel".length);
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad id" }));
      return;
    }
    cancelRun(id, "user").then((ok) => {
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
    }).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
    return;
  }

  if (req.method === "POST" && url === "/webhook/bluebubbles") {
    try {
      const body = await readJsonBody(req) as Record<string, unknown>;
      const incoming = parseWebhook(body);
      if (incoming) {
        // Don't await — return 200 immediately so BlueBubbles doesn't retry.
        handleInbound({ chat_guid: incoming.chatGuid, from: incoming.from, text: incoming.text, message_id: incoming.messageId })
          .catch((err) => log.error({ err: err instanceof Error ? err.message : String(err) }, "handleInbound rejected"));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "webhook parse failed");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad payload" }));
    }
    return;
  }

  if (req.method === "POST" && url === "/test/turn") {
    // E2E test endpoint: bypass BlueBubbles. Body: { chat_guid, text }.
    // Returns the assistant's reply synchronously instead of sending to iMessage.
    try {
      const body = await readJsonBody(req) as { chat_guid?: string; text?: string };
      if (!body.chat_guid || !body.text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "chat_guid and text required" }));
        return;
      }
      const runRow = startRun(body.chat_guid);
      appendMessage({ chat_guid: body.chat_guid, role: "user", text: body.text });
      const result = await runFrontTurn({ chat_guid: body.chat_guid, userText: body.text });
      setRunIds(runRow, result.agentId, result.runId);
      appendMessage({ chat_guid: body.chat_guid, role: "assistant", text: result.reply, run_id: result.runId });
      finishRun(runRow, result.status === "finished" ? "finished" : "error");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reply: result.reply, durationMs: result.durationMs, status: result.status, runId: result.runId }));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "/test/turn crashed");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
}

// ─── Server lifecycle ─────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "request handler unhandled rejection");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log.info({ port: PORT, pid: process.pid }, "bridge listening");
  // Recover orphaned researchers from a previous bridge crash.
  const recovered = recoverOrphans();
  if (recovered > 0) log.warn({ count: recovered }, "marked previously-running researchers as error");
  // Self-register the BlueBubbles webhook (best-effort; OK if it fails).
  registerWebhook(`http://localhost:${PORT}/webhook/bluebubbles`).catch((err) =>
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "BlueBubbles webhook self-registration failed")
  );
});

const shutdown = (signal: string): void => {
  log.info({ signal }, "shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
