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

// Structured citation. `marker` is the [N] used inline in the section body.
// Markers are scoped per-section (each `report.write_section` call starts at
// [1]); on finalize the renderer dedupes by url and remaps to a single global
// numbering across the whole report.
interface Citation {
  type: "youtube" | "twitter" | "substack" | "blog" | "web" | "other";
  marker: number;
  author: string;
  title: string;
  url: string;
  published_at?: string;
  channel?: string;
  handle?: string;
  outlet?: string;
}

interface InProgressSection {
  section_id: string;
  title: string;
  body: string;
  citations?: Citation[];
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

const CitationSchema = z.object({
  type: z.enum(["youtube", "twitter", "substack", "blog", "web", "other"])
    .describe("Source class. Drives how the entry is formatted in the final ## Sources block."),
  marker: z.number().int().min(1)
    .describe("The [N] used inline in THIS section's body for this citation. Start at [1] per section; the renderer remaps to a global numbering across the whole report on finalize."),
  author: z.string()
    .describe("Person, channel, or outlet that produced the source. e.g. 'Lex Fridman', 'Ben Thompson', or 'All-In Podcast' for a channel."),
  title: z.string()
    .describe("Episode title / tweet excerpt / article headline. Pull from context.search hit's `title` — never paraphrase."),
  url: z.string()
    .describe("Canonical URL. Used to dedupe identical sources across sections."),
  published_at: z.string().optional()
    .describe("ISO8601 publication date when known."),
  channel: z.string().optional()
    .describe("YouTube channel display name. Use when type=youtube and the speaker/guest differs from the channel."),
  handle: z.string().optional()
    .describe("X/Twitter handle including @. Use when type=twitter."),
  outlet: z.string().optional()
    .describe("Publication / site name. Use when type=substack|blog|web (e.g. 'Stratechery', 'FT')."),
});

// Accept either the structured Citation object or a legacy free-form string.
// Strings are normalized into a low-fidelity {type:"other"} citation so older
// runs and ad-hoc URLs still render in the Sources block.
const CitationInputSchema = z.union([z.string(), CitationSchema]);

const WriteSectionInput = z.object({
  research_id: z.number().int().describe("The research id provided by the orchestrator (visible in the user-facing scope)."),
  section_id: z.string().min(1).describe("Stable id for this section, e.g. 'legislative-history'. Re-using an id replaces the prior section."),
  title: z.string().min(1).describe("Section heading (rendered as ## in Markdown)."),
  body: z.string().min(1).describe("Markdown body. Every factual claim drawn from a source must (a) name the source in prose ('as said by X on YouTube channel Y', 'as tweeted by @handle', etc.) and (b) end with a [N] marker matching a citation in the `citations` array. Markers are scoped to this section — start at [1]."),
  citations: z.array(CitationInputSchema).optional()
    .describe("Structured citations referenced by [N] markers in `body`. One entry per unique [N]. Strings are accepted for back-compat but the structured form is strongly preferred."),
});

const FinalizeInput = z.object({
  research_id: z.number().int(),
  title: z.string().min(1).describe("Top-level report title (rendered as # in Markdown)."),
  scope: z.string().min(1).describe("One-sentence restatement of what was researched."),
  summary: z.string().min(1).describe("3-5 sentence TL;DR shown at the top of the report and in the iMessage notification."),
  sections: z.array(z.object({
    title: z.string(),
    body: z.string(),
    citations: z.array(CitationInputSchema).optional(),
  })).optional().describe("If you didn't use write_section, you can pass all sections inline here."),
  status: z.enum(["complete", "partial"]).default("complete"),
  frontmatter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    .describe("Optional extra frontmatter key-value pairs."),
});

function normalizeCitation(c: string | Citation, fallbackMarker: number): Citation {
  if (typeof c === "string") {
    return { type: "other", marker: fallbackMarker, author: "", title: c, url: c };
  }
  return c;
}

// ─── Markdown rendering ───────────────────────────────────────────────

// Build a single global numbered list of citations across the whole report,
// deduped by URL (falling back to type+author+title for citations missing a
// URL). Returns the global list plus per-section maps from the local [N]
// markers the agent wrote into each body to the global N they should resolve
// to in the final document.
function buildGlobalCitations(sections: InProgressSection[]): {
  global: Citation[];
  perSection: Map<number, Map<number, number>>;
} {
  const global: Citation[] = [];
  const keyToGlobal = new Map<string, number>();
  const perSection = new Map<number, Map<number, number>>();

  sections.forEach((s, sIdx) => {
    const localMap = new Map<number, number>();
    perSection.set(sIdx, localMap);
    if (!s.citations?.length) return;
    for (const c of s.citations) {
      const key = (c.url && c.url.trim()) || `${c.type}::${c.author}::${c.title}`;
      let globalN = keyToGlobal.get(key);
      if (globalN === undefined) {
        global.push(c);
        globalN = global.length;
        keyToGlobal.set(key, globalN);
      }
      localMap.set(c.marker, globalN);
    }
  });

  return { global, perSection };
}

// Replace [<localN>] occurrences in a section body with their globally-mapped
// [<globalN>]. Done in a single pass so cycles like 1→3, 3→1 don't clobber.
function remapMarkers(body: string, localMap: Map<number, number>): string {
  if (localMap.size === 0) return body;
  return body.replace(/\[(\d+)\]/g, (match, numStr: string) => {
    const local = Number.parseInt(numStr, 10);
    const globalN = localMap.get(local);
    return globalN !== undefined ? `[${globalN}]` : match;
  });
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  // Accept full ISO or already-truncated YYYY-MM-DD.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : iso;
}

// One line per citation in the final ## Sources block. Format is type-specific
// so YouTube always surfaces channel + episode, Twitter always surfaces handle
// + author, and outlet sources always surface outlet + headline.
function formatCitation(c: Citation, n: number): string {
  const date = fmtDate(c.published_at);

  switch (c.type) {
    case "youtube": {
      const head = c.channel ?? c.author;
      const metaParts: string[] = [];
      if (c.author && c.channel && c.author !== c.channel) metaParts.push(c.author);
      if (date) metaParts.push(date);
      const meta = metaParts.length ? ` (${metaParts.join(", ")})` : "";
      const url = c.url ? `. ${c.url}` : "";
      return `${n}. [YouTube] ${head} — *"${c.title}"*${meta}${url}`;
    }
    case "twitter": {
      const head = c.handle ?? c.author;
      const metaParts: string[] = [];
      if (c.author && c.author !== head) metaParts.push(c.author);
      if (date) metaParts.push(date);
      const meta = metaParts.length ? ` (${metaParts.join(", ")})` : "";
      const url = c.url ? `. ${c.url}` : "";
      return `${n}. [Twitter] ${head} — *"${c.title}"*${meta}${url}`;
    }
    case "substack":
    case "blog":
    case "web": {
      const label = c.type === "substack" ? "Substack" : c.type === "blog" ? "Blog" : "Web";
      const head = c.outlet ?? c.author;
      const metaParts: string[] = [];
      if (c.author && c.author !== head) metaParts.push(c.author);
      if (date) metaParts.push(date);
      const meta = metaParts.length ? ` (${metaParts.join(", ")})` : "";
      const url = c.url ? `. ${c.url}` : "";
      return `${n}. [${label}] ${head} — *"${c.title}"*${meta}${url}`;
    }
    case "other":
    default: {
      const head = c.author || c.title || c.url || "(unknown)";
      const titlePart = c.title && c.title !== head ? ` — *"${c.title}"*` : "";
      const meta = date ? ` (${date})` : "";
      const url = c.url && c.url !== head ? `. ${c.url}` : "";
      return `${n}. ${head}${titlePart}${meta}${url}`;
    }
  }
}

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
  const { global, perSection } = buildGlobalCitations(args.sections);

  const lines: string[] = ["---"];
  lines.push(`type: report`);
  lines.push(`research_id: ${args.research_id}`);
  lines.push(`title: ${JSON.stringify(args.title)}`);
  lines.push(`scope: ${JSON.stringify(args.scope)}`);
  lines.push(`status: ${args.status}`);
  lines.push(`asked_at: ${new Date(args.startedAt).toISOString()}`);
  lines.push(`finished_at: ${new Date(args.finishedAt).toISOString()}`);
  lines.push(`duration_minutes: ${Math.round((args.finishedAt - args.startedAt) / 60000)}`);
  lines.push(`source_count: ${global.length}`);
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
  args.sections.forEach((s, sIdx) => {
    lines.push(`## ${s.title}`);
    lines.push("");
    const localMap = perSection.get(sIdx) ?? new Map<number, number>();
    lines.push(remapMarkers(s.body.trim(), localMap));
    lines.push("");
  });
  if (global.length > 0) {
    lines.push("## Sources");
    lines.push("");
    global.forEach((c, i) => {
      lines.push(formatCitation(c, i + 1));
    });
    lines.push("");
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

  // JSON schema for one citation entry. Mirrors CitationSchema (zod) above.
  // The renderer dedupes by `url` across sections and remaps per-section
  // markers to a global numbering on finalize.
  const citationItemSchema = {
    oneOf: [
      {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["youtube", "twitter", "substack", "blog", "web", "other"],
            description: "Source class. Drives the per-line format in the final ## Sources block.",
          },
          marker: {
            type: "integer",
            minimum: 1,
            description: "The [N] used INLINE in this section's body for this citation. Start at [1] for each section; the renderer remaps to a global numbering across the whole report on finalize.",
          },
          author: {
            type: "string",
            description: "Person, channel, or outlet that produced the source. e.g. 'Lex Fridman', 'Ben Thompson', or 'All-In Podcast' for a channel.",
          },
          title: {
            type: "string",
            description: "Episode title / tweet excerpt / article headline. Pull verbatim from the context.search hit's `title`.",
          },
          url: { type: "string", description: "Canonical URL. Used to dedupe identical sources across sections." },
          published_at: { type: "string", description: "ISO8601 publication date when known." },
          channel: { type: "string", description: "YouTube channel display name (use when type=youtube and the speaker/guest differs from the channel)." },
          handle: { type: "string", description: "X/Twitter handle including @ (use when type=twitter)." },
          outlet: { type: "string", description: "Publication / site name (use when type=substack|blog|web)." },
        },
        required: ["type", "marker", "author", "title", "url"],
      },
      { type: "string", description: "(Legacy) free-form citation string. Prefer the structured object above." },
    ],
  };

  const citationsExample =
    "Example body+citations: body=\"As Chamath Palihapitiya argued on All-In's \\\"E140: AI bubble or boom?\\\" the capex cycle is unsustainable [1], a view echoed by @balajis [2].\" "
    + "citations=[{type:'youtube',marker:1,author:'Chamath Palihapitiya',channel:'All-In Podcast',title:'E140: AI bubble or boom?',url:'https://youtu.be/abc',published_at:'2026-04-12'}, "
    + "{type:'twitter',marker:2,author:'Balaji Srinivasan',handle:'@balajis',title:'The capex cycle...',url:'https://x.com/balajis/status/123',published_at:'2026-04-29'}]";

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "report.write_section",
        description:
          "Append (or replace, by section_id) a section in the in-progress report. Useful for streaming sections one-at-a-time before calling finalize. "
          + "Every factual claim in `body` that draws on a source MUST (a) name the source in prose ('as said by X on YouTube channel Y', 'as tweeted by @handle', 'as <Outlet> reported') and (b) end with a [N] marker that matches a `citations` entry. "
          + "Markers are scoped to this single section — start at [1] in every section. The renderer dedupes by url across sections and emits a single ## Sources block at the end of the report. "
          + citationsExample,
        inputSchema: {
          type: "object",
          properties: {
            research_id: { type: "integer" },
            section_id: { type: "string" },
            title: { type: "string" },
            body: {
              type: "string",
              description: "Markdown body. Lead with a one-line bolded thesis, then paragraphs of evidence. Every sourced claim must (a) name the source in prose and (b) end with a [N] marker matching an entry in `citations`. Markers start at [1] for THIS section.",
            },
            citations: {
              type: "array",
              description: "Structured citations referenced by [N] markers in `body`. One entry per unique [N]. Strings are accepted for back-compat but the structured form is strongly preferred.",
              items: citationItemSchema,
            },
          },
          required: ["research_id", "section_id", "title", "body"],
        },
      },
      {
        name: "report.finalize",
        description:
          "Write the Markdown report to sherlock-vault/Reports/<yyyy-mm>/, commit + push the vault, and return the absolute path. Call exactly once near the end of the researcher run. "
          + "Citations across all sections are deduped by url and re-numbered globally; a single ## Sources block is emitted at the end of the document.",
        inputSchema: {
          type: "object",
          properties: {
            research_id: { type: "integer" },
            title: { type: "string" },
            scope: { type: "string", description: "One-sentence restatement of what was researched." },
            summary: { type: "string", description: "3-5 sentence TL;DR. Each sentence should be an answer/claim, not a description of what's inside." },
            sections: {
              type: "array",
              description: "If you didn't use write_section, you can pass all sections inline here. Same citation contract as write_section.",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  citations: { type: "array", items: citationItemSchema },
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
        diag(`WRITE_SECTION research_id=${a.research_id} section=${a.section_id} bodyChars=${a.body.length} citations=${a.citations?.length ?? 0}`);
        if (!startedAtById.has(a.research_id)) startedAtById.set(a.research_id, Date.now());
        const sections = loadSections(a.research_id);
        const idx = sections.findIndex((s) => s.section_id === a.section_id);
        const normalizedCitations = a.citations?.map((c, i) => normalizeCitation(c, i + 1));
        const next: InProgressSection = {
          section_id: a.section_id,
          title: a.title,
          body: a.body,
          ...(normalizedCitations && normalizedCitations.length > 0 && { citations: normalizedCitations }),
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
          ...(a.sections ?? []).map((s, i) => {
            const normalized = s.citations?.map((c, j) => normalizeCitation(c, j + 1));
            return {
              section_id: `inline-${i}`,
              title: s.title,
              body: s.body,
              ...(normalized && normalized.length > 0 && { citations: normalized }),
            };
          }),
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
