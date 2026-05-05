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
import { sendIMessageChunked } from "./imessage-sender.js";
import { IMessagePoller, type PolledMessage } from "./imessage-poller.js";
import { appendMessage, recentRuns, startRun, setRunIds, finishRun, hasMessageId } from "./conversation.js";
import { runFrontTurn } from "./front-runner.js";
// Importing researcher-runner registers the spawner with the job-manager (side effect).
import "./researcher-runner.js";
import { snapshot, cancelRun, recoverOrphans } from "./job-manager.js";
import { buildSnapshot } from "../admin/snapshot.js";

loadEnv();
const log = createLogger("bridge");

const PORT = parseInt(optionalEnv("BRIDGE_PORT") ?? "18790", 10);
const ADMIN_PORT = parseInt(optionalEnv("ADMIN_PORT") ?? "18789", 10);

// ─── Inbound handler ──────────────────────────────────────────────────

async function handleInbound(args: { chat_guid: string; from: string; text: string; message_id?: string }): Promise<void> {
  // Idempotency: skip if we've already processed this exact message GUID.
  // Protects against duplicate dispatches from multiple inbound transports
  // (e.g. the chat.db poller AND a stale BB webhook firing for the same msg).
  if (args.message_id && hasMessageId(args.message_id)) {
    log.info({ message_id: args.message_id, chat_guid: args.chat_guid }, "duplicate inbound — skipping");
    return;
  }
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

  // (BlueBubbles webhook removed — inbound now via IMessagePoller polling
  // chat.db directly. The endpoint stays available for synthetic testing.)
  if (req.method === "POST" && url === "/webhook/bluebubbles") {
    try {
      const body = await readJsonBody(req) as Record<string, unknown>;
      // Accept the same payload shape so synthetic test pokes still work.
      const data = (body["data"] as Record<string, unknown> | undefined) ?? {};
      const text = (data["text"] as string) ?? "";
      const isFromMe = data["is_from_me"] === true || data["isFromMe"] === true;
      const handle = data["handle"] as Record<string, unknown> | undefined;
      const from = (handle?.["address"] as string) ?? (data["address"] as string) ?? "";
      const chats = data["chats"] as Array<Record<string, unknown>> | undefined;
      const chatGuid = (chats?.[0]?.["guid"] as string) ?? `iMessage;-;${from}`;
      const messageId = String(data["guid"] ?? data["id"] ?? Date.now());
      if (text.trim() && from && !isFromMe) {
        handleInbound({ chat_guid: chatGuid, from, text, message_id: messageId })
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

  // ─── Admin dashboard now lives in com.sherlock.admin on its own port. ─
  // The dashboard URL was moved so it can outlive the bridge (it controls
  // the bridge via launchctl). This redirect keeps old bookmarks working.
  if (req.method === "GET" && (url === "/admin" || url === "/admin/")) {
    const target = `http://127.0.0.1:${ADMIN_PORT}/admin`;
    res.writeHead(302, { "Location": target, "Cache-Control": "no-store" });
    res.end(`redirecting to ${target}`);
    return;
  }
  // Kept for any external caller still polling /admin/state on the bridge.
  if (req.method === "GET" && url === "/admin/state") {
    try {
      const snap = buildSnapshot({ port: PORT });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(snap));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "admin snapshot failed");
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

// Poller is module-scoped so the SIGTERM handler can stop it cleanly.
const poller = new IMessagePoller({
  intervalMs: 1000,
  onMessage: (msg: PolledMessage): Promise<void> => {
    // Map PolledMessage → handleInbound's args. We discard messages that
    // already exist in conversations.sqlite (handled implicitly by appendMessage's
    // upsert-by-message_id, but we also dedupe here as a belt-and-suspenders).
    return handleInbound({
      chat_guid: msg.chat_guid,
      from: msg.sender,
      text: msg.text,
      message_id: msg.guid,
    });
  },
});

server.listen(PORT, "127.0.0.1", () => {
  log.info({ port: PORT, pid: process.pid }, "bridge listening");
  // Recover orphaned researchers from a previous bridge crash.
  const recovered = recoverOrphans();
  if (recovered > 0) log.warn({ count: recovered }, "marked previously-running researchers as error");
  // Start the chat.db poller. Requires Full Disk Access for this node binary.
  poller.start();
});

const shutdown = (signal: string): void => {
  log.info({ signal }, "shutting down");
  poller.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
