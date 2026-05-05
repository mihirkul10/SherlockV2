/**
 * Single-file admin dashboard HTML.
 *
 * Served at GET /admin. Polls GET /admin/state every 3s and re-renders.
 * No build step, no React, no external assets — just one HTML string.
 *
 * Design goals:
 *   - Live: ticking timer, fresh data every 3s.
 *   - Dense: everything Mihir cares about visible without scrolling on
 *     a 1440px screen, but layout still works on a phone.
 *   - Honest: errors and stale data are visible (e.g. "fetch failed 5s ago").
 *   - Zero dependencies. Black-on-white, no clever fonts, no logos.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sherlock Admin</title>
<style>
  :root {
    --bg: #0d0e10;
    --panel: #15171b;
    --border: #25282e;
    --text: #e7e9ee;
    --dim: #8a8f9a;
    --accent: #6ea8ff;
    --ok: #3ddc97;
    --warn: #f1c552;
    --err: #ff6b6b;
    --running: #6ea8ff;
    --queued: #c97df0;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.45; }
  header { display: flex; align-items: baseline; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
  header .meta { color: var(--dim); font-size: 11.5px; }
  header .meta .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: 1px; animation: pulse 2s infinite; }
  header .meta.stale .live { background: var(--err); animation: none; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px 20px; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
  section.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  section.panel.full { grid-column: 1 / -1; }
  section.panel h2 { margin: 0; padding: 10px 14px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  section.panel h2 .count { font-weight: 400; color: var(--dim); font-size: 11px; }
  section.panel .body { padding: 8px 0; max-height: 360px; overflow-y: auto; }
  section.panel.full .body { max-height: 280px; }
  section.panel .body.tight { padding: 6px 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 14px; vertical-align: top; }
  th { font-weight: 500; color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  td.mono { white-space: nowrap; color: var(--dim); }
  td.text { white-space: pre-wrap; word-break: break-word; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10.5px; font-weight: 500; }
  .pill.running { background: rgba(110,168,255,0.15); color: var(--running); }
  .pill.queued  { background: rgba(201,125,240,0.15); color: var(--queued); }
  .pill.complete{ background: rgba(61,220,151,0.15); color: var(--ok); }
  .pill.error   { background: rgba(255,107,107,0.15); color: var(--err); }
  .pill.cancelled { background: rgba(138,143,154,0.15); color: var(--dim); }
  .pill.user      { background: rgba(110,168,255,0.10); color: var(--accent); }
  .pill.assistant { background: rgba(241,197,82,0.10); color: var(--warn); }
  .badge { display: inline-block; min-width: 24px; padding: 1px 6px; text-align: center; border-radius: 3px; background: rgba(255,255,255,0.06); color: var(--text); font-variant-numeric: tabular-nums; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; padding: 12px 14px; }
  .stat { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; }
  .stat .v { font-size: 18px; font-variant-numeric: tabular-nums; font-weight: 500; }
  .stat .l { color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  pre.log { margin: 0; padding: 8px 14px; font-size: 11px; line-height: 1.5; color: var(--dim); white-space: pre-wrap; word-break: break-all; }
  pre.log .l-info { color: var(--ok); }
  pre.log .l-warn { color: var(--warn); }
  pre.log .l-error { color: var(--err); }
  .empty { padding: 18px 14px; color: var(--dim); font-style: italic; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  details { padding: 6px 14px; }
  summary { cursor: pointer; color: var(--dim); font-size: 11.5px; padding: 4px 0; }
  details[open] summary { color: var(--text); }
</style>
</head>
<body>

<header>
  <h1>Sherlock Admin</h1>
  <div class="meta" id="meta">
    <span class="live"></span>
    <span id="metatext">connecting…</span>
  </div>
</header>

<main id="root">
  <section class="panel full"><h2>Loading…</h2><div class="body"><div class="empty">Fetching first snapshot…</div></div></section>
</main>

<script>
let lastOk = 0;
let lastError = null;

function fmtAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}
function fmtMin(min) {
  if (min == null) return "—";
  if (min < 1) return Math.round(min * 60) + "s";
  if (min < 60) return min.toFixed(1) + "m";
  return (min / 60).toFixed(1) + "h";
}
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
}
function pillStatus(status) {
  return '<span class="pill ' + esc(status) + '">' + esc(status) + '</span>';
}
function colorizeLog(line) {
  let cls = "";
  if (/ERROR/.test(line)) cls = "l-error";
  else if (/WARN/.test(line)) cls = "l-warn";
  else if (/INFO/.test(line)) cls = "l-info";
  // strip ANSI escape sequences
  const clean = line.replace(/\\x1B\\[[0-9;]*[a-zA-Z]/g, "").replace(/\\u001b\\[[0-9;]*[a-zA-Z]/g, "");
  return cls ? '<span class="' + cls + '">' + esc(clean) + "</span>" : esc(clean);
}

function render(s) {
  const root = document.getElementById("root");
  const html = [];

  // ─── Header strip: top-line stats ────────────────────────────────
  const corpusByline = Object.entries(s.corpus.by_source || {}).map(
    ([k, v]) => k + ": " + v
  ).join(" · ") || "no docs";
  const sourceCounts = Object.entries(s.sources.counts || {}).map(
    ([k, v]) => k.replace(/_/g, "-") + ": " + v
  ).join(" · ") || "no sources";

  html.push(
    '<section class="panel full">' +
    '<h2>Overview <span class="count">PID ' + s.bridge.pid + ' · port ' + s.bridge.port + ' · uptime ' + s.bridge.uptime_s + 's</span></h2>' +
    '<div class="stat-grid">' +
      '<div class="stat"><div class="v">' + (s.research.active.length) + '</div><div class="l">research running</div></div>' +
      '<div class="stat"><div class="v">' + (s.research.counts_by_status.complete || 0) + '</div><div class="l">reports complete</div></div>' +
      '<div class="stat"><div class="v">' + s.corpus.total + '</div><div class="l">corpus docs</div></div>' +
      '<div class="stat"><div class="v">' + s.vault.reports_count + '</div><div class="l">vault reports</div></div>' +
      '<div class="stat"><div class="v">' + (s.conversations.chats.length) + '</div><div class="l">active chats</div></div>' +
      '<div class="stat"><div class="v">' + (s.ingest_runs.filter(r => r.ok).length) + "/" + s.ingest_runs.length + '</div><div class="l">ingests ok</div></div>' +
    '</div>' +
    '<div class="body tight" style="color:var(--dim);font-size:11px;">' +
      'corpus by source: ' + esc(corpusByline) + '<br/>' +
      'sources tracked: ' + esc(sourceCounts) +
    '</div>' +
    '</section>'
  );

  // ─── Active research (live) ──────────────────────────────────────
  html.push('<section class="panel"><h2>Research — Active <span class="count">' + s.research.active.length + '</span></h2><div class="body">');
  if (s.research.active.length === 0) {
    html.push('<div class="empty">No active research jobs.</div>');
  } else {
    html.push('<table><thead><tr><th>#</th><th>Topic</th><th>Status</th><th>Elapsed</th></tr></thead><tbody>');
    for (const r of s.research.active) {
      html.push('<tr><td class="mono">' + r.id + '</td><td class="text">' + esc(r.topic) + '</td><td>' + pillStatus(r.status) + '</td><td class="mono">' + fmtMin(r.elapsed_min) + '</td></tr>');
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // ─── Recent research ─────────────────────────────────────────────
  html.push('<section class="panel"><h2>Research — Recent <span class="count">' + s.research.recent.length + '</span></h2><div class="body">');
  if (s.research.recent.length === 0) {
    html.push('<div class="empty">No research history yet.</div>');
  } else {
    html.push('<table><thead><tr><th>#</th><th>Topic</th><th>Status</th><th>Dur</th></tr></thead><tbody>');
    for (const r of s.research.recent) {
      html.push('<tr><td class="mono">' + r.id + '</td><td class="text">' +
        esc(r.topic).slice(0,80) +
        (r.tldr ? '<br/><span style="color:var(--dim);font-size:11px;">' + esc(r.tldr).slice(0,200) + '</span>' : '') +
        (r.error ? '<br/><span style="color:var(--err);font-size:11px;">' + esc(r.error).slice(0,200) + '</span>' : '') +
        '</td><td>' + pillStatus(r.status) + '</td><td class="mono">' + fmtMin(r.duration_min) + '</td></tr>');
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // ─── Recent iMessage turns ──────────────────────────────────────
  html.push('<section class="panel"><h2>iMessage — Recent <span class="count">' + s.conversations.recent_messages.length + '</span></h2><div class="body">');
  if (s.conversations.recent_messages.length === 0) {
    html.push('<div class="empty">No messages yet.</div>');
  } else {
    html.push('<table><thead><tr><th>When</th><th>Role</th><th>Text</th></tr></thead><tbody>');
    for (const m of s.conversations.recent_messages) {
      html.push('<tr><td class="mono">' + fmtAgo(m.ts) + '</td><td>' + pillStatus(m.role) + '</td><td class="text">' + esc(m.text) + '</td></tr>');
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // ─── Active chats ───────────────────────────────────────────────
  html.push('<section class="panel"><h2>Chats <span class="count">' + s.conversations.chats.length + '</span></h2><div class="body">');
  if (s.conversations.chats.length === 0) {
    html.push('<div class="empty">No conversations.</div>');
  } else {
    html.push('<table><thead><tr><th>Chat</th><th>Msgs</th><th>Last</th><th>Preview</th></tr></thead><tbody>');
    for (const c of s.conversations.chats) {
      html.push('<tr><td class="mono">' + esc(c.chat_guid).slice(0,40) + '</td><td><span class="badge">' + c.message_count + '</span></td><td class="mono">' + fmtAgo(c.last_ts) + '</td><td class="text">' + pillStatus(c.last_role) + ' ' + esc(c.last_text).slice(0,80) + '</td></tr>');
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // ─── Ingest runs ────────────────────────────────────────────────
  html.push('<section class="panel"><h2>Ingest runs <span class="count">' + s.ingest_runs.length + '</span></h2><div class="body">');
  if (s.ingest_runs.length === 0) {
    html.push('<div class="empty">No ingest runs logged.</div>');
  } else {
    html.push('<table><thead><tr><th>When</th><th>Source</th><th>OK</th><th>Added</th><th>Skip</th><th>Fail</th></tr></thead><tbody>');
    for (const r of s.ingest_runs) {
      html.push('<tr><td class="mono">' + esc(String(r.ts).slice(5,16)) + '</td><td>' + esc(r.type) + '</td><td>' + (r.ok ? '<span class="pill complete">ok</span>' : '<span class="pill error">fail</span>') + '</td><td class="mono">' + (r.items_added ?? '—') + '</td><td class="mono">' + (r.items_skipped ?? '—') + '</td><td class="mono">' + (r.items_failed ?? '—') + '</td></tr>');
      if (r.error) {
        html.push('<tr><td colspan="6" style="color:var(--err);font-size:11px;padding-left:30px;">' + esc(r.error).slice(0,260) + '</td></tr>');
      }
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // ─── Sources roster ─────────────────────────────────────────────
  html.push('<section class="panel"><h2>Sources roster</h2><div class="body">');
  const renderList = (label, arr, fields) => {
    if (!arr || arr.length === 0) return;
    html.push('<details><summary>' + esc(label) + ' (' + arr.length + ')</summary>');
    html.push('<div style="padding:0 14px 8px;color:var(--dim);font-size:11px;">');
    for (const s of arr) {
      const parts = fields.map((f) => s[f]).filter(Boolean);
      html.push(esc(parts.join(' · ')) + '<br/>');
    }
    html.push('</div></details>');
  };
  renderList('YouTube', s.sources.youtube, ['name','handle','channel_id','id']);
  renderList('Twitter/X people', s.sources.twitter_people, ['name','handle','id']);
  renderList('Substack', s.sources.substack, ['name','subdomain','id']);
  renderList('Blogs', s.sources.blog, ['name','url','id']);
  if (Object.keys(s.sources.counts || {}).length === 0) {
    html.push('<div class="empty">No sources configured.</div>');
  }
  html.push('</div></section>');

  // ─── Vault reports ──────────────────────────────────────────────
  html.push('<section class="panel"><h2>Vault — Recent reports <span class="count">' + s.vault.reports_count + '</span></h2><div class="body">');
  if (s.vault.recent_reports.length === 0) {
    html.push('<div class="empty">No reports written yet.</div>');
  } else {
    html.push('<table><thead><tr><th>When</th><th>Name</th><th>Size</th></tr></thead><tbody>');
    for (const r of s.vault.recent_reports) {
      html.push('<tr><td class="mono">' + fmtAgo(r.modified_at) + '</td><td class="text">' + esc(r.name) + '</td><td class="mono">' + Math.round(r.size/1024) + ' KB</td></tr>');
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // ─── Bridge log tail ────────────────────────────────────────────
  html.push('<section class="panel full"><h2>Bridge log <span class="count">last 50</span></h2><div class="body"><pre class="log">');
  if (s.logs.bridge_tail.length === 0) {
    html.push('(empty)');
  } else {
    html.push(s.logs.bridge_tail.map(colorizeLog).join("\\n"));
  }
  html.push('</pre></div></section>');

  // ─── MCP context-search log tail ────────────────────────────────
  html.push('<section class="panel full"><h2>MCP — context.search recent calls <span class="count">last 25</span></h2><div class="body"><pre class="log">');
  if (s.logs.mcp_context_tail.length === 0) {
    html.push('(empty)');
  } else {
    html.push(s.logs.mcp_context_tail.map(colorizeLog).join("\\n"));
  }
  html.push('</pre></div></section>');

  root.innerHTML = html.join("");
}

function setMetaOk(generatedAt) {
  document.getElementById("meta").classList.remove("stale");
  document.getElementById("metatext").textContent =
    "live · refreshed " + fmtAgo(new Date(generatedAt).getTime());
}
function setMetaError(err) {
  document.getElementById("meta").classList.add("stale");
  document.getElementById("metatext").textContent =
    "fetch failed: " + (err || "unknown") + (lastOk ? " · last ok " + fmtAgo(lastOk) : "");
}

async function tick() {
  try {
    const r = await fetch("/admin/state", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const s = await r.json();
    render(s);
    lastOk = Date.now();
    lastError = null;
    setMetaOk(s.generated_at);
  } catch (e) {
    lastError = e.message || String(e);
    setMetaError(lastError);
  }
}

tick();
setInterval(tick, 3000);
// Also re-render the meta every second so "Xs ago" stays fresh.
setInterval(() => {
  if (lastError) setMetaError(lastError);
  else if (lastOk) {
    document.getElementById("metatext").textContent = "live · refreshed " + fmtAgo(lastOk);
  }
}, 1000);
</script>
</body>
</html>`;
