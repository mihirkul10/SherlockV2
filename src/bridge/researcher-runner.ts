/**
 * Sherlock-Researcher runner — spawns a fresh local SDK agent per research
 * job. Wired into the job-manager via setResearcherSpawner().
 *
 * Responsibilities:
 *   - Build the researcher prompt (system + scope) from src/prompts/researcher.system.md
 *   - Spawn Agent.create({ local }) with the full researcher tool set:
 *       - context-search       (read local corpus)
 *       - parallel-search      (web quick)
 *       - parallel-task        (web deep, capped via budget proxy in M3.5+)
 *       - report-writer        (writes to sherlock-vault)
 *       - bluebubbles-out      (final notify)
 *   - cwd is sherlock-vault so report.finalize's git commands work seamlessly
 *   - Return the SDK agent + a Promise of the final RunResult to the job-manager
 */

import { Agent, type SDKAgent, type RunResult } from "@cursor/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT, VAULT_PATH } from "../shared/paths.js";
import { requireEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { setResearcherSpawner, type ResearchScope, type SpawnResult } from "./job-manager.js";

const log = createLogger("bridge:researcher-runner");

const SYSTEM_PROMPT_PATH = resolve(PROJECT_ROOT, "src", "prompts", "researcher.system.md");
const CONTEXT_SEARCH_MCP   = resolve(PROJECT_ROOT, "src", "tools", "context-search",   "server.ts");
const REPORT_WRITER_MCP    = resolve(PROJECT_ROOT, "src", "tools", "report-writer",    "server.ts");
const BLUEBUBBLES_OUT_MCP  = resolve(PROJECT_ROOT, "src", "tools", "bluebubbles-out",  "server.ts");

let cachedPrompt: string | null = null;
function loadResearcherPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  cachedPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  return cachedPrompt;
}

function buildPrompt(args: { research_id: number; scope: ResearchScope }): string {
  const scope = args.scope;
  return [
    loadResearcherPrompt(),
    "",
    "# Your assignment",
    `**research_id**: ${args.research_id}  (use this in tool calls)`,
    `**topic**: ${scope.topic}`,
    scope.dimensions?.length ? `**dimensions**: ${scope.dimensions.join(", ")}` : "",
    scope.time_horizon ? `**time horizon**: ${scope.time_horizon}` : "",
    scope.sources_focus?.length ? `**preferred sources**: ${scope.sources_focus.join(", ")}` : "",
    scope.urgency ? `**urgency**: ${scope.urgency}` : "",
    scope.notes ? `**user notes**: ${scope.notes}` : "",
    "",
    "Begin. Remember: gather → synthesize → write_section per dimension → finalize → notify_complete. One report. Cite everything. No iMessage progress messages — just the final notify.",
  ].filter((l) => l !== "").join("\n");
}

async function spawn(args: {
  research_id: number;
  chat_guid: string;
  scope: ResearchScope;
}): Promise<SpawnResult> {
  const apiKey = requireEnv("CURSOR_API_KEY");
  const parallelKey = requireEnv("PARALLEL_API_KEY");
  const prompt = buildPrompt({ research_id: args.research_id, scope: args.scope });

  log.info({ id: args.research_id, topic: args.scope.topic }, "spawning Sherlock-Researcher");

  // The spawned MCP children inherit the bridge's env. We additionally set
  // BLUEBUBBLES_DEFAULT_CHAT_GUID so the bluebubbles-out MCP knows where to
  // route notify_complete without the agent needing to remember the chat_guid.
  const childEnv = {
    ...process.env,
    BLUEBUBBLES_DEFAULT_CHAT_GUID: args.chat_guid,
    SHERLOCK_RESEARCH_ID: String(args.research_id),
  };

  let agent: SDKAgent;
  try {
    agent = await Agent.create({
      apiKey,
      model: { id: "composer-2" },
      // cwd is the vault so that report-writer's git commit/push works inline.
      local: { cwd: VAULT_PATH, settingSources: [] },
      mcpServers: {
        "context-search": {
          command: "npx",
          args: ["tsx", CONTEXT_SEARCH_MCP],
          env: childEnv,
        },
        "report-writer": {
          command: "npx",
          args: ["tsx", REPORT_WRITER_MCP],
          env: childEnv,
        },
        "bluebubbles-out": {
          command: "npx",
          args: ["tsx", BLUEBUBBLES_OUT_MCP],
          env: childEnv,
        },
        "parallel-search": {
          url: "https://search-mcp.parallel.ai/mcp",
          headers: { "x-api-key": parallelKey },
        },
        "parallel-task": {
          url: "https://task-mcp.parallel.ai/mcp",
          headers: { "x-api-key": parallelKey },
        },
      },
    });
  } catch (err) {
    log.error({ id: args.research_id, err: err instanceof Error ? err.message : String(err) }, "Agent.create failed");
    throw err;
  }

  const run = await agent.send(prompt);
  log.info({ id: args.research_id, agentId: agent.agentId, runId: run.id }, "researcher send acknowledged");

  const resultPromise: Promise<{ runResult: RunResult; vaultPath?: string; tldr?: string }> = (async () => {
    try {
      for await (const _ of run.stream()) { /* discard; we only care about wait() */ }
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, "researcher stream errored (continuing to wait)");
    }
    const runResult = await run.wait();
    const { vaultPath, tldr } = readMostRecentFinalize(args.research_id);
    return { runResult, ...(vaultPath && { vaultPath }), ...(tldr && { tldr }) };
  })();

  // Provide a real cancel that stops the SDK run if supported.
  const cancel = async (): Promise<void> => {
    if (run.supports("cancel")) {
      try { await run.cancel(); } catch (e) {
        log.warn({ id: args.research_id, err: e instanceof Error ? e.message : String(e) }, "run.cancel failed");
      }
    }
  };

  return { agent, result: resultPromise, runId: run.id, cancel };
}

import { existsSync, readFileSync as fsRead } from "node:fs";
import { STATE_DIR } from "../shared/paths.js";

function readMostRecentFinalize(research_id: number): { vaultPath?: string; tldr?: string } {
  const log_path = resolve(STATE_DIR, "mcp-report-writer.log");
  if (!existsSync(log_path)) return {};
  try {
    const lines = fsRead(log_path, "utf-8").split("\n").reverse();
    for (const line of lines) {
      const m = line.match(new RegExp(`FINALIZE research_id=${research_id} path=(\\S+)`));
      if (m) return { vaultPath: m[1] };
    }
  } catch { /* ignore */ }
  return {};
}

// ─── Wire the spawner into the job-manager on import ──────────────────

setResearcherSpawner(spawn);
log.info("researcher spawner registered");
