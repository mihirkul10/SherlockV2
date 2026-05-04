import { Agent } from "@cursor/sdk";
import { loadEnv, requireEnv } from "../shared/env.js";
import { PROJECT_ROOT } from "../shared/paths.js";

loadEnv();
const apiKey = requireEnv("CURSOR_API_KEY");
const t0 = Date.now();
const agent = await Agent.create({
  apiKey,
  model: { id: "claude-sonnet-4-6" },
  local: { cwd: PROJECT_ROOT, settingSources: [] },
});
const run = await agent.send("Reply with the single word OK and nothing else. Do not call any tools.");
let text = "";
for await (const ev of run.stream()) {
  if (ev.type === "assistant") {
    for (const b of ev.message.content) if (b.type === "text") text += b.text;
  }
}
const result = await run.wait();
console.log(JSON.stringify({
  model: "claude-sonnet-4-6",
  ms: Date.now() - t0,
  status: result.status,
  text: text.trim(),
}, null, 2));
await agent[Symbol.asyncDispose]();
