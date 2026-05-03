/**
 * SDK smoke test — exercises every cursor-sdk gotcha on day 1 so we don't
 * discover them mid-implementation. From the cursor-sdk skill:
 *
 *   1. Cloud must be explicit (`cloud: { repos }`) or you silently get a
 *      local agent.
 *   2. Always dispose with `Symbol.asyncDispose` to avoid leaks.
 *   3. Always call `run.wait()` even if you don't stream.
 *
 * We do TWO end-to-end runs in <60s:
 *   - One LOCAL: `Agent.create({ local: { cwd } })` → send → stream → wait → dispose.
 *   - One CLOUD: `Agent.prompt(...)` against the SherlockV2 repo (read-only prompt).
 *
 * Validates: CURSOR_API_KEY works, network is healthy, the SDK behaves.
 *
 * Usage: npm run smoke:sdk
 */

import { Agent, CursorAgentError } from "@cursor/sdk";
import { loadEnv, requireEnv, optionalEnv } from "../shared/env.js";
import { createLogger } from "../shared/logger.js";
import { PROJECT_ROOT } from "../shared/paths.js";

const log = createLogger("smoke:sdk");

async function localSmoke(apiKey: string): Promise<{ ok: boolean; ms: number; runId?: string }> {
  const t0 = Date.now();
  log.info("LOCAL smoke: Agent.create({ local }) on %s", PROJECT_ROOT);
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2" },
    local: { cwd: PROJECT_ROOT, settingSources: [] },
  });
  let runId: string | undefined;
  try {
    log.info({ agentId: agent.agentId }, "agent created");
    const run = await agent.send(
      "Reply with the single word OK and nothing else. Do not call any tools."
    );
    runId = run.id;
    log.info({ runId }, "send acknowledged");
    let text = "";
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text") text += block.text;
        }
      }
    }
    const result = await run.wait();
    log.info(
      { runId, status: result.status, replyLength: text.length, reply: text.trim().slice(0, 60) },
      "local run complete"
    );
    return { ok: result.status === "finished", ms: Date.now() - t0, runId };
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

async function cloudSmoke(
  apiKey: string,
  repoUrl: string | undefined
): Promise<{ ok: boolean; ms: number; agentId?: string }> {
  if (!repoUrl) {
    log.warn("CLOUD smoke skipped — no SHERLOCKV2_REPO_URL set (this is fine pre-M0f)");
    return { ok: true, ms: 0 };
  }
  const t0 = Date.now();
  log.info("CLOUD smoke: Agent.prompt against %s", repoUrl);
  try {
    const result = await Agent.prompt(
      "Reply with the single word OK and nothing else. Do not edit any files.",
      {
        apiKey,
        model: { id: "composer-2" },
        cloud: {
          repos: [{ url: repoUrl }],
          autoCreatePR: false,
          skipReviewerRequest: true,
        },
      }
    );
    log.info({ status: result.status, agentId: result.id }, "cloud prompt complete");
    return { ok: result.status === "finished", ms: Date.now() - t0, agentId: result.id };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      log.error({ msg: err.message, retryable: err.isRetryable }, "CursorAgentError on cloud smoke");
      return { ok: false, ms: Date.now() - t0 };
    }
    throw err;
  }
}

async function main(): Promise<number> {
  loadEnv();
  const apiKey = requireEnv("CURSOR_API_KEY", "mint at https://cursor.com/dashboard/cloud-agents");
  const repoUrl = optionalEnv("SHERLOCKV2_REPO_URL");

  log.info("Starting SDK smoke. apiKey length=%d, repo=%s", apiKey.length, repoUrl ?? "<unset>");

  const local = await localSmoke(apiKey);
  log.info({ local }, "LOCAL result");

  const cloud = await cloudSmoke(apiKey, repoUrl);
  log.info({ cloud }, "CLOUD result");

  const allOk = local.ok && cloud.ok;
  log.info(allOk ? "✓ SDK smoke PASSED" : "✗ SDK smoke FAILED");
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "smoke crashed");
    process.exit(2);
  });
