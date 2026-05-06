import type {
  ContextBrief,
  ContextFollowups,
  ContextStats,
  FollowupQuestion,
  SearchHit,
} from "./contracts.js";

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sourceLabel(source: string): string {
  switch (source) {
    case "youtube":
      return "YouTube";
    case "substack":
      return "Substack";
    case "twitter-people":
      return "X people";
    case "twitter-bookmarks":
      return "X bookmarks";
    case "blog":
      return "blogs";
    default:
      return source;
  }
}

function describeCoverage(hits: SearchHit[], stats: ContextStats): string {
  if (hits.length === 0) {
    return `The indexed corpus is currently thin on this topic; the tracked corpus has ${stats.total} total documents but nothing ranked for this query.`;
  }
  const sources = unique(hits.map((hit) => sourceLabel(hit.source)));
  const authors = unique(hits.map((hit) => hit.author).filter((value): value is string => Boolean(value))).slice(0, 3);
  const latest = hits
    .map((hit) => hit.published_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const authorText = authors.length > 0 ? ` Key voices include ${authors.join(", ")}.` : "";
  const dateText = latest ? ` The freshest matching material is from ${latest}.` : "";
  return `The topic currently retrieves ${hits.length} strong matches across ${sources.join(", ")}.${authorText}${dateText}`;
}

function buildThemes(hits: SearchHit[]): string[] {
  return unique(
    hits
      .slice(0, 5)
      .map((hit) => {
        const title = hit.title.replace(/^#+\s*/, "").trim();
        const split = title.split(/[:|-]/)[0]?.trim() ?? title;
        return split.length > 3 ? split : title;
      })
      .filter(Boolean),
  ).slice(0, 4);
}

function buildGaps(hits: SearchHit[]): string[] {
  if (hits.length === 0) {
    return ["No directly relevant indexed matches yet; use web reporting or broaden the tracked source list."];
  }
  const gaps: string[] = [];
  const sources = unique(hits.map((hit) => hit.source));
  if (sources.length === 1) {
    gaps.push(`Coverage is concentrated in ${sourceLabel(sources[0]!)}, so cross-source validation is still thin.`);
  }
  const dates = hits.map((hit) => hit.published_at).filter((value): value is string => Boolean(value)).sort();
  const oldest = dates.at(0);
  const newest = dates.at(-1);
  if (oldest && newest && oldest.slice(0, 7) === newest.slice(0, 7)) {
    gaps.push("Most matching material clusters in a narrow time window, so the longer-term baseline may be missing.");
  }
  return gaps;
}

function buildContradictions(hits: SearchHit[]): string[] {
  const bySource = unique(hits.map((hit) => hit.source));
  if (bySource.length >= 2) {
    return ["The corpus spans multiple source classes, so there may be a gap between live reactions and longer-form analysis that is worth testing explicitly."];
  }
  return [];
}

function buildRecommendations(hits: SearchHit[]): string[] {
  if (hits.length === 0) {
    return ["Ask a web-forward clarifying question before launching a researcher so the report scope is grounded in current reality rather than archive alone."];
  }
  const topSource = hits[0]?.source;
  const recs = [`Start with the highest-signal indexed cluster in ${sourceLabel(topSource ?? "the corpus")} before broadening the report scope.`];
  if (!hits.some((hit) => hit.source === "blog" || hit.source === "substack")) {
    recs.push("Supplement with web reporting because the indexed corpus is missing longer-form written analysis on this query.");
  }
  return recs;
}

function evidenceFor(hits: SearchHit[]): FollowupQuestion["evidence"] {
  return hits.slice(0, 2).map((hit) => ({
    title: hit.title,
    author: hit.author,
    source: hit.source,
    url: hit.url,
    published_at: hit.published_at,
  }));
}

export function buildBrief(_topic: string, hits: SearchHit[], stats: ContextStats): ContextBrief {
  return {
    summary: describeCoverage(hits, stats),
    themes: buildThemes(hits),
    gaps: buildGaps(hits),
    contradictions: buildContradictions(hits),
    recommendations: buildRecommendations(hits),
    hits,
  };
}

export function buildFollowups(topic: string, hits: SearchHit[], brief: ContextBrief): ContextFollowups {
  const questions: FollowupQuestion[] = [];
  if (hits.length === 0) {
    questions.push({
      question: `Should the report stay corpus-only on ${topic}, or should it broaden to live web coverage because your tracked sources are thin here?`,
      why: "The shared index does not yet contain strong matches, so the main choice is between staying strict and going web-forward.",
      evidence: [],
    });
  } else {
    const topSources = unique(hits.map((hit) => sourceLabel(hit.source)));
    const topAuthors = unique(hits.map((hit) => hit.author).filter((value): value is string => Boolean(value))).slice(0, 2);
    questions.push({
      question: `Should the report lean on ${topSources.join(" + ")} first, or should it widen immediately beyond the current indexed cluster?`,
      why: "The strongest matches are concentrated in a specific slice of the corpus, so source weighting will change the thesis you get back.",
      evidence: evidenceFor(hits),
    });
    if (topAuthors.length > 0) {
      questions.push({
        question: `Do you want the write-up to pressure-test the angle from ${topAuthors.join(" and ")}, or to treat them as background and search for the counter-view first?`,
        why: "A few recurring voices dominate the top matches, which is useful but risks narrowing the report too early.",
        evidence: evidenceFor(hits.slice(1)),
      });
    }
    if (brief.gaps.length > 0) {
      questions.push({
        question: `Should the researcher optimize for what your tracked sources already say, or explicitly fill the current coverage gaps before writing?`,
        why: brief.gaps[0]!,
        evidence: evidenceFor(hits.slice(2)),
      });
    }
  }

  const chosen = questions.slice(0, 3);
  const noteParts = [
    `Topic: ${topic}.`,
    brief.summary,
    brief.gaps.length > 0 ? `Gaps: ${brief.gaps.join(" ")}` : "",
    chosen.length > 0 ? `Suggested forks: ${chosen.map((item) => item.question).join(" ")}` : "",
  ].filter(Boolean);

  return {
    questions: chosen,
    handoff_note: noteParts.join(" "),
    hits,
  };
}
