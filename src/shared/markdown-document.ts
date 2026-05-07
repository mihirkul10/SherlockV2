export interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

/** Minimal frontmatter parser for Sherlock's normalized markdown shape. */
export function parseMarkdown(text: string): ParsedMarkdown {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) continue;

    let value = kv[2]!.trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
    }
    frontmatter[kv[1]!] = value;
  }

  return { frontmatter, body: match[2]!.trim() };
}
