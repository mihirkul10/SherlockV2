/**
 * Admin dashboard HTML.
 *
 * Two pages:
 *   - DASHBOARD_HTML  → /admin
 *       Polls /admin/state, /admin/services/status, /admin/sources, /admin/logs
 *       every 3s and re-renders. Includes the single Start/Stop Sherlock
 *       master button at the top.
 *   - LOG_TAIL_HTML(name) → /admin/logs/:name
 *       Polls /admin/logs/:name?lines=1000 every 2s and renders the raw tail.
 *
 * No build step, no React, no external assets.
 */

export const DASHBOARD_HTML = `<!doctype html>
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

  /* ─── Master Start/Stop strip ─── */
  .master { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .master-button { font: inherit; font-size: 14px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 28px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; min-width: 200px; transition: opacity 0.15s, transform 0.05s; }
  .master-button:active { transform: translateY(1px); }
  .master-button:disabled { opacity: 0.5; cursor: progress; }
  .master-button.start { background: rgba(61,220,151,0.15); color: var(--ok); border-color: rgba(61,220,151,0.4); }
  .master-button.stop  { background: rgba(255,107,107,0.15); color: var(--err); border-color: rgba(255,107,107,0.4); }
  .master-button.partial { background: rgba(241,197,82,0.15); color: var(--warn); border-color: rgba(241,197,82,0.4); }
  .master-button:hover:not(:disabled) { filter: brightness(1.15); }
  .master-status { font-size: 12.5px; color: var(--dim); flex: 1; }
  .master-status .word { font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; font-size: 11.5px; padding: 2px 8px; border-radius: 3px; margin-right: 8px; }
  .master-status .word.running { background: rgba(61,220,151,0.15); color: var(--ok); }
  .master-status .word.stopped { background: rgba(255,107,107,0.15); color: var(--err); }
  .master-status .word.partial { background: rgba(241,197,82,0.15); color: var(--warn); }
  .master-result { font-size: 11.5px; color: var(--dim); white-space: pre; max-height: 80px; overflow: auto; }
  .master-result.err { color: var(--err); }

  main { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px 20px; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
  section.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  section.panel.full { grid-column: 1 / -1; }
  section.panel h2 { margin: 0; padding: 10px 14px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  section.panel h2 .count { font-weight: 400; color: var(--dim); font-size: 11px; }
  section.panel .body { padding: 8px 0; max-height: 360px; overflow-y: auto; }
  section.panel.full .body { max-height: 280px; }
  section.panel .body.tight { padding: 6px 14px; }
  section.panel .body.tall { max-height: 480px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 14px; vertical-align: top; }
  th { font-weight: 500; color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  td.mono { white-space: nowrap; color: var(--dim); }
  td.text { white-space: pre-wrap; word-break: break-word; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
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

  /* ─── Sources tabs ─── */
  .tabs { display: flex; gap: 4px; padding: 0 14px; border-bottom: 1px solid var(--border); }
  .tab { background: none; border: none; color: var(--dim); padding: 8px 12px; cursor: pointer; font: inherit; font-size: 11.5px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab .n { color: var(--dim); margin-left: 4px; font-variant-numeric: tabular-nums; }

  /* ─── Logs list ─── */
  table.logs td { font-size: 12px; }
  table.logs a { font-weight: 500; }
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

<div class="master">
  <button id="masterBtn" class="master-button" disabled>…</button>
  <div class="master-status" id="masterStatus">checking services…</div>
</div>
<div class="master-result" id="masterResult" style="padding:0 20px 12px;"></div>

<main id="root">
  <section class="panel full"><h2>Loading…</h2><div class="body"><div class="empty">Fetching first snapshot…</div></div></section>
</main>

<script>
let lastOk = 0;
let lastError = null;
let activeTab = "youtube";
let lastSources = null;
let lastLogs = null;

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
function fmtSize(b) {
  if (b == null) return "—";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
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
  const clean = line.replace(/\\x1B\\[[0-9;]*[a-zA-Z]/g, "").replace(/\\u001b\\[[0-9;]*[a-zA-Z]/g, "");
  return cls ? '<span class="' + cls + '">' + esc(clean) + "</span>" : esc(clean);
}

// ─── Master button ────────────────────────────────────────────────
async function refreshMaster() {
  try {
    const r = await fetch("/admin/services/status", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const s = await r.json();
    const btn = document.getElementById("masterBtn");
    const sts = document.getElementById("masterStatus");
    btn.disabled = false;
    btn.classList.remove("start", "stop", "partial");
    if (s.state === "running") {
      btn.textContent = "Stop Sherlock";
      btn.classList.add("stop");
      btn.dataset.action = "stop";
    } else if (s.state === "stopped") {
      btn.textContent = "Start Sherlock";
      btn.classList.add("start");
      btn.dataset.action = "start";
    } else {
      btn.textContent = "Start Sherlock";
      btn.classList.add("partial");
      btn.dataset.action = "start";
    }
    const wordCls = s.state;
    const word = '<span class="word ' + wordCls + '">' + s.state + '</span>';
    const detail = s.services.map((svc) => {
      const short = svc.label.replace(/^com\\.sherlock\\./, "");
      // ● = loaded + currently running process
      // ◐ = loaded + idle (normal for cron-style context-sync / vault-sync between ticks)
      // ○ = not loaded
      let mark = "○";
      if (svc.loaded && svc.state === "running") mark = "●";
      else if (svc.loaded) mark = "◐";
      return mark + " " + short;
    }).join("   ");
    sts.innerHTML = word + s.running + " of " + s.total + " loaded &nbsp;&nbsp; " + esc(detail);
  } catch (e) {
    document.getElementById("masterStatus").textContent = "service status unavailable: " + (e.message || e);
  }
}
async function clickMaster() {
  const btn = document.getElementById("masterBtn");
  const action = btn.dataset.action;
  if (!action) return;
  const verb = action === "stop" ? "Stop" : "Start";
  if (!confirm(verb + " Sherlock — " + verb.toLowerCase() + " all primary services?")) return;
  btn.disabled = true;
  btn.textContent = (action === "stop" ? "Stopping…" : "Starting…");
  const result = document.getElementById("masterResult");
  result.classList.remove("err");
  result.textContent = "";
  try {
    const r = await fetch("/admin/services/" + action, { method: "POST" });
    const j = await r.json();
    const lines = (j.results || []).map((x) => (x.ok ? "✓" : "✗") + " " + x.label + " — " + x.message);
    result.textContent = lines.join("\\n");
    if (!j.ok) result.classList.add("err");
  } catch (e) {
    result.textContent = "request failed: " + (e.message || e);
    result.classList.add("err");
  }
  // Force a refresh; button will re-enable on next refreshMaster().
  await refreshMaster();
}

// ─── Sources Covered ───────────────────────────────────────────────
async function refreshSources() {
  try {
    const r = await fetch("/admin/sources", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    lastSources = await r.json();
  } catch { /* keep stale */ }
}
function renderSourcesPanel() {
  const tabs = [
    { key: "youtube",          label: "YouTube" },
    { key: "twitter_people",   label: "Twitter people" },
    { key: "substack",         label: "Substack" },
    { key: "blog",             label: "Blogs" },
    { key: "twitter_bookmarks",label: "Bookmarks" },
  ];
  const html = [];
  html.push('<section class="panel full"><h2>Sources covered <span class="count">' +
    (lastSources ? new Date(lastSources.generated_at).toLocaleTimeString() : "—") + '</span></h2>');
  html.push('<div class="tabs">');
  for (const t of tabs) {
    const n = lastSources ? (lastSources[t.key] || []).length : 0;
    html.push('<button class="tab ' + (t.key === activeTab ? 'active' : '') +
      '" data-tab="' + t.key + '">' + esc(t.label) + '<span class="n">' + n + '</span></button>');
  }
  html.push('</div><div class="body tall" data-skey="sources-' + activeTab + '">');
  if (!lastSources) {
    html.push('<div class="empty">Loading sources…</div>');
  } else {
    const rows = lastSources[activeTab] || [];
    if (rows.length === 0) {
      html.push('<div class="empty">No items configured for this source.</div>');
    } else {
      html.push('<table><thead><tr><th>Name</th><th>Handle / URL</th><th class="num">Items</th><th>Last checked</th><th>Last item</th></tr></thead><tbody>');
      for (const row of rows) {
        const handleOrUrl = row.handle || row.url || "";
        const lastChecked = row.last_checked ? fmtAgo(new Date(row.last_checked).getTime()) : "—";
        // Real errors render in red; "no content available" notes (e.g. YT
        // videos with captions disabled) render dim — they're not failures.
        const errCell = row.last_error
          ? '<br/><span style="color:var(--err);font-size:11px;">' + esc(row.last_error).slice(0, 200) + '</span>'
          : "";
        html.push('<tr>' +
          '<td class="text">' + esc(row.name || row.key || "") + errCell + '</td>' +
          '<td class="text"><span style="color:var(--dim)">' + esc(handleOrUrl) + '</span></td>' +
          '<td class="num"><span class="badge">' + (row.items_known || 0) + '</span></td>' +
          '<td class="mono">' + esc(lastChecked) + '</td>' +
          '<td class="mono">' + esc(row.last_item_id || "—") + '</td>' +
        '</tr>');
      }
      html.push('</tbody></table>');
    }
  }
  html.push('</div></section>');
  return html.join("");
}

// ─── Corpus panel ───────────────────────────────────────────────────
function renderCorpusPanel(s) {
  const html = [];
  const total = s.corpus.total || 0;
  const bySource = s.corpus.by_source || {};
  const backend = s.corpus.backend ? esc(s.corpus.backend) : "unknown-backend";
  html.push('<section class="panel full"><h2>Corpus <span class="count">' + total + ' docs · ' + backend + ' · <a href="/admin/corpus" target="_blank" rel="noopener">open corpus explorer ›</a></span></h2><div class="body tight">');
  if (s.corpus.error) {
    html.push('<div class="empty" style="color:var(--err);font-style:normal;">Corpus stats failed: ' + esc(s.corpus.error) + '</div>');
  } else if (total === 0) {
    html.push('<div class="empty">Corpus is empty. Run an ingest to populate it.</div>');
  } else {
    html.push('<div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px;">');
    for (const [src, n] of Object.entries(bySource).sort((a,b) => b[1] - a[1])) {
      html.push('<a href="/admin/corpus?source=' + encodeURIComponent(src) + '" target="_blank" rel="noopener" class="badge" style="text-decoration:none;padding:4px 10px;font-size:12px;background:rgba(110,168,255,0.10);border:1px solid var(--border);">' + esc(src) + ' <span style="color:var(--dim);margin-left:4px;">' + n + '</span></a>');
    }
    html.push('</div>');
    html.push('<div style="padding:0 14px 12px;color:var(--dim);font-size:11px;">Click a source above to browse. Explorer results come from the same configured corpus backend shown here.</div>');
  }
  html.push('</div></section>');
  return html.join("");
}

// ─── Logs panel ─────────────────────────────────────────────────────
async function refreshLogs() {
  try {
    const r = await fetch("/admin/logs", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    lastLogs = await r.json();
  } catch { /* keep stale */ }
}
function renderLogsPanel() {
  const html = [];
  const total = lastLogs ? lastLogs.logs.length : 0;
  html.push('<section class="panel full"><h2>Logs <span class="count">' + total + ' files</span></h2><div class="body tall" data-skey="logs">');
  if (!lastLogs) {
    html.push('<div class="empty">Loading logs…</div>');
  } else {
    html.push('<table class="logs"><thead><tr><th>Service</th><th>File</th><th class="num">Size</th><th>Modified</th><th></th></tr></thead><tbody>');
    for (const f of lastLogs.logs) {
      const link = '<a href="/admin/logs/' + encodeURIComponent(f.name) + '" target="_blank" rel="noopener">' + esc(f.label) + '</a>';
      const path = '<span style="color:var(--dim)">' + esc(f.path) + '</span>';
      const size = f.exists ? fmtSize(f.size) : '<span style="color:var(--dim)">missing</span>';
      const mod  = f.exists && f.modified_at ? fmtAgo(f.modified_at) : "—";
      const open = f.exists ? '<a href="/admin/logs/' + encodeURIComponent(f.name) + '" target="_blank" rel="noopener">open ›</a>' : "";
      html.push('<tr><td class="text">' + link + '</td><td class="text">' + path + '</td><td class="num mono">' + size + '</td><td class="mono">' + esc(mod) + '</td><td class="mono">' + open + '</td></tr>');
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');
  return html.join("");
}

// ─── Main snapshot render ──────────────────────────────────────────
function render(s) {
  const root = document.getElementById("root");
  const html = [];

  const corpusByline = Object.entries(s.corpus.by_source || {}).map(
    ([k, v]) => k + ": " + v
  ).join(" · ") || "no docs";
  const corpusBackend = s.corpus.backend || "unknown-backend";
  const sourceCounts = Object.entries(s.sources.counts || {}).map(
    ([k, v]) => k.replace(/_/g, "-") + ": " + v
  ).join(" · ") || "no sources";

  html.push(
    '<section class="panel full">' +
    '<h2>Overview <span class="count">admin PID ' + s.bridge.pid + ' · port ' + s.bridge.port + ' · uptime ' + s.bridge.uptime_s + 's</span></h2>' +
    '<div class="stat-grid">' +
      '<div class="stat"><div class="v">' + (s.research.active.length) + '</div><div class="l">research running</div></div>' +
      '<div class="stat"><div class="v">' + (s.research.counts_by_status.complete || 0) + '</div><div class="l">reports complete</div></div>' +
      '<div class="stat"><div class="v">' + s.corpus.total + '</div><div class="l">corpus docs</div></div>' +
      '<div class="stat"><div class="v">' + s.vault.reports_count + '</div><div class="l">vault reports</div></div>' +
      '<div class="stat"><div class="v">' + (s.conversations.chats.length) + '</div><div class="l">active chats</div></div>' +
      '<div class="stat"><div class="v">' + (s.ingest_runs.filter(r => r.ok).length) + "/" + s.ingest_runs.length + '</div><div class="l">ingests ok</div></div>' +
    '</div>' +
    '<div class="body tight" style="color:var(--dim);font-size:11px;">' +
      'corpus backend: ' + esc(corpusBackend) + '<br/>' +
      'corpus by source: ' + esc(corpusByline) + '<br/>' +
      'sources tracked: ' + esc(sourceCounts) +
    '</div>' +
    '</section>'
  );

  // Sources Covered (above noisier panels)
  html.push(renderSourcesPanel());

  // Corpus panel (preview + link to dedicated explorer)
  html.push(renderCorpusPanel(s));

  // Logs panel
  html.push(renderLogsPanel());

  // Active research
  html.push('<section class="panel"><h2>Research — Active <span class="count">' + s.research.active.length + '</span></h2><div class="body" data-skey="research-active">');
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

  // Recent research
  html.push('<section class="panel"><h2>Research — Recent <span class="count">' + s.research.recent.length + '</span></h2><div class="body" data-skey="research-recent">');
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

  // Recent iMessage turns
  html.push('<section class="panel"><h2>iMessage — Recent <span class="count">' + s.conversations.recent_messages.length + '</span></h2><div class="body" data-skey="imessage">');
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

  // Active chats
  html.push('<section class="panel"><h2>Chats <span class="count">' + s.conversations.chats.length + '</span></h2><div class="body" data-skey="chats">');
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

  // Ingest runs — status pill maps from the producer's tri-state:
  //   ok      → green   (run succeeded)
  //   partial → yellow  (run succeeded; some items had no content, e.g. YT
  //                      videos with captions disabled — that's normal)
  //   error   → red     (the run itself failed)
  html.push('<section class="panel"><h2>Ingest runs <span class="count">' + s.ingest_runs.length + '</span></h2><div class="body" data-skey="ingest">');
  if (s.ingest_runs.length === 0) {
    html.push('<div class="empty">No ingest runs logged.</div>');
  } else {
    html.push('<table><thead><tr><th>When</th><th>Source</th><th>Status</th><th class="num">Added</th><th class="num">No content</th></tr></thead><tbody>');
    for (const r of s.ingest_runs) {
      let pill;
      if (r.status === "ok") pill = '<span class="pill complete">ok</span>';
      else if (r.status === "partial") pill = '<span class="pill assistant">partial</span>';
      else pill = '<span class="pill error">error</span>';
      const addedCell = (r.items_added != null && r.items_added > 0)
        ? '<span class="badge">+' + r.items_added + '</span>'
        : '0';
      const noContentCell = (r.items_no_content != null && r.items_no_content > 0)
        ? '<span style="color:var(--dim);">' + r.items_no_content + '</span>'
        : '—';
      const sel = r.selector ? '<br/><span style="color:var(--dim);font-size:10.5px;">' + esc(r.selector) + '</span>' : "";
      html.push('<tr><td class="mono">' + esc(String(r.ts).slice(5,16)) + '</td><td>' + esc(r.type) + sel + '</td><td>' + pill + '</td><td class="num mono">' + addedCell + '</td><td class="num mono">' + noContentCell + '</td></tr>');
      if (r.error) {
        html.push('<tr><td colspan="5" style="color:var(--err);font-size:11px;padding-left:30px;">' + esc(r.error).slice(0,260) + '</td></tr>');
      }
    }
    html.push('</tbody></table>');
  }
  html.push('</div></section>');

  // Vault reports
  html.push('<section class="panel"><h2>Vault — Recent reports <span class="count">' + s.vault.reports_count + '</span></h2><div class="body" data-skey="vault">');
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

  // Bridge log tail (inline preview; full viewer is in Logs panel above)
  html.push('<section class="panel full"><h2>Bridge log <span class="count">last 50</span></h2><div class="body" data-skey="bridge-log"><pre class="log">');
  if (s.logs.bridge_tail.length === 0) {
    html.push('(empty)');
  } else {
    html.push(s.logs.bridge_tail.map(colorizeLog).join("\\n"));
  }
  html.push('</pre></div></section>');

  // MCP context-search log tail
  html.push('<section class="panel full"><h2>MCP — context.search recent calls <span class="count">last 25</span></h2><div class="body" data-skey="mcp-log"><pre class="log">');
  if (s.logs.mcp_context_tail.length === 0) {
    html.push('(empty)');
  } else {
    html.push(s.logs.mcp_context_tail.map(colorizeLog).join("\\n"));
  }
  html.push('</pre></div></section>');

  // Snapshot scroll positions (window + every panel body) so the user's
  // scroll doesn't slam back to the top on the 3s re-render.
  const winScrollY = window.scrollY;
  const bodyScrolls = new Map();
  for (const el of root.querySelectorAll("[data-skey]")) {
    bodyScrolls.set(el.getAttribute("data-skey"), el.scrollTop);
  }

  root.innerHTML = html.join("");

  // Restore scroll positions.
  for (const el of root.querySelectorAll("[data-skey]")) {
    const k = el.getAttribute("data-skey");
    if (bodyScrolls.has(k)) el.scrollTop = bodyScrolls.get(k);
  }
  window.scrollTo(0, winScrollY);

  // Wire up tab clicks (re-bind on every render)
  for (const el of document.querySelectorAll(".tab[data-tab]")) {
    el.addEventListener("click", () => {
      activeTab = el.dataset.tab;
      // Just re-render — no fetch needed.
      render(window.__lastSnapshot || s);
    });
  }
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
    // Refresh master button + sources + logs in parallel with the main snapshot.
    const [snapResp] = await Promise.all([
      fetch("/admin/state", { cache: "no-store" }),
      refreshMaster(),
      refreshSources(),
      refreshLogs(),
    ]);
    if (!snapResp.ok) throw new Error("HTTP " + snapResp.status);
    const s = await snapResp.json();
    window.__lastSnapshot = s;
    render(s);
    lastOk = Date.now();
    lastError = null;
    setMetaOk(s.generated_at);
  } catch (e) {
    lastError = e.message || String(e);
    setMetaError(lastError);
  }
}

document.getElementById("masterBtn").addEventListener("click", clickMaster);

tick();
setInterval(tick, 3000);
setInterval(() => {
  if (lastError) setMetaError(lastError);
  else if (lastOk) {
    document.getElementById("metatext").textContent = "live · refreshed " + fmtAgo(lastOk);
  }
}, 1000);
</script>
</body>
</html>`;

/**
 * Standalone log-tail page. Polls /admin/logs/:name every 2s.
 * Server substitutes the log name into the title and initial fetch URL.
 */
export function logTailHtml(name: string, label: string): string {
  // name and label come from the registry — never user input.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sherlock Logs — ${label}</title>
<style>
  :root { --bg:#0d0e10; --panel:#15171b; --border:#25282e; --text:#e7e9ee; --dim:#8a8f9a; --ok:#3ddc97; --warn:#f1c552; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  header { display: flex; align-items: baseline; gap: 16px; padding: 12px 18px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
  header h1 { margin: 0; font-size: 13px; font-weight: 600; }
  header .meta { color: var(--dim); font-size: 11.5px; }
  header a { color: var(--dim); text-decoration: none; font-size: 11.5px; margin-left: auto; }
  header a:hover { color: var(--text); }
  header label { color: var(--dim); font-size: 11.5px; }
  header select { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 2px 6px; border-radius: 3px; font: inherit; font-size: 11.5px; }
  header button { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 2px 8px; border-radius: 3px; font: inherit; font-size: 11.5px; cursor: pointer; }
  header button.on { color: var(--ok); border-color: var(--ok); }
  pre { margin: 0; padding: 12px 18px; white-space: pre-wrap; word-break: break-all; line-height: 1.45; color: var(--text); }
  pre .l-info { color: var(--ok); }
  pre .l-warn { color: var(--warn); }
  pre .l-error { color: var(--err); }
  .empty { padding: 24px 18px; color: var(--dim); font-style: italic; }
</style>
</head>
<body>

<header>
  <h1>${label}</h1>
  <span class="meta" id="meta">loading…</span>
  <label>lines:
    <select id="lines">
      <option value="200">200</option>
      <option value="1000" selected>1000</option>
      <option value="3000">3000</option>
      <option value="5000">5000</option>
    </select>
  </label>
  <button id="autoBtn" class="on">auto-tail: on</button>
  <a href="/admin">← dashboard</a>
</header>

<pre id="out" class="empty">Loading…</pre>

<script>
const NAME = ${JSON.stringify(name)};
let auto = true;
let lastOk = 0;
let timer = null;

function colorize(line) {
  let cls = "";
  if (/ERROR/.test(line)) cls = "l-error";
  else if (/WARN/.test(line)) cls = "l-warn";
  else if (/INFO/.test(line)) cls = "l-info";
  const clean = line.replace(/\\x1B\\[[0-9;]*[a-zA-Z]/g, "").replace(/\\u001b\\[[0-9;]*[a-zA-Z]/g, "");
  const escaped = clean.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
  return cls ? '<span class="' + cls + '">' + escaped + "</span>" : escaped;
}
function fmtAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s + "s ago";
  return Math.round(s / 60) + "m ago";
}

async function tick() {
  const lines = parseInt(document.getElementById("lines").value, 10) || 1000;
  try {
    const r = await fetch("/admin/logs/" + encodeURIComponent(NAME) + "?lines=" + lines, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const out = document.getElementById("out");
    const wasAtBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 50);
    if (!j.exists) {
      out.className = "empty";
      out.textContent = "(file does not exist: " + j.path + ")";
    } else if (j.text === "") {
      out.className = "empty";
      out.textContent = "(empty)";
    } else {
      out.className = "";
      out.innerHTML = j.text.split("\\n").map(colorize).join("\\n");
    }
    lastOk = Date.now();
    document.getElementById("meta").textContent =
      j.shown_lines + " of " + j.total_lines + " lines · " + fmtAgo(lastOk);
    if (auto && wasAtBottom) window.scrollTo(0, document.body.scrollHeight);
  } catch (e) {
    document.getElementById("meta").textContent = "fetch failed: " + (e.message || e);
  }
}

function startAuto() { if (timer) return; timer = setInterval(tick, 2000); }
function stopAuto()  { if (!timer) return; clearInterval(timer); timer = null; }

document.getElementById("autoBtn").addEventListener("click", () => {
  auto = !auto;
  const b = document.getElementById("autoBtn");
  if (auto) { b.classList.add("on"); b.textContent = "auto-tail: on"; startAuto(); }
  else { b.classList.remove("on"); b.textContent = "auto-tail: off"; stopAuto(); }
});
document.getElementById("lines").addEventListener("change", tick);

tick();
startAuto();
</script>
</body>
</html>`;
}

/**
 * Corpus file explorer page. Browser-only — fetches /admin/corpus?...&format=json
 * and renders a filterable, paginated list of every doc in the FTS index.
 */
export function corpusListHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sherlock Corpus</title>
<style>
  :root { --bg:#0d0e10; --panel:#15171b; --border:#25282e; --text:#e7e9ee; --dim:#8a8f9a; --accent:#6ea8ff; --ok:#3ddc97; --warn:#f1c552; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.45; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 13px; font-weight: 600; }
  header .summary { color: var(--dim); font-size: 11.5px; }
  header a.back { color: var(--dim); text-decoration: none; font-size: 11.5px; margin-left: auto; }
  header a.back:hover { color: var(--text); }
  header label { color: var(--dim); font-size: 11.5px; display: flex; align-items: center; gap: 4px; }
  header select, header input { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 3px 6px; border-radius: 3px; font: inherit; font-size: 11.5px; }
  header input[type="search"] { width: 220px; }
  header button { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 3px 10px; border-radius: 3px; font: inherit; font-size: 11.5px; cursor: pointer; }
  header button:hover { color: var(--accent); border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 14px; vertical-align: top; border-bottom: 1px solid var(--border); }
  th { font-weight: 500; color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--panel); position: sticky; top: 49px; }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  td.mono { white-space: nowrap; color: var(--dim); font-variant-numeric: tabular-nums; }
  td.text { word-break: break-word; }
  a.docrow { color: var(--text); text-decoration: none; font-weight: 500; }
  a.docrow:hover { color: var(--accent); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 10.5px; font-weight: 500; background: rgba(110,168,255,0.10); color: var(--accent); }
  .pill.s-youtube { background: rgba(255,107,107,0.12); color: #ff8b8b; }
  .pill.s-blog { background: rgba(110,168,255,0.12); color: var(--accent); }
  .pill.s-twitter-people { background: rgba(61,220,151,0.12); color: var(--ok); }
  .pill.s-substack { background: rgba(241,197,82,0.12); color: var(--warn); }
  .pager { display: flex; gap: 8px; padding: 12px 18px; align-items: center; color: var(--dim); }
  .empty { padding: 32px 18px; color: var(--dim); font-style: italic; }
</style>
</head>
<body>

<header>
  <h1>Corpus</h1>
  <span class="summary" id="summary">loading…</span>
  <label>Source:
    <select id="source"><option value="">all</option></select>
  </label>
  <label>Author:
    <select id="author"><option value="">any</option></select>
  </label>
  <label>Search: <input id="q" type="search" placeholder="title or body" /></label>
  <button id="apply">apply</button>
  <a class="back" href="/admin">← dashboard</a>
</header>

<div id="root"><div class="empty">Loading…</div></div>

<script>
let state = { source: "", author: "", q: "", limit: 50, offset: 0 };

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
}
function fmtSize(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
  return (n/1024/1024).toFixed(2) + " MB";
}
function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toISOString().slice(0, 10); } catch { return s.slice(0, 10); }
}

function readQuery() {
  const p = new URLSearchParams(window.location.search);
  if (p.has("source")) state.source = p.get("source");
  if (p.has("author")) state.author = p.get("author");
  if (p.has("q")) state.q = p.get("q");
  if (p.has("limit")) state.limit = parseInt(p.get("limit"), 10) || 50;
  if (p.has("offset")) state.offset = parseInt(p.get("offset"), 10) || 0;
}
function writeQuery() {
  const p = new URLSearchParams();
  if (state.source) p.set("source", state.source);
  if (state.author) p.set("author", state.author);
  if (state.q) p.set("q", state.q);
  if (state.offset) p.set("offset", String(state.offset));
  if (state.limit !== 50) p.set("limit", String(state.limit));
  history.replaceState(null, "", "/admin/corpus" + (p.toString() ? "?" + p.toString() : ""));
}

async function load() {
  writeQuery();
  const p = new URLSearchParams();
  if (state.source) p.set("source", state.source);
  if (state.author) p.set("author", state.author);
  if (state.q) p.set("q", state.q);
  p.set("limit", String(state.limit));
  p.set("offset", String(state.offset));
  p.set("format", "json");
  document.getElementById("summary").textContent = "loading…";
  try {
    const r = await fetch("/admin/corpus?" + p.toString(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    render(j);
  } catch (e) {
    document.getElementById("summary").textContent = "fetch failed: " + (e.message || e);
  }
}

function render(j) {
  // Update source dropdown.
  const srcSel = document.getElementById("source");
  if (srcSel.options.length <= 1) {
    for (const [src, n] of Object.entries(j.by_source).sort((a,b) => b[1] - a[1])) {
      const o = document.createElement("option"); o.value = src; o.textContent = src + " (" + n + ")"; srcSel.appendChild(o);
    }
    srcSel.value = state.source;
  }
  // Update author dropdown (filtered list, top 100).
  const authSel = document.getElementById("author");
  authSel.innerHTML = '<option value="">any</option>';
  for (const a of j.authors) {
    const o = document.createElement("option"); o.value = a.author; o.textContent = a.author + " (" + a.n + ")";
    if (a.author === state.author) o.selected = true;
    authSel.appendChild(o);
  }
  document.getElementById("q").value = state.q || "";

  document.getElementById("summary").textContent =
    j.total + " match" + (j.total === 1 ? "" : "es") + " (of " + j.total_all + " total)";

  const html = [];
  if (j.docs.length === 0) {
    html.push('<div class="empty">No matching docs.</div>');
  } else {
    html.push('<table><thead><tr><th>#</th><th>Source</th><th>Author</th><th>Title</th><th>Published</th><th class="mono">Chars</th></tr></thead><tbody>');
    for (const d of j.docs) {
      const srcCls = "s-" + (d.source || "").replace(/[^a-z0-9-]/gi, "-");
      const tag = (d.transcript_status && d.transcript_status !== "ok")
        ? ' <span class="pill" style="background:rgba(241,197,82,0.10);color:var(--warn);">' + esc(d.transcript_status) + '</span>'
        : "";
      html.push('<tr>' +
        '<td class="mono">' + d.doc_id + '</td>' +
        '<td><span class="pill ' + srcCls + '">' + esc(d.source) + '</span></td>' +
        '<td class="text">' + esc(d.author || "") + '</td>' +
        '<td class="text"><a class="docrow" href="/admin/corpus/' + d.doc_id + '" target="_blank" rel="noopener">' + esc(d.title || "(untitled)") + '</a>' + tag + '</td>' +
        '<td class="mono">' + esc(fmtDate(d.published_at)) + '</td>' +
        '<td class="mono">' + (d.body_chars != null ? d.body_chars.toLocaleString() : "—") + '</td>' +
      '</tr>');
    }
    html.push('</tbody></table>');
  }

  // Pager
  const prev = Math.max(0, state.offset - state.limit);
  const next = state.offset + state.limit;
  const hasPrev = state.offset > 0;
  const hasNext = next < j.total;
  html.push('<div class="pager">' +
    '<button id="prev"' + (hasPrev ? "" : " disabled") + '>← prev</button>' +
    '<span>' + (state.offset + 1) + '–' + Math.min(state.offset + j.docs.length, j.total) + ' of ' + j.total + '</span>' +
    '<button id="next"' + (hasNext ? "" : " disabled") + '>next →</button>' +
  '</div>');

  document.getElementById("root").innerHTML = html.join("");
  if (hasPrev) document.getElementById("prev").addEventListener("click", () => { state.offset = prev; load(); });
  if (hasNext) document.getElementById("next").addEventListener("click", () => { state.offset = next; load(); });
}

document.getElementById("apply").addEventListener("click", () => {
  state.source = document.getElementById("source").value;
  state.author = document.getElementById("author").value;
  state.q = document.getElementById("q").value;
  state.offset = 0;
  load();
});
document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("apply").click(); });

readQuery();
load();
</script>
</body>
</html>`;
}

/**
 * Corpus single-doc viewer. Fetches /admin/corpus/<id>?format=json
 * and renders metadata + raw markdown body in a <pre>.
 */
export function corpusDocHtml(docId: number): string {
  const safeId = JSON.stringify(docId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sherlock Doc #${docId}</title>
<style>
  :root { --bg:#0d0e10; --panel:#15171b; --border:#25282e; --text:#e7e9ee; --dim:#8a8f9a; --accent:#6ea8ff; --ok:#3ddc97; --warn:#f1c552; --err:#ff6b6b; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55; }
  header { padding: 14px 22px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
  header h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  header .meta { color: var(--dim); font-size: 11.5px; display: flex; gap: 16px; flex-wrap: wrap; }
  header .meta span { white-space: nowrap; }
  header a { color: var(--dim); text-decoration: none; }
  header a:hover { color: var(--accent); }
  .container { display: grid; grid-template-columns: 280px 1fr; gap: 14px; padding: 14px 22px; }
  @media (max-width: 900px) { .container { grid-template-columns: 1fr; } }
  .sidebar { font-size: 12px; color: var(--dim); }
  .sidebar dl { margin: 0; }
  .sidebar dt { color: var(--dim); margin-top: 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .sidebar dd { margin: 2px 0 0; color: var(--text); word-break: break-word; }
  .body { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px 18px; }
  .body pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.6; color: var(--text); }
  .empty { padding: 32px; color: var(--dim); font-style: italic; }
  .err { color: var(--err); padding: 32px; }
</style>
</head>
<body>

<header>
  <h1 id="title">Loading…</h1>
  <div class="meta" id="meta"><a href="/admin/corpus">← back to corpus</a></div>
</header>

<div class="container" id="root"><div class="empty">Loading…</div></div>

<script>
const DOC_ID = ${safeId};
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
}
function fmtSize(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
  return (n/1024/1024).toFixed(2) + " MB";
}
function fmtDate(s) { if (!s) return "—"; try { return new Date(s).toISOString().replace("T"," ").slice(0,16) + " UTC"; } catch { return s; } }

async function load() {
  try {
    const r = await fetch("/admin/corpus/" + DOC_ID + "?format=json", { cache: "no-store" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      document.getElementById("root").innerHTML = '<div class="err">' + esc(j.error || ("HTTP " + r.status)) + '</div>';
      return;
    }
    const d = await r.json();
    document.getElementById("title").textContent = d.title || "(untitled)";
    document.title = "Sherlock — " + (d.title || ("doc #" + d.doc_id));
    const meta = [];
    meta.push('<a href="/admin/corpus">← back to corpus</a>');
    if (d.source) meta.push('<a href="/admin/corpus?source=' + encodeURIComponent(d.source) + '">' + esc(d.source) + '</a>');
    if (d.author) meta.push('<span>by ' + esc(d.author) + '</span>');
    if (d.published_at) meta.push('<span>' + esc(fmtDate(d.published_at)) + '</span>');
    if (d.url) meta.push('<a href="' + esc(d.url) + '" target="_blank" rel="noopener">source ↗</a>');
    document.getElementById("meta").innerHTML = meta.join("");

    const sidebar = [];
    sidebar.push('<div class="sidebar"><dl>');
    const f = (label, val) => { if (val != null && val !== "") sidebar.push('<dt>' + label + '</dt><dd>' + esc(val) + '</dd>'); };
    f("Doc ID", d.doc_id);
    f("Source", d.source);
    f("Source ID", d.source_id);
    f("Content ID", d.content_id);
    f("Author", d.author);
    f("Language", d.language);
    f("Transcript status", d.transcript_status);
    f("Published", fmtDate(d.published_at));
    f("Ingested", fmtDate(d.ingested_at));
    f("Body origin", d.body_origin);
    f("Body chars", d.body_chars != null ? d.body_chars.toLocaleString() : "");
    f("File size", fmtSize(d.size_bytes));
    f("Path", d.rel_path);
    sidebar.push('</dl></div>');

    document.getElementById("root").innerHTML =
      sidebar.join("") +
      '<div class="body"><pre>' + esc(d.body) + '</pre></div>';
  } catch (e) {
    document.getElementById("root").innerHTML = '<div class="err">fetch failed: ' + esc(e.message || e) + '</div>';
  }
}

load();
</script>
</body>
</html>`;
}

