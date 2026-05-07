/**
 * SherlockV2 admin portal — always-on launchd service.
 *
 * Hosts the dashboard at http://127.0.0.1:18789/admin and exposes the
 * single Start/Stop Sherlock master button via /admin/services/{status,
 * start, stop}. Reads local json/sqlite state directly where appropriate and
 * queries the shared retrieval API as the single source of corpus truth.
 *
 * Started by:  npm run admin            (foreground, dev)
 *              npm run admin:dev         (watch mode)
 *              launchctl bootstrap gui/$UID com.sherlock.admin.plist  (production)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, optionalEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { buildSnapshot } from "./snapshot.js";
import { DASHBOARD_HTML, logTailHtml, corpusListHtml, corpusDocHtml } from "./dashboard-html.js";
import { statusAll, startAll, stopAll } from "./services.js";
import { buildCoverage } from "./sources-coverage.js";
import { listLogs, getLogTail, LOG_REGISTRY } from "./logs.js";
import { listDocs, getDoc } from "./corpus.js";

loadEnv();
const log = createLogger("admin");

const PORT = parseInt(optionalEnv("ADMIN_PORT") ?? "18789", 10);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // ─── Health ───────────────────────────────────────────────────────
  if (method === "GET" && (url === "/healthz" || url === "/health")) {
    sendJson(res, 200, { ok: true, service: "sherlock-v2-admin", uptime_s: Math.round(process.uptime()) });
    return;
  }

  // ─── Dashboard ────────────────────────────────────────────────────
  if (method === "GET" && (url === "/" || url === "/admin" || url === "/admin/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(DASHBOARD_HTML);
    return;
  }

  // ─── Snapshot ─────────────────────────────────────────────────────
  if (method === "GET" && url === "/admin/state") {
    try {
      // Pass the bridge port (the "real" sherlock port) through for display.
      const bridgePort = parseInt(optionalEnv("BRIDGE_PORT") ?? "18790", 10);
      const snap = await buildSnapshot({ port: bridgePort });
      sendJson(res, 200, snap);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "snapshot failed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Master button: status ────────────────────────────────────────
  if (method === "GET" && url === "/admin/services/status") {
    try { sendJson(res, 200, await statusAll()); }
    catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "services/status failed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Master button: start ─────────────────────────────────────────
  if (method === "POST" && url === "/admin/services/start") {
    try {
      const r = await startAll();
      log.info({ ok: r.ok, results: r.results.map((x) => `${x.label}:${x.ok ? "ok" : "fail"}`) }, "services/start");
      sendJson(res, r.ok ? 200 : 500, r);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "services/start crashed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Master button: stop ──────────────────────────────────────────
  if (method === "POST" && url === "/admin/services/stop") {
    try {
      const r = await stopAll();
      log.info({ ok: r.ok, results: r.results.map((x) => `${x.label}:${x.ok ? "ok" : "fail"}`) }, "services/stop");
      sendJson(res, r.ok ? 200 : 500, r);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "services/stop crashed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Sources coverage ─────────────────────────────────────────────
  if (method === "GET" && url === "/admin/sources") {
    try { sendJson(res, 200, buildCoverage()); }
    catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "sources failed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Logs: list ───────────────────────────────────────────────────
  if (method === "GET" && url === "/admin/logs") {
    try { sendJson(res, 200, { logs: listLogs() }); }
    catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "logs list failed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Corpus list (HTML page or JSON) ──────────────────────────────
  if (method === "GET" && (url === "/admin/corpus" || url.startsWith("/admin/corpus?"))) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx === -1 ? "" : url.slice(qIdx + 1));
    const opts: Parameters<typeof listDocs>[0] = {};
    const source = params.get("source"); if (source) opts.source = source;
    const author = params.get("author"); if (author) opts.author = author;
    const q = params.get("q"); if (q) opts.q = q;
    const limit = params.get("limit"); if (limit) opts.limit = parseInt(limit, 10) || 50;
    const offset = params.get("offset"); if (offset) opts.offset = parseInt(offset, 10) || 0;

    const accept = String(req.headers["accept"] ?? "");
    const fetchMode = String(req.headers["sec-fetch-mode"] ?? "");
    const wantsJson = params.get("format") === "json"
      || fetchMode === "cors"
      || !accept.includes("text/html");

    if (!wantsJson) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(corpusListHtml());
      return;
    }
    try { sendJson(res, 200, await listDocs(opts)); }
    catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "corpus list failed");
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Corpus single doc (HTML page or JSON) ────────────────────────
  if (method === "GET" && url.startsWith("/admin/corpus/")) {
    const path = url.slice("/admin/corpus/".length);
    const qIdx = path.indexOf("?");
    const idStr = qIdx === -1 ? path : path.slice(0, qIdx);
    const queryStr = qIdx === -1 ? "" : path.slice(qIdx + 1);
    const id = parseInt(decodeURIComponent(idStr), 10);
    if (Number.isNaN(id) || id <= 0) { sendJson(res, 400, { ok: false, error: "bad doc id" }); return; }

    const params = new URLSearchParams(queryStr);
    const accept = String(req.headers["accept"] ?? "");
    const fetchMode = String(req.headers["sec-fetch-mode"] ?? "");
    const wantsJson = params.get("format") === "json"
      || fetchMode === "cors"
      || !accept.includes("text/html");

    if (!wantsJson) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(corpusDocHtml(id));
      return;
    }
    const doc = await getDoc(id);
    if (!doc) { sendJson(res, 404, { ok: false, error: `unknown doc id: ${id}` }); return; }
    sendJson(res, 200, doc);
    return;
  }

  // ─── Logs: tail (HTML page or JSON) ───────────────────────────────
  if (method === "GET" && url.startsWith("/admin/logs/")) {
    // /admin/logs/<name>[?lines=N]
    const path = url.slice("/admin/logs/".length);
    const qIdx = path.indexOf("?");
    const namePart = qIdx === -1 ? path : path.slice(0, qIdx);
    const queryStr = qIdx === -1 ? "" : path.slice(qIdx + 1);
    const name = decodeURIComponent(namePart);

    const entry = LOG_REGISTRY.find((l) => l.name === name);
    if (!entry) { sendJson(res, 404, { ok: false, error: `unknown log: ${name}` }); return; }

    const params = new URLSearchParams(queryStr);
    const linesRaw = params.get("lines");
    const lines = linesRaw ? parseInt(linesRaw, 10) || 1000 : 1000;

    // Content negotiation: a browser navigation gets HTML; explicit ?format=json
    // or fetch() (Accept: */*; sec-fetch-mode: cors) gets JSON.
    const accept = String(req.headers["accept"] ?? "");
    const fetchMode = String(req.headers["sec-fetch-mode"] ?? "");
    const wantsHtml = params.get("format") !== "json"
      && fetchMode !== "cors"
      && accept.includes("text/html");

    if (wantsHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(logTailHtml(entry.name, entry.label));
      return;
    }
    const tail = getLogTail(name, lines);
    if (!tail) { sendJson(res, 404, { ok: false, error: `unknown log: ${name}` }); return; }
    sendJson(res, 200, tail);
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "request handler unhandled rejection");
    if (!res.headersSent) sendJson(res, 500, { ok: false });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log.info({ port: PORT, pid: process.pid }, "admin listening");
});

const shutdown = (signal: string): void => {
  log.info({ signal }, "shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
