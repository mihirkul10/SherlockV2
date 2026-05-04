/**
 * Report-writer MCP — exposed to Sherlock-Researcher only.
 *
 * Tools:
 *   - report.write_section(research_id, section_id, title, body, citations?)
 *   - report.finalize({ research_id, title, scope, summary, sections?, frontmatter? })
 *
 * On finalize, writes a Markdown file to:
 *   sherlock-vault/Reports/<yyyy-mm>/<yyyy-mm-dd-HHMM>-<topic-slug>.md
 *
 * then `git add && git commit && git push` in sherlock-vault. Returns the
 * absolute path so the caller can include it in the iMessage notification.
 *
 * Sections are accumulated in /tmp keyed by research_id during a single
 * researcher run (kept simple — fresh process per spawn).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VAULT_PATH, VAULT_REPORTS_DIR, VAULT_REPORTS_INDEX, STATE_DIR } from "../../shared/paths.js";
import { loadEnv } from "../../shared/env.js";
import { createLogger } from "../../shared/logger.js";
import { slugify } from "../../ingest/markdown.js";

const log = createLogger("mcp:report-writer");
const exec = promisify(execFile);

const DIAG = resolve(STATE_DIR, "mcp-report-writer.log");
function diag(line: string): void {
  try { mkdirSync(dirname(DIAG), { recursive: true }); appendFileSync(DIAG, `${new Date().toISOString()} ${line}\n`, "utf-8"); } catch { /* ignore */ }
}

interface InProgressSection {
  section_id: string;
  title: string;
  body: string;
  citations?: string[];
}

function sectionsPath(research_id: number): string {
  return resolve(tmpdir(), `sherlock-research-${research_id}-sections.json`);
}

function loadSections(research_id: number): InProgressSection[] {
  const p = sectionsPath(research_id);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; }
}

function saveSections(research_id: number, sections: InProgressSection[]): void {
  writeFileSync(sectionsPath(research_id), JSON.stringify(sections, null, 2), "utf-8");
}

// ─── Schemas ───────────────────────────────────────────────────────────

const WriteSectionInput = z.object({
  research_id: z.number().int().describe("The research id provided by the orchestrator (visible in the user-facing scope)."),
  section_id: z.string().min(1).describe("Stable id for this section, e.g. 'legislative-history'. Re-using an id replaces the prior section."),
  title: z.string().min(1).describe("Section heading (rendered as ## in Markdown)."),
  body: z.string().min(1).describe("Markdown body. Cite sources inline as [Author — Title](url)."),
  citations: z.array(z.string()).optional().describe("Optional explicit list of source URLs."),
});

const FinalizeInput = z.object({
  research_id: z.number().int(),
  title: z.string().min(1).describe("Top-level report title (rendered as # in Markdown)."),
  scope: z.string().min(1).describe("One-sentence restatement of what was researched."),
  summary: z.string().min(1).describe("3-5 sentence TL;DR shown at the top of the report and in the iMessage notification."),
  sections: z.array(z.object({
    title: z.string(),
    body: z.string(),
    citations: z.array(z.string()).optional(),
  })).optional().describe("If you didn't use write_section, you can pass all sections inline here."),
  status: z.enum(["complete", "partial"]).default("complete"),
  frontmatter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    .describe("Optional extra frontmatter key-value pairs."),
});

// ─── Markdown rendering ───────────────────────────────────────────────

function renderReport(args: {
  title: string;
  scope: string;
  summary: string;
  sections: InProgressSection[];
  research_id: number;
  status: "complete" | "partial";
  startedAt: number;
  finishedAt: number;
  extras?: Record<string, string | number | boolean>;
}): string {
  const lines: string[] = ["---"];
  lines.push(`type: report`);
  lines.push(`research_id: ${args.research_id}`);
  lines.push(`title: ${JSON.stringify(args.title)}`);
  lines.push(`scope: ${JSON.stringify(args.scope)}`);
  lines.push(`status: ${args.status}`);
  lines.push(`asked_at: ${new Date(args.startedAt).toISOString()}`);
  lines.push(`finished_at: ${new Date(args.finishedAt).toISOString()}`);
  lines.push(`duration_minutes: ${Math.round((args.finishedAt - args.startedAt) / 60000)}`);
  if (args.extras) {
    for (const [k, v] of Object.entries(args.extras)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${args.title}`);
  lines.push("");
  lines.push("## TL;DR");
  lines.push("");
  lines.push(args.summary.trim());
  lines.push("");
  for (const s of args.sections) {
    lines.push(`## ${s.title}`);
    lines.push("");
    lines.push(s.body.trim());
    lines.push("");
    if (s.citations?.length) {
      lines.push(`*Sources:*`);
      for (const c of s.citations) lines.push(`- ${c}`);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push(`*Generated by Sherlock-Researcher #${args.research_id}*`);
  lines.push("");
  return lines.join("\n");
}

function reportPath(title: string, finishedAt: number): string {
  const d = new Date(finishedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const monthDir = resolve(VAULT_REPORTS_DIR, `${yyyy}-${mm}`);
  return resolve(monthDir, `${yyyy}-${mm}-${dd}-${HH}${MM}-${slugify(title, 80)}.md`);
}

async function gitCommitPush(absPath: string, title: string, research_id: number): Promise<void> {
  // sherlock-vault is the cwd of the researcher (configured in researcher-runner).
  // But the report-writer MCP is a separate process, so explicitly cd into VAULT_PATH.
  const env = process.env;
  await exec("git", ["add", absPath, VAULT_REPORTS_INDEX], { cwd: VAULT_PATH, env });
  await exec("git", [
    "-c", "user.email=mihirkul10@gmail.com",
    "-c", "user.name=Sherlock Researcher",
    "commit", "-m", `report(#${research_id}): ${title}`,
  ], { cwd: VAULT_PATH, env });
  await exec("git", ["push", "origin", "main"], { cwd: VAULT_PATH, env });
}

function updateReportsIndex(args: { title: string; absPath: string; finishedAt: number }): void {
  // Rebuild a simple Markdown table of every report by date. Cheap at our scale.
  // (Walk Reports/<yyyy-mm>/*.md.)
  const reportEntries: Array<{ date: string; title: string; rel: string }> = [];
  if (existsSync(VAULT_REPORTS_DIR)) {
    const monthDirs = require("node:fs").readdirSync(VAULT_REPORTS_DIR)
      .filter((n: string) => /^\d{4}-\d{2}$/.test(n))
      .sort()
      .reverse();
    for (const md of monthDirs) {
      const dirPath = resolve(VAULT_REPORTS_DIR, md);
      const files = require("node:fs").readdirSync(dirPath).filter((n: string) => n.endsWith(".md")).sort().reverse();
      for (const f of files) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})-\d{4}-(.+)\.md$/);
        if (!m) continue;
        reportEntries.push({
          date: m[1]!,
          title: m[2]!.replace(/-/g, " "),
          rel: `${md}/${f}`,
        });
      }
    }
  }
  // Make sure the just-finalized report is in there even if listing is racy.
  const justRel = args.absPath.replace(VAULT_REPORTS_DIR + "/", "");
  if (!reportEntries.find((e) => e.rel === justRel)) {
    const d = new Date(args.finishedAt);
    reportEntries.unshift({
      date: d.toISOString().slice(0, 10),
      title: args.title,
      rel: justRel,
    });
  }
  const lines: string[] = [
    "# Reports",
    "",
    "Auto-maintained index of every report Sherlock has written. Most-recent first.",
    "",
    "| Date | Title | File |",
    "|------|-------|------|",
  ];
  for (const e of reportEntries) {
    lines.push(`| ${e.date} | ${e.title} | [${e.rel}](${e.rel}) |`);
  }
  writeFileSync(VAULT_REPORTS_INDEX, lines.join("\n") + "\n", "utf-8");
}

// ─── Server ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  diag(`SPAWN pid=${process.pid}`);

  const server = new Server(
    { name: "sherlock-report-writer", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "report.write_section",
        description: "Append (or replace, by section_id) a section in the in-progress report. Useful for streaming sections one-at-a-time before calling finalize.",
        inputSchema: {
          type: "object",
          properties: {
            research_id: { type: "integer" },
            section_id: { type: "string" },
            title: { type: "string" },
            body: { type: "string", description: "Markdown body. Cite inline as [Author - Title](url)." },
            citations: { type: "array", items: { type: "string" } },
          },
          required: ["research_id", "section_id", "title", "body"],
        },
      },
      {
        name: "report.finalize",
        description: "Write the Markdown report to sherlock-vault/Reports/<yyyy-mm>/, commit + push the vault, and return the absolute path. Call exactly once near the end of the researcher run.",
        inputSchema: {
          type: "object",
          properties: {
            research_id: { type: "integer" },
            title: { type: "string" },
            scope: { type: "string", description: "One-sentence restatement of what was researched." },
            summary: { type: "string", description: "3-5 sentence TL;DR." },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  citations: { type: "array", items: { type: "string" } },
                },
                required: ["title", "body"],
              },
            },
            status: { type: "string", enum: ["complete", "partial"], default: "complete" },
            frontmatter: { type: "object" },
          },
          required: ["research_id", "title", "scope", "summary"],
        },
      },
    ],
  }));

  const startedAtById = new Map<number, number>();

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    try {
      if (name === "report.write_section") {
        const a = WriteSectionInput.parse(rawArgs ?? {});
        diag(`WRITE_SECTION research_id=${a.research_id} section=${a.section_id} bodyChars=${a.body.length}`);
        if (!startedAtById.has(a.research_id)) startedAtById.set(a.research_id, Date.now());
        const sections = loadSections(a.research_id);
        const idx = sections.findIndex((s) => s.section_id === a.section_id);
        const next: InProgressSection = {
          section_id: a.section_id,
          title: a.title,
          body: a.body,
          ...(a.citations && { citations: a.citations }),
        };
        if (idx >= 0) sections[idx] = next; else sections.push(next);
        saveSections(a.research_id, sections);
        return { content: [{ type: "text", text: `OK. ${sections.length} sections accumulated for #${a.research_id}.` }] };
      }

      if (name === "report.finalize") {
        const a = FinalizeInput.parse(rawArgs ?? {});
        const startedAt = startedAtById.get(a.research_id) ?? Date.now() - 1000;
        const finishedAt = Date.now();
        const accumulated = loadSections(a.research_id);
        // Inline sections override / supplement accumulated ones.
        const sections: InProgressSection[] = [
          ...accumulated.filter((s) => !(a.sections ?? []).find((inl) => inl.title === s.title)),
          ...(a.sections ?? []).map((s, i) => ({
            section_id: `inline-${i}`,
            title: s.title,
            body: s.body,
            ...(s.citations && { citations: s.citations }),
          })),
        ];

        const md = renderReport({
          title: a.title,
          scope: a.scope,
          summary: a.summary,
          sections,
          research_id: a.research_id,
          status: a.status,
          startedAt,
          finishedAt,
          ...(a.frontmatter && { extras: a.frontmatter as Record<string, string | number | boolean> }),
        });
        const absPath = reportPath(a.title, finishedAt);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, md, "utf-8");
        updateReportsIndex({ title: a.title, absPath, finishedAt });
        diag(`FINALIZE research_id=${a.research_id} path=${absPath} bytes=${md.length}`);

        try {
          await gitCommitPush(absPath, a.title, a.research_id);
          log.info({ research_id: a.research_id, absPath }, "✓ report finalized + pushed");
        } catch (err) {
          log.error({ err: err instanceof Error ? err.message : String(err) }, "git push failed (file written locally)");
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, vault_path: absPath, sections: sections.length }) }],
        };
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
  log.info("report-writer MCP server connected");
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "report-writer crashed");
  process.exit(1);
});
