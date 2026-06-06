import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  AdminCorpusListInputSchema,
  BriefInputSchema,
  DeleteDocumentsRequestSchema,
  FollowupsInputSchema,
  ManifestDiffRequestSchema,
  IndexRunPayloadSchema,
  SearchInputSchema,
  UpsertDocumentsRequestSchema,
} from "./contracts.js";
import { buildBrief, buildFollowups } from "./planner.js";
import {
  deletePreparedDocuments,
  diffManifest,
  getSharedDocument,
  getSharedStats,
  listSharedDocuments,
  recordIndexRun,
  searchSharedIndex,
} from "./shared-index.js";
import { optionalEnv, loadEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";

loadEnv();
const log = createLogger("retrieval:api");
const PORT = parseInt(
  optionalEnv("PORT")
  ?? optionalEnv("SHERLOCK_CONTEXT_API_PORT")
  ?? "18840",
  10,
);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = optionalEnv("SHERLOCK_CONTEXT_API_TOKEN");
  if (!token) return true;
  const header = req.headers["authorization"];
  return header === `Bearer ${token}`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = requestUrl(req);
  const url = parsedUrl.pathname;
  if (req.method === "GET" && (url === "/healthz" || url === "/health")) {
    sendJson(res, 200, { ok: true, service: "sherlock-context-api", uptime_s: Math.round(process.uptime()) });
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url === "/query/stats") {
    sendJson(res, 200, getSharedStats());
    return;
  }

  if (req.method === "POST" && url === "/query/search") {
    const input = SearchInputSchema.parse(await readJson(req));
    const hits = await searchSharedIndex(input.query, input.filters ?? {}, input.limit);
    sendJson(res, 200, { hits, total_returned: hits.length });
    return;
  }

  if (req.method === "POST" && url === "/query/brief") {
    const input = BriefInputSchema.parse(await readJson(req));
    const stats = getSharedStats();
    const retrievalQuery = input.user_question ? `${input.topic} ${input.user_question}` : input.topic;
    const hits = await searchSharedIndex(retrievalQuery, input.filters ?? {}, input.limit);
    sendJson(res, 200, buildBrief(input.topic, hits, stats));
    return;
  }

  if (req.method === "POST" && url === "/query/followups") {
    const input = FollowupsInputSchema.parse(await readJson(req));
    const stats = getSharedStats();
    const retrievalQuery = input.user_question ? `${input.topic} ${input.user_question}` : input.topic;
    const hits = await searchSharedIndex(retrievalQuery, input.filters ?? {}, input.limit);
    const brief = buildBrief(input.topic, hits, stats);
    sendJson(res, 200, buildFollowups(input.topic, hits, brief));
    return;
  }

  if (req.method === "POST" && url === "/admin/manifest-diff") {
    const input = ManifestDiffRequestSchema.parse(await readJson(req));
    sendJson(res, 200, diffManifest(input.manifest));
    return;
  }

  if (req.method === "POST" && url === "/admin/upsert-docs") {
    const input = UpsertDocumentsRequestSchema.parse(await readJson(req));
    let changedChunks = 0;
    const { upsertPreparedDocument } = await import("./shared-index.js");
    for (const document of input.documents) {
      changedChunks += upsertPreparedDocument(document).changedChunks;
    }
    sendJson(res, 200, {
      ok: true,
      changed_docs: input.documents.length,
      changed_chunks: changedChunks,
    });
    return;
  }

  if (req.method === "POST" && url === "/admin/delete-docs") {
    const input = DeleteDocumentsRequestSchema.parse(await readJson(req));
    // Mass-delete guardrail: an indexer running against a partial copy of the
    // corpus once wiped most of the index. Reject deletions of more than 20%
    // of the corpus unless the client explicitly opts in.
    const total = getSharedStats().total;
    const deleteCap = Math.max(25, Math.floor(total * 0.2));
    if (input.paths.length > deleteCap && req.headers["x-sherlock-allow-mass-delete"] !== "1") {
      log.warn({ requested: input.paths.length, total, cap: deleteCap }, "mass delete rejected");
      sendJson(res, 409, {
        ok: false,
        error: `mass delete rejected: ${input.paths.length} of ${total} docs exceeds cap ${deleteCap}; ` +
          `send header X-Sherlock-Allow-Mass-Delete: 1 if intentional`,
      });
      return;
    }
    sendJson(res, 200, { ok: true, deleted_docs: deletePreparedDocuments(input.paths) });
    return;
  }

  if (req.method === "POST" && url === "/admin/index-runs") {
    const payload = IndexRunPayloadSchema.parse(await readJson(req));
    recordIndexRun(payload);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url === "/admin/corpus") {
    const raw = {
      source: parsedUrl.searchParams.get("source") || undefined,
      author: parsedUrl.searchParams.get("author") || undefined,
      q: parsedUrl.searchParams.get("q") || undefined,
      limit: parsedUrl.searchParams.get("limit") ? Number.parseInt(parsedUrl.searchParams.get("limit")!, 10) : undefined,
      offset: parsedUrl.searchParams.get("offset") ? Number.parseInt(parsedUrl.searchParams.get("offset")!, 10) : undefined,
    };
    const input = AdminCorpusListInputSchema.parse(raw);
    sendJson(res, 200, listSharedDocuments(input));
    return;
  }

  if (req.method === "GET" && url.startsWith("/admin/corpus/")) {
    const docId = Number.parseInt(decodeURIComponent(url.slice("/admin/corpus/".length)), 10);
    if (Number.isNaN(docId) || docId <= 0) {
      sendJson(res, 400, { ok: false, error: "bad doc id" });
      return;
    }
    const doc = getSharedDocument(docId);
    if (!doc) {
      sendJson(res, 404, { ok: false, error: `unknown doc id: ${docId}` });
      return;
    }
    sendJson(res, 200, doc);
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, method: req.method, url: req.url }, "context api request failed");
    sendJson(res, 500, { ok: false, error: message });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log.info({ port: PORT }, "context api listening");
});
