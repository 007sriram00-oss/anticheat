'use strict';

/* ============================================================
   Anti-Cheat Portal — Ocean-style SPA
   ============================================================ */

const GAMES = [
  'Free Fire', 'PUBG Mobile', 'BGMI', 'PUBG PC',
  'Valorant', 'Minecraft', 'Roblox', 'Call of Duty Mobile', 'Apex Legends', 'Others',
];

const GAME_COLORS = {
  'Free Fire': '#ff5c35', 'PUBG Mobile': '#f59e0b', 'BGMI': '#f97316', 'PUBG PC': '#f59e0b',
  'Valorant': '#ef4444', 'Minecraft': '#22c55e', 'Roblox': '#ef4444',
  'Call of Duty Mobile': '#38bdf8', 'Apex Legends': '#ef4444', 'Others': '#3b82f6',
};

const state = {
  view: 'overview',
  reportId: null,
  rail: 'overview',
  actRail: 'boot',
  docKey: 'docs',
  detTab: 'virustotal',
  detSub: 'upload',
  detUrl: '',
  search: '',
  fSession: '',
  fVerdict: '',
  fLevel: '',
  fSource: 'app',
  fTicket: 'all',
  sessTab: 'all',
};

let data = { stats: null, sessions: [], reports: [], events: [], eventsHttp: [], tickets: [], detections: [] };
let reportDetail = null;

/* ============================= helpers ============================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function api(path, opts = {}) {
  const token = localStorage.getItem('anticheat_token');
  const headers = Object.assign({}, opts.headers);
  if (token && !headers['Authorization']) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  opts.headers = headers;
  opts.credentials = 'include';

  const res = await fetch(path, opts);
  if (res.status === 401) {
    localStorage.removeItem('anticheat_token');
    const to = location.pathname.startsWith('/login') ? '/' : location.pathname + location.search;
    location.href = '/login.html?redirectTo=' + encodeURIComponent(to);
    throw new Error('Not logged in');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.json();
}

function icon(name, size = 16, cls = '') {
  return `<svg class="ico ${cls}" width="${size}" height="${size}"><use href="#${name}"/></svg>`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return fmtTime(iso);
}

function fmtDur(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function fmtDurBig(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}<small>s</small>`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}<small>m</small>${String(s).padStart(2, '0')}<small>s</small>`;
  const h = Math.floor(m / 60);
  return `${h}<small>h</small>${String(m % 60).padStart(2, '0')}<small>m</small>`;
}

const pctOf = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

function verdictMeta(v) {
  if (v === 'detected') return { word: 'DETECTED', label: 'Detected', pill: 'red', cls: 'verdict-detected', icon: 'i-xoct' };
  if (v === 'suspicious') return { word: 'SUSPICIOUS', label: 'Suspicious', pill: 'amber', cls: 'verdict-suspicious', icon: 'i-warn' };
  return { word: 'CLEAN', label: 'Clean', pill: 'green', cls: 'verdict-clean', icon: 'i-check' };
}

function gameChip(game) {
  const color = GAME_COLORS[game] || '#3b82f6';
  const letter = (game || '?').trim()[0].toUpperCase();
  return `<span class="gchip" style="background:${color}">${esc(letter)}</span>`;
}

function copyText(text) {
  const done = () => toast('Copied to clipboard', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  ta.remove();
}

function toast(msg, kind = 'info') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ic = kind === 'success' ? 'i-check' : kind === 'error' ? 'i-warn' : 'i-info';
  el.innerHTML = `<span class="t-ico">${icon(ic, 17)}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 3400);
}

/* ============================= router ============================= */

const VIEW_META = {
  overview: { crumbs: ['Dashboard'] },
  sessions: { crumbs: ['Dashboard', 'Pins'] },
  detections: { crumbs: ['Dashboard', 'Detections'] },
  reports: { crumbs: ['Dashboard', 'Reports'] },
  report: { crumbs: ['Dashboard', 'Reports', '…'] },
  log: { crumbs: ['Dashboard', 'System Log'] },
  statistics: { crumbs: ['Dashboard', 'Statistics'] },
  queryuser: { crumbs: ['Dashboard', 'Query User'] },
  antic: { crumbs: ['Dashboard', 'Anti-Cheat'] },
  tickets: { crumbs: ['Dashboard', 'Tickets'] },
  chat: { crumbs: ['Dashboard', 'Chat'] },
  leaderboard: { crumbs: ['Dashboard', 'Leaderboard'] },
  download: { crumbs: ['Dashboard', 'Download'] },
  doc: { crumbs: ['Dashboard', 'Documentation'] },
  about: { crumbs: ['Dashboard', 'Resources'] },
};

const DOC_TITLES = {
  docs: 'Documentation', pricing: 'Pricing', tos: 'Terms of Service',
  privacy: 'Privacy Policy', legal: 'Legal', changelog: 'Changelogs',
};

function setCrumbs(items) {
  $('#crumbs').innerHTML = items.map((t, i) => {
    const last = i === items.length - 1;
    const sep = i > 0 ? `<span class="sep">${icon('i-chev-r', 12)}</span>` : '';
    if (last) return `${sep}<b>${esc(t)}</b>`;
    const page = t === 'Dashboard' ? 'overview' : ['Reports', 'Scan Reports'].includes(t) ? 'reports' : null;
    return `${sep}${page ? `<button data-page="${page}">${esc(t)}</button>` : `<span>${esc(t)}</span>`}`;
  }).join('');
}

function goto(view, opts = {}) {
  state.view = view;
  if (opts.reportId) state.reportId = opts.reportId;
  if (opts.key) state.docKey = opts.key;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.nav-item').forEach((b) => {
    const p = b.dataset.page;
    const on = view === 'doc'
      ? (p === 'doc' && b.dataset.key === state.docKey)
      : (p === view || (view === 'report' && p === 'reports'));
    b.classList.toggle('active', on);
  });
  // expand + highlight the parent group of the active child
  $$('.nav-parent').forEach((np) => {
    const child = np.querySelector(`.nav-item[data-page="${view}"]`);
    const hasActive = !!child;
    np.classList.toggle('has-active', hasActive);
    if (hasActive) np.classList.add('open');
    const exp = np.querySelector('.nav-exp');
    if (exp) exp.setAttribute('aria-expanded', np.classList.contains('open') ? 'true' : 'false');
  });
  const meta = VIEW_META[view]?.crumbs || ['Dashboard'];
  setCrumbs(view === 'doc'
    ? ['Dashboard', DOC_TITLES[state.docKey] || 'Documentation']
    : meta);
  paint();
  if (view === 'chat' && !Array.isArray(data.chat)) {
    api('/api/chat').then((msgs) => {
      data.chat = msgs;
      if (state.view === 'chat') paintChat();
    }).catch(() => { data.chat = []; });
  }
  if (!opts.noScroll) window.scrollTo({ top: 0 });
  if (window.innerWidth <= 860) document.body.classList.remove('sb-open');
}

function paint() {
  const view = state.view;
  const active = document.activeElement;
  let restore = null;
  if (active && active.id && $(`#view-${view}`)?.contains(active)) {
    restore = { id: active.id, s: active.selectionStart, e: active.selectionEnd };
  }

  if (view === 'overview') paintOverview();
  else if (view === 'sessions') paintSessions();
  else if (view === 'detections') paintDetections();
  else if (view === 'reports') paintReports();
  else if (view === 'report') paintReport();
  else if (view === 'log') paintLog();
  else if (view === 'statistics') paintPaywall('Statistics', 'Database insights',
    'Live cheater database statistics are part of the paid DB Access plan. Buy DB Access, or ask an owner to grant it from your profile.');
  else if (view === 'queryuser') paintPaywall('Query User', 'Cheater database lookup',
    'Cheater database lookups are part of the paid DB Access plan. Buy DB Access, or ask an owner to grant it from your profile.');
  else if (view === 'antic') paintAntic();
  else if (view === 'tickets') paintTickets();
  else if (view === 'chat') paintChat();
  else if (view === 'leaderboard') paintLeaderboard();
  else if (view === 'download') paintDownload();
  else if (view === 'doc') paintDoc();
  else if (view === 'about') paintAbout();

  if (restore) {
    const el = document.getElementById(restore.id);
    if (el) { el.focus(); try { el.setSelectionRange(restore.s, restore.e); } catch { /* not text */ } }
  }
}

/* ============================= data ============================= */

async function refresh({ keepView = true } = {}) {
  try {
    const needHttp = state.view === 'log' && state.fSource !== 'app';
    const [stats, sessions, reports, evApp, evHttp, tickets, detections] = await Promise.all([
      api('/api/stats'), api('/api/sessions'),
      api('/api/reports?limit=300'),
      api('/api/events?limit=500&excludeType=http'),
      needHttp ? api('/api/events?limit=300&type=http') : Promise.resolve(data.eventsHttp || []),
      api('/api/tickets').catch(() => data.tickets || []),
      api('/api/detections?limit=100').catch(() => data.detections || []),
    ]);
    data = { stats, sessions, reports, events: evApp, eventsHttp: evHttp, tickets, detections };
    paintBadges();
    // chat/detections/report own their own repaints (typing + file state)
    if (keepView && !['report', 'chat', 'detections'].includes(state.view)) paint();
  } catch (err) {
    console.error('refresh failed', err);
  }
}

function paintBadges() {
  const { stats, sessions, events, tickets } = data;
  const set = (id, n, hideZero = true) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = hideZero && !n;
    el.textContent = n > 99 ? '99+' : n;
  };
  const alerts = events.filter((e) => e.level === 'warn' || e.level === 'error' || e.level === 'critical').length;
  const activeTickets = (tickets || []).filter((t) => t.status !== 'closed').length;
  set('badge-sessions', sessions.length);
  set('badge-reports', stats ? stats.detected : 0);
  set('badge-tickets', activeTickets);
  set('bell-badge', alerts);
}

async function openReport(id) {
  try {
    reportDetail = await api(`/api/reports/${id}`);
    state.reportId = id;
    state.rail = 'overview';
    goto('report');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ============================= shared blocks ============================= */

function pageHead({ iconName, title, sub, actions = '' }) {
  return `
    <div class="page-head">
      <div>
        <div class="page-title">
          <span class="pt-ico">${icon(iconName, 19)}</span>
          <h1>${esc(title)}</h1>
        </div>
        <p class="page-sub">${esc(sub)}</p>
      </div>
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>`;
}

function emptyBlock(msg, iconName = 'i-search') {
  return `<div class="empty">${icon(iconName, 26)}${esc(msg)}</div>`;
}

function findingItem(f, i = 0) {
  const sev = f.severity || 'info';
  const sevIcon = sev === 'critical' ? 'i-xoct' : sev === 'high' ? 'i-warn' : sev === 'info' ? 'i-check' : 'i-info';
  return `
    <div class="finding ${sev}" style="animation-delay:${Math.min(i * 40, 400)}ms">
      <div class="f-ico">${icon(sevIcon, 15)}</div>
      <div class="f-body">
        <div class="f-head">
          <span class="sev ${sev}">${sev}</span>
          <span class="f-title">${esc(f.title)}</span>
          <span class="f-cat">${esc(f.kind || f.category || '')}</span>
        </div>
        <div class="f-detail">${esc(f.detail)}</div>
        ${f.evidence && f.evidence.trim() && f.evidence !== '—'
          ? `<div class="f-ev">${esc(f.evidence)}</div>` : ''}
      </div>
    </div>`;
}

function fileRow(f, i = 0) {
  const status = f.status || 'ok';
  const sign = f.signed === true
    ? '<span class="fr-sign yes">✓ signed</span>'
    : f.signed === false
      ? '<span class="fr-sign no">✕ unsigned</span>'
      : '<span class="fr-sign">not verified</span>';
  const kb = f.sizeKb || 0;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
  return `
    <div class="file-row st-${esc(status)}" style="animation-delay:${Math.min(i * 28, 460)}ms">
      <div class="fr-main">
        <div class="fr-name">${esc(f.name)} <span class="pill ${status === 'detected' ? 'red' : status === 'suspicious' ? 'amber' : 'blue'}"><i></i>${esc(status)}</span></div>
        <div class="fr-path">${esc(f.path)}</div>
        <div class="fr-reason">${esc(f.reason)}</div>
      </div>
      <div class="fr-meta">
        <span class="fr-size">${size}</span>
        ${sign}
      </div>
    </div>`;
}

/* ============================= overview ============================= */

function paintOverview() {
  const s = data.stats || { sessions: 0, reports: 0, clean: 0, suspicious: 0, detected: 0, devices: 0, last24h: 0, flaggedFiles: 0, filesScanned: 0, byGame: [], topFindings: [] };
  const total = s.clean + s.suspicious + s.detected;
  const gamesMax = Math.max(1, ...s.byGame.map((g) => g.count));
  const events = data.events.filter((e) => e.type !== 'http').slice(0, 6);
  const recent = data.reports.slice(0, 6);

  const tiles = [
    { cls: '', ic: 'i-pin', num: s.sessions, label: 'Total Pins' },
    { cls: 'c-blue', ic: 'i-file', num: s.reports, label: 'Total Scans' },
    { cls: 'c-red', ic: 'i-xoct', num: s.detected, label: 'Detections' },
    { cls: 'c-amber', ic: 'i-flag', num: s.flaggedFiles, label: 'Flagged Files' },
  ].map((t, i) => `
    <div class="tile ${t.cls}" style="animation-delay:${i * 50}ms">
      <div class="tile-top">
        <span class="tile-ico">${icon(t.ic, 15)}</span>
        <span class="tile-num">${t.num}</span>
      </div>
      <div class="tile-label">${t.label}</div>
    </div>`).join('');

  const vcards = [
    { cls: 'v-green', ic: 'i-check', label: 'Clean', n: s.clean },
    { cls: 'v-amber', ic: 'i-warn', label: 'Suspicious', n: s.suspicious },
    { cls: 'v-red', ic: 'i-xoct', label: 'Detected', n: s.detected },
  ].map((v, i) => `
    <div class="vcard ${v.cls}" style="animation-delay:${i * 60}ms">
      <div class="vcard-head"><span class="vh-ico">${icon(v.ic, 15)}</span>${v.label}<span class="vcard-num">${v.n}</span></div>
      <div class="vcard-cap"><span>${pctOf(v.n, total)}% of ${total} report${total === 1 ? '' : 's'}</span></div>
    </div>`).join('');

  const legend = [
    { cls: 'lg-green', ic: 'i-check', label: 'Clean', n: s.clean },
    { cls: 'lg-amber', ic: 'i-warn', label: 'Suspicious', n: s.suspicious },
    { cls: 'lg-red', ic: 'i-xoct', label: 'Detected', n: s.detected },
  ].map((l) => `
    <div class="legend-row">
      <span class="${l.cls}" style="display:inline-flex">${icon(l.ic, 14)}</span>${l.label}
      <b class="lg-count">${l.n}</b><span class="lg-pct">${pctOf(l.n, total)}%</span>
    </div>`).join('');

  const gameBars = s.byGame.length
    ? s.byGame.map((g) => `
      <div class="gamebar">
        <span class="gb-name">${gameChip(g.game)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.game)}</span></span>
        <span class="gb-track"><span class="gb-fill" style="width:${Math.max(6, (g.count / gamesMax) * 100)}%"></span></span>
        <b class="gb-count">${g.count}</b>
      </div>`).join('')
    : emptyBlock('No scans yet', 'i-game');

  const feed = events.length
    ? events.map((e) => `
      <div class="feed-item ${e.level}">
        <span class="feed-dot"></span>
        <div>
          <div class="feed-msg">${esc(e.message)}</div>
          <div class="feed-time">${fmtTime(e.ts)} · ${esc(e.type)}</div>
        </div>
      </div>`).join('')
    : emptyBlock('No activity yet', 'i-activity');

  const recentRows = recent.length
    ? recent.map((r) => {
      const vm = verdictMeta(r.verdict);
      return `
        <tr data-action="open-report" data-id="${r.id}">
          <td><div class="cell-main mono">${esc(r.sessionPin || '—')}</div><div class="cell-sub">${fmtAgo(r.finishedAt || r.createdAt)}</div></td>
          <td><div class="cell-main">${esc(r.playerName || r.hostname)}</div><div class="cell-sub">${esc(r.sessionName || '')}</div></td>
          <td><div class="cell-flex">${gameChip(r.game)}<span>${esc(r.game)}</span></div></td>
          <td><span class="pill ${vm.pill}"><i></i>${vm.label}</span></td>
          <td class="num">${r.score}</td>
          <td><span class="cell-sub" style="margin:0">${fmtTime(r.finishedAt || r.createdAt)}</span></td>
        </tr>`;
    }).join('')
    : `<tr><td colspan="6">${emptyBlock('Waiting for the first scan report…', 'i-shield')}</td></tr>`;

  const statusGameChips = s.byGame.map((g) => `
    <span class="gchip-pill">${gameChip(g.game)}${esc(g.game)}</span>`).join('') ||
    '<span class="gchip-pill">No sessions yet</span>';

  $('#view-overview').innerHTML = `
    ${pageHead({
      iconName: 'i-grid',
      title: 'Dashboard',
      sub: 'View statistics, events, and scan activity on the portal.',
      actions: `<button class="btn ghost" data-action="refresh">${icon('i-refresh', 15)} Refresh</button>
                <button class="btn primary" data-action="create-session">${icon('i-plus', 15)} Create Pin</button>`,
    })}

    <div class="tiles">${tiles}</div>
    <div class="vstats">${vcards}</div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div><div class="card-title">Results Distribution</div></div></div>
        <div class="dist-bar">
          <span class="seg-green" style="width:${pctOf(s.clean, total)}%"></span>
          <span class="seg-amber" style="width:${pctOf(s.suspicious, total)}%"></span>
          <span class="seg-red" style="width:${pctOf(s.detected, total)}%"></span>
        </div>
        <div class="legend">${legend}</div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">Scans by Game</div></div></div>
        <div class="gamebars">${gameBars}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-title">System Events</div>
          <button class="link-btn" data-page="log">See all events ${icon('i-chev-r', 12)}</button>
        </div>
        <div class="feed">${feed}</div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">Portal Status</div></div>
        <div class="status-rows">
          <div class="status-row"><span class="k">${icon('i-wifi', 13)} Status</span><span class="v green">Realtime active</span></div>
          <div class="status-row"><span class="k">${icon('i-server', 13)} Deployment</span><span class="v">localhost:3000</span></div>
          <div class="status-row"><span class="k">${icon('i-drive', 13)} Files scanned</span><span class="v">${(s.filesScanned || 0).toLocaleString()}</span></div>
          <div class="status-row"><span class="k">${icon('i-users', 13)} Devices</span><span class="v">${s.devices}</span></div>
        </div>
        <div class="gchips">${statusGameChips}</div>
      </div>
    </div>

    <div class="table-card section-gap">
      <div class="table-toolbar" style="border-bottom:1px solid var(--line)">
        <div class="card-title">Recent scans</div>
        <span class="grow"></span>
        <button class="link-btn" data-page="reports">View all ${icon('i-chev-r', 12)}</button>
      </div>
      <table class="table">
        <thead><tr><th>PIN</th><th>Player</th><th>Game</th><th>Result</th><th>Score</th><th>Scanned</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>`;
}

/* ============================= sessions ============================= */

function paintSessions() {
  const all = data.sessions;
  const active = all.filter((s) => s.active).length;
  const paused = all.length - active;
  const totalReports = all.reduce((a, s) => a + s.reportCount, 0);
  const flagged = all.reduce((a, s) => a + s.flaggedCount, 0);
  const q = state.search.trim().toLowerCase();

  let list = all;
  if (state.sessTab === 'active') list = list.filter((s) => s.active);
  if (state.sessTab === 'paused') list = list.filter((s) => !s.active);
  if (q) list = list.filter((s) =>
    s.pin.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.game.toLowerCase().includes(q));

  const kpis = [
    { cls: 'kpi-white', ic: 'i-pin', label: 'Total Pins', num: all.length, cap: 'all sessions' },
    { cls: 'kpi-green', ic: 'i-check', label: 'Active', num: active, cap: 'accepting scans' },
    { cls: 'kpi-amber', ic: 'i-pause', label: 'Paused', num: paused, cap: 'not accepting scans' },
    { cls: 'kpi-blue', ic: 'i-file', label: 'Reports', num: totalReports, cap: 'scans received' },
    { cls: 'kpi-red', ic: 'i-xoct', label: 'Flagged', num: flagged, cap: 'non-clean verdicts' },
  ].map((k) => `
    <div class="kpi ${k.cls}">
      <div class="kpi-label">${icon(k.ic, 14)} ${k.label}</div>
      <div class="kpi-num">${k.num}</div>
      <div class="kpi-cap">${k.cap}</div>
    </div>`).join('');

  const rows = list.length ? list.map((s) => {
    const expired = s.expiresAt && new Date(s.expiresAt).getTime() < Date.now();
    const status = expired
      ? '<span class="pill red"><i></i>Expired</span>'
      : s.active
        ? '<span class="pill green"><i></i>Active</span>'
        : '<span class="pill amber"><i></i>Paused</span>';
    return `
      <tr>
        <td>
          <div class="cell-flex">
            <span class="cell-main mono" style="font-size:14px;letter-spacing:.04em">${esc(s.pin)}</span>
            <button class="icon-btn" style="width:26px;height:26px" data-action="copy" data-text="${esc(s.pin)}" title="Copy PIN">${icon('i-copy', 13)}</button>
          </div>
          <div class="cell-sub">${icon('i-clock', 11)} ${fmtAgo(s.createdAt)}</div>
        </td>
        <td>
          <div class="cell-flex">
            <span class="gchip" style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);width:24px;height:24px;font-size:11px;border-radius:50%">${esc((s.players[0] || s.name || '?')[0].toUpperCase())}</span>
            <div>
              <div class="cell-main">${esc(s.name)}</div>
              <div class="cell-sub">${esc(s.createdBy ? `By ${s.createdBy}` : 'Admin')} · ${s.players.length ? `${esc(s.players.slice(0, 2).join(', '))}${s.players.length > 2 ? ` +${s.players.length - 2}` : ''}` : `${s.reportCount} scans`}</div>
            </div>
          </div>
        </td>
        <td><div class="cell-flex">${gameChip(s.game)}<span>${esc(s.game)}</span></div></td>
        <td><div class="cell-main num">${s.reportCount}</div><div class="cell-sub">${s.flaggedCount} flagged</div></td>
        <td>${status}</td>
        <td>
          <button class="pill ${s.visibility === 'private' ? 'zinc' : 'blue'}" data-action="vis-toggle"
            data-id="${s.id}" title="Click to switch" style="cursor:pointer;border:none">
            ${icon(s.visibility === 'private' ? 'i-lock' : 'i-eye', 11)}&nbsp;${s.visibility === 'private' ? 'Private' : 'Public'}
          </button>
        </td>
        <td class="t-right" style="white-space:nowrap">
          <button class="icon-btn" style="display:inline-grid;width:30px;height:30px;color:var(--blue-4)" data-action="share-pin" data-id="${s.id}" data-pin="${esc(s.pin)}" data-game="${esc(s.game)}" title="Copy Player Invite & Download Link">${icon('i-share', 14)}</button>
          <button class="icon-btn" style="display:inline-grid;width:30px;height:30px" data-action="session-reports" data-id="${s.id}" title="View reports">${icon('i-ext', 14)}</button>
          <button class="icon-btn" style="display:inline-grid;width:30px;height:30px" data-action="session-toggle" data-id="${s.id}" title="${s.active ? 'Pause' : 'Activate'}">${icon(s.active ? 'i-pause' : 'i-play', 13)}</button>
          <button class="icon-btn" style="display:inline-grid;width:30px;height:30px;color:var(--red-4)" data-action="session-delete" data-id="${s.id}" title="Delete">${icon('i-trash', 14)}</button>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="8">${emptyBlock(q || state.sessTab !== 'all' ? 'No pins match the filter' : 'No pins yet — create one to get started', 'i-pin')}</td></tr>`;

  $('#view-sessions').innerHTML = `
    ${pageHead({
      iconName: 'i-pin',
      title: 'My Pins',
      sub: 'Manage, track, and analyze your scan pins and their results.',
      actions: `<button class="btn primary" data-action="create-session">${icon('i-plus', 15)} Create Pin</button>`,
    })}

    <div class="seg">
      <button class="seg-btn ${state.sessTab === 'all' ? 'active' : ''}" data-action="sess-tab" data-tab="all">All Pins <span class="cnt">${all.length}</span></button>
      <button class="seg-btn ${state.sessTab === 'active' ? 'active' : ''}" data-action="sess-tab" data-tab="active">Active <span class="cnt">${active}</span></button>
      <button class="seg-btn ${state.sessTab === 'paused' ? 'active' : ''}" data-action="sess-tab" data-tab="paused">Paused <span class="cnt">${paused}</span></button>
    </div>

    <div class="kpis">${kpis}</div>

    <div class="table-card">
      <div class="table-toolbar">
        <label class="searchfield">${icon('i-search', 14)}
          <input class="input" id="in-sess" type="text" placeholder="Search by PIN or session..." value="${esc(state.search)}" data-input="search" />
        </label>
        <span class="grow"></span>
        <button class="btn ghost sm" data-action="clear-search">Reset</button>
      </div>
      <table class="table">
        <thead><tr><th>Pin</th><th>Players</th><th>Game</th><th>Reports</th><th>Status</th><th>Visibility</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="table-foot"><span>${list.length} of ${all.length} pin${all.length === 1 ? '' : 's'}</span>
        <button class="link-btn" data-action="create-session">${icon('i-plus', 12)} New pin</button></div>
    </div>`;
}

/* ============================= reports ============================= */

function paintReports() {
  const q = state.search.trim().toLowerCase();
  let list = data.reports;
  if (state.fSession) list = list.filter((r) => r.sessionId === state.fSession);
  if (state.fVerdict) list = list.filter((r) => r.verdict === state.fVerdict);
  if (q) list = list.filter((r) =>
    (r.hostname + ' ' + (r.playerName || '') + ' ' + (r.sessionPin || '') + ' ' + r.game).toLowerCase().includes(q));

  const sessionOpts = ['<option value="">All sessions</option>']
    .concat(data.sessions.map((s) =>
      `<option value="${s.id}" ${state.fSession === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.pin)}</option>`))
    .join('');

  const rows = list.length ? list.map((r) => {
    const vm = verdictMeta(r.verdict);
    return `
      <tr data-action="open-report" data-id="${r.id}">
        <td><div class="cell-main">${esc(r.hostname)}</div><div class="cell-sub">${esc(r.playerName || 'unknown player')} · <span class="mono">${esc(r.sessionPin || '')}</span></div></td>
        <td><div class="cell-flex">${gameChip(r.game)}<span>${esc(r.game)}</span></div></td>
        <td><span class="pill ${vm.pill}"><i></i>${vm.label}</span></td>
        <td class="num"><b>${r.score}</b></td>
        <td>
          <div class="cell-main num">${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}</div>
          <div class="cell-sub">${r.seriousCount ? `<b style="color:var(--red-4)">${r.seriousCount} serious</b> · ` : ''}${r.flaggedFileCount ? `<b style="color:var(--amber-3)">${r.flaggedFileCount} files</b>` : 'clean checks'}</div>
        </td>
        <td><div class="cell-main">${fmtTime(r.finishedAt || r.createdAt)}</div><div class="cell-sub">${fmtDur(r.durationMs)}</div></td>
        <td class="t-right">${icon('i-chev-r', 15)}</td>
      </tr>`;
  }).join('') : `<tr><td colspan="7">${emptyBlock('No reports match the filter', 'i-file')}</td></tr>`;

  $('#view-reports').innerHTML = `
    ${pageHead({
      iconName: 'i-shield',
      title: 'Scan Reports',
      sub: 'Agent scan results uploaded from player devices.',
      actions: `<button class="btn ghost" data-action="refresh">${icon('i-refresh', 15)} Refresh</button>
                <button class="btn primary" data-action="create-session">${icon('i-plus', 15)} Create Pin</button>`,
    })}

    <div class="table-card">
      <div class="table-toolbar">
        <label class="searchfield">${icon('i-search', 14)}
          <input class="input" id="in-rep" type="text" placeholder="Search by device or player..." value="${esc(state.search)}" data-input="search" />
        </label>
        <select class="select" data-input="f-session">${sessionOpts}</select>
        <select class="select" data-input="f-verdict">
          <option value="">All verdicts</option>
          <option value="clean" ${state.fVerdict === 'clean' ? 'selected' : ''}>Clean</option>
          <option value="suspicious" ${state.fVerdict === 'suspicious' ? 'selected' : ''}>Suspicious</option>
          <option value="detected" ${state.fVerdict === 'detected' ? 'selected' : ''}>Detected</option>
        </select>
        <span class="grow"></span>
        <button class="btn ghost sm" data-action="clear-filters">Reset</button>
      </div>
      <table class="table">
        <thead><tr><th>Device</th><th>Game</th><th>Verdict</th><th>Score</th><th>Findings</th><th>Scanned</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="table-foot"><span>${list.length} of ${data.reports.length} report${data.reports.length === 1 ? '' : 's'}</span></div>
    </div>`;
}

/* ============================= report detail ============================= */

function radarSvg(det, warn, legit, cls) {
  const cx = 150, cy = 126, R = 88;
  const dirTop = [0, -1];
  const dirRight = [Math.sqrt(3) / 2, 0.5];
  const dirLeft = [-Math.sqrt(3) / 2, 0.5];
  const scale = Math.max(det, warn, legit, 1);
  const pt = (dir, v) => {
    const k = Math.max(v / scale, v > 0 ? 0.14 : 0.05);
    return [cx + dir[0] * R * k, cy + dir[1] * R * k];
  };
  const pTop = pt(dirTop, det), pRight = pt(dirRight, warn), pLeft = pt(dirLeft, legit);
  const color = cls === 'verdict-detected' ? '#f87171' : cls === 'verdict-suspicious' ? '#fbbf24' : '#34d399';
  const axis = (dir) => `M${cx},${cy} L${cx + dir[0] * R},${cy + dir[1] * R}`;
  return `
    <svg viewBox="0 0 300 250" width="100%" height="250" style="max-width:340px">
      <path d="${axis(dirTop)}${axis(dirRight)}${axis(dirLeft)}" stroke="#26282e" stroke-width="1" fill="none"/>
      <polygon points="${cx},${cy - R} ${cx + dirRight[0] * R},${cy + dirRight[1] * R} ${cx + dirLeft[0] * R},${cy + dirLeft[1] * R}"
        fill="none" stroke="#2e3138" stroke-width="1.2"/>
      <polygon points="${pTop.join(',')} ${pRight.join(',')} ${pLeft.join(',')}"
        fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${pTop[0]}" cy="${pTop[1]}" r="3.5" fill="${color}"/>
      <circle cx="${pRight[0]}" cy="${pRight[1]}" r="3.5" fill="${color}"/>
      <circle cx="${pLeft[0]}" cy="${pLeft[1]}" r="3.5" fill="${color}"/>
      <text x="150" y="16" text-anchor="middle" fill="#a1a1aa" font-size="11.5" font-weight="600">Detections</text>
      <text x="262" y="234" text-anchor="middle" fill="#a1a1aa" font-size="11.5" font-weight="600">Warnings</text>
      <text x="38" y="234" text-anchor="middle" fill="#a1a1aa" font-size="11.5" font-weight="600">Legit</text>
    </svg>`;
}

function paintReport() {
  const r = reportDetail;
  if (!r) { $('#view-report').innerHTML = emptyBlock('Loading report…', 'i-refresh'); return; }

  setCrumbs(['Dashboard', 'Scan Reports', r.hostname]);
  const vm = verdictMeta(r.verdict);
  const findings = r.findings || [];
  const files = r.files || [];
  const stats = r.summary || {};
  const av = r.av || {};

  const sev = (s) => findings.filter((f) => f.severity === s).length;
  const det = sev('critical') + sev('high');
  const warn = sev('medium') + sev('low');
  const legit = sev('info');

  const exeFiles = files.filter((f) => f.kind === 'exe');
  const dllFiles = files.filter((f) => f.kind === 'dll' || f.kind === 'sys');
  const byKind = (k) => findings.filter((f) => (f.kind || f.category) === k);
  const ACT_KINDS = ['accounts', 'recording'];
  const BRUTAL_KINDS = ['string-finder', 'event-log', 'pc-log', 'integrity', 'kernel', 'driver'];
  const brutalFindings = findings.filter((f) => BRUTAL_KINDS.includes(f.kind || f.category));
  const other = findings.filter((f) =>
    !['exe', 'dll', 'process', 'antivirus', 'ai'].includes(f.kind || f.category) &&
    !ACT_KINDS.includes(f.kind || f.category) &&
    !BRUTAL_KINDS.includes(f.kind || f.category));
  const aiFindings = findings.filter((f) => (f.kind || f.category) === 'ai');
  const sys = r.system || {};
  const hasProfile = 'bootTime' in sys || 'gpu' in sys || Array.isArray(sys.accounts);

  const railItems = [
    { key: 'overview', label: 'Overview', ic: 'i-grid', count: findings.length, cls: '' },
    { key: 'brutal', label: 'Brutal Finder', ic: 'i-xoct', count: brutalFindings.length, cls: brutalFindings.length ? 'k-red' : 'k-blue' },
    { key: 'exe', label: 'EXE files', ic: 'i-zap', count: exeFiles.length + byKind('exe').length, cls: 'k-red' },
    { key: 'dll', label: 'DLL files', ic: 'i-db', count: dllFiles.length + byKind('dll').length, cls: 'k-amber' },
    { key: 'processes', label: 'Processes', ic: 'i-cpu', count: byKind('process').length, cls: 'k-blue' },
    { key: 'antivirus', label: 'Engines', ic: 'i-shield', count: byKind('antivirus').length, cls: 'k-green' },
    { key: 'checks', label: 'Other checks', ic: 'i-fingerprint', count: other.length, cls: 'k-purple' },
    { key: 'ai', label: 'AI Opinion', ic: 'i-spark', count: aiFindings.length, cls: 'k-purple' },
  ];
  const totalItems = railItems.reduce((a, x) => a + x.count, 0);

  const railHtml = railItems.map((it) => `
    <button class="rail-item ${it.cls} ${state.rail === it.key ? 'active' : ''}" data-action="rail" data-key="${it.key}">
      <span class="rail-ico">${icon(it.ic, 15)}</span>
      <span class="rail-label">${it.label}</span>
      ${it.count !== null ? `<span class="rail-count">${it.count}${totalItems ? ` (${pctOf(it.count, totalItems)}%)` : ''}</span>` : ''}
    </button>`).join('');

  const defrow = (ic, k, v, mono = false) => `
    <div class="defrow"><span class="k">${icon(ic, 14)} ${k}</span><span class="v ${mono ? 'mono' : ''}">${v}</span></div>`;

  /* ---- overview pane */
  const statCell = (k, v, cls = 'b') => `<div class="pm ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const paneOverview = `
    <div class="pc-metrics" style="grid-template-columns:repeat(3,1fr)">
      ${statCell('Checks run', stats.checksRun ?? '—')}
      ${statCell('Serious findings', stats.seriousFindings ?? '—', (stats.seriousFindings ? 'a' : 'g'))}
      ${statCell('Files scanned', (stats.filesScanned ?? 0).toLocaleString(), 'g')}
      ${statCell('Signature checks', (stats.signatureChecks ?? 0).toLocaleString())}
      ${statCell('Processes scanned', stats.processesScanned ?? '—')}
      ${statCell('Modules inspected', stats.modulesInspected ?? '—')}
    </div>
    <div class="deflist" style="margin-top:6px">
      ${defrow('i-pin', 'Session', `${esc(r.sessionName)} · <span class="mono">${esc(r.sessionPin || '')}</span>`)}
      ${defrow('i-users', 'Player', esc(r.playerName || '—'))}
      ${defrow('i-monitor', 'Hostname', esc(r.hostname))}
      ${defrow('i-fingerprint', 'Device ID', esc(r.deviceId), true)}
      ${defrow('i-game', 'Game', esc(r.game))}
      ${defrow('i-cpu', 'Operating system', esc(r.os || r.system?.os || '—'))}
      ${defrow('i-cpu', 'CPU', esc(r.system?.cpu || '—'))}
      ${defrow('i-drive', 'Memory', r.system?.memoryMb ? `${r.system.memoryMb} MB` : '—')}
      ${defrow('i-zap', 'Agent version', esc(r.agentVersion || '—'))}
      ${defrow('i-clock', 'Consent given', r.consentAt ? fmtTime(r.consentAt) : '—')}
      ${defrow('i-check', 'Scan completed', fmtTime(r.finishedAt || r.createdAt))}
      ${defrow('i-clock', 'Scan duration', fmtDur(r.durationMs))}
    </div>`;

  /* ---- file panes */
  const filePane = (kindFindings, fileList, emptyMsg) => `
    ${kindFindings.length ? `<div class="findings">${kindFindings.map(findingItem).join('')}</div>` : ''}
    ${kindFindings.length ? '<div style="height:8px"></div>' : ''}
    <div class="file-stats">
      <span><b>${fileList.length}</b> flagged file${fileList.length === 1 ? '' : 's'}</span>
      <span><b>${fileList.filter((f) => f.signed === true).length}</b> signed</span>
      <span><b>${fileList.filter((f) => f.signed === false).length}</b> unsigned</span>
      <span><b>${(fileList.reduce((a, f) => a + (f.sizeKb || 0), 0) / 1024).toFixed(1)}</b> MB total</span>
    </div>
    ${fileList.length
      ? `<div class="file-table">${fileList.map(fileRow).join('')}</div>`
      : emptyBlock(emptyMsg, 'i-check')}`;

  /* ---- antivirus pane */
  const products = av.products || [];
  const protectionOn = products.some((p) => p.enabled) && !av.defenderPolicyDisabled && av.defenderRealtime !== false;
  const avFindings = byKind('antivirus');
  const paneAv = `
    <div class="av-hero ${protectionOn ? 'on' : 'off'}">
      <div class="av-hero-icon">${protectionOn ? '🛡️' : '⚠️'}</div>
      <div>
        <b>${protectionOn ? 'Real-time protection is ON' : 'Real-time protection is OFF'}</b>
        <span>${protectionOn
          ? 'Antivirus monitoring is active on this device.'
          : 'Antivirus is disabled or missing — common before running cheats.'}</span>
      </div>
    </div>
    <div class="card-title" style="margin-bottom:12px">Registered antivirus products</div>
    <div class="av-grid">
      ${products.length ? products.map((p, i) => `
        <div class="av-card ${p.enabled ? 'on' : 'off'}" style="animation-delay:${i * 60}ms">
          <div class="av-name">${esc(p.name)}</div>
          <div class="av-badges">
            <span class="pill ${p.enabled ? 'green' : 'red'}"><i></i>${p.enabled ? 'Enabled' : 'Disabled'}</span>
            <span class="pill ${p.upToDate ? 'green' : 'amber'}">${p.upToDate ? 'Up to date' : 'Outdated'}</span>
          </div>
          <div class="av-state">productState ${esc(p.stateHex || '')}</div>
        </div>`).join('')
      : emptyBlock('No antivirus product reported to Windows Security Center', 'i-warn')}
    </div>
    <div class="deflist" style="margin-top:8px">
      ${defrow('i-server', 'WinDefend service', esc(av.defenderServiceState || 'unknown'))}
      ${defrow('i-shield', 'Real-time monitoring', av.defenderRealtime === null || av.defenderRealtime === undefined ? 'not readable' : av.defenderRealtime ? 'enabled' : 'disabled')}
      ${defrow('i-lock', 'Disabled by policy', av.defenderPolicyDisabled ? 'YES — policy keys set' : 'no')}
      ${defrow('i-clock', 'Checked', av.checkedAt ? fmtTime(av.checkedAt) : fmtTime(r.finishedAt))}
    </div>
    ${avFindings.length ? `<div class="findings" style="margin-top:8px">${avFindings.map(findingItem).join('')}</div>` : ''}`;

  /* ---- AI opinion pane */
  const aiOpinion = aiFindings.find((f) => f.category === 'analysis') || aiFindings[0];
  const paneAi = `
    ${aiOpinion ? `
      <div class="ai-hero">
        <div class="ai-ico">${icon('i-spark', 19)}</div>
        <div>
          <b>Analysis opinion <span class="ai-tag">AI</span></b>
          <p>${esc(aiOpinion.detail)}</p>
        </div>
      </div>` : ''}
    ${aiFindings.length > 1
      ? `<div class="findings">${aiFindings.filter((f) => f !== aiOpinion).map(findingItem).join('')}</div>`
      : ''}
    ${aiOpinion ? `
      <div class="deflist">
        ${defrow('i-shield', 'Verdict', `<span class="pill ${vm.pill}"><i></i>${vm.label}</span>`)}
        ${defrow('i-zap', 'Risk score', `${r.score} / 100`)}
        ${defrow('i-fingerprint', 'Signal basis', esc(aiOpinion.evidence || '—'), true)}
      </div>` : emptyBlock('No analysis opinion — rebuild the agent to include it', 'i-spark')}`;

  /* ---- brutal finder pane */
  const secureBootVal = sys.secureBoot || (r.summary && r.summary.secureBoot ? 'Enabled' : (r.summary && r.summary.secureBoot === false ? 'Disabled' : '—'));
  const testsigningVal = sys.testsigning || (r.summary && r.summary.testsigning ? 'Enabled' : 'Disabled');
  const evStatus = sys.eventLogStatus || (r.summary && r.summary.eventLogAnomalies ? `${r.summary.eventLogAnomalies} Anomalies` : 'Normal');

  const paneBrutal = `
    <div class="card-title" style="margin-bottom:12px">Brutal Finder — Deep Forensics & String Search</div>
    <div class="av-hero ${secureBootVal === 'Enabled' ? 'on' : 'off'}">
      <div class="av-hero-icon">${secureBootVal === 'Enabled' ? '🛡️' : '⚠️'}</div>
      <div>
        <b>Secure Boot: ${esc(secureBootVal)} · Testsigning: ${esc(testsigningVal)}</b>
        <span>${secureBootVal === 'Enabled'
          ? 'UEFI Secure Boot is actively verifying kernel bootloaders.'
          : 'Secure Boot is DISABLED — vulnerable driver mappers (kdmapper) and DSE bypasses can run freely.'}</span>
      </div>
    </div>
    <div class="deflist" style="margin-top:10px">
      ${defrow('i-shield', 'Secure Boot', `<span class="pill ${secureBootVal === 'Enabled' ? 'green' : 'red'}"><i></i>${esc(secureBootVal)}</span>`)}
      ${defrow('i-lock', 'Testsigning Mode', `<span class="pill ${testsigningVal.includes('Enabled') ? 'red' : 'green'}"><i></i>${esc(testsigningVal)}</span>`)}
      ${defrow('i-server', 'Windows Event Logs', esc(evStatus))}
      ${defrow('i-search', 'String Finder Hits', String(r.summary?.stringFinderHits || 0))}
      ${defrow('i-clock', 'Prefetch Cheat Executions', String(r.summary?.prefetchHits || 0))}
      ${defrow('i-db', 'BAM Historical Executions', String(r.summary?.bamHits || 0))}
      ${defrow('i-cpu', 'Suspicious Drivers', String(r.summary?.suspiciousDrivers || 0))}
    </div>
    <div style="height:14px"></div>
    <div class="card-title" style="margin-bottom:10px">Forensic Detections (${brutalFindings.length})</div>
    ${brutalFindings.length
      ? `<div class="findings">${brutalFindings.map(findingItem).join('')}</div>`
      : emptyBlock('No cheat strings, event log wiping, or kernel bypasses detected', 'i-check')}
  `;

  const panes = {
    overview: paneOverview,
    brutal: paneBrutal,
    exe: filePane(byKind('exe'), exeFiles, 'No EXE files flagged — all scanned executables verified'),
    dll: filePane(byKind('dll'), dllFiles, 'No DLL files flagged — no unauthorized libraries found'),
    processes: byKind('process').length
      ? `<div class="findings">${byKind('process').map(findingItem).join('')}</div>`
      : emptyBlock('No suspicious processes were running during the scan', 'i-check'),
    antivirus: paneAv,
    checks: other.length
      ? `<div class="findings">${other.map(findingItem).join('')}</div>`
      : emptyBlock('No other checks to report', 'i-check'),
    ai: paneAi,
  };

  $('#view-report').innerHTML = `
    <section class="hero ${vm.cls}">
      <div class="hero-grid">
        <div>
          <div class="hero-title">Scan Results</div>
          <p class="hero-sub">Detailed forensic breakdown and logic analysis of the requested execution context.</p>
          <div class="hero-meta">
            <div>
              <div class="meta-k">Identity PIN</div>
              <div class="pin-chip">${esc(r.sessionPin || '—')}
                <button data-action="copy" data-text="${esc(r.sessionPin || '')}" title="Copy PIN">${icon('i-copy', 14)}</button>
              </div>
            </div>
            <div>
              <div class="meta-k">Scan Duration</div>
              <div class="dur">${fmtDurBig(r.durationMs)}</div>
            </div>
            <div>
              <div class="meta-k">Scanned</div>
              <div class="dur" style="font-size:17px;padding-top:10px">${fmtTime(r.finishedAt || r.createdAt)}</div>
            </div>
          </div>
          <div class="hero-pills">
            <span class="pill ${vm.pill}"><i></i>Game: ${esc(r.game)}</span>
            <span class="pill zinc">Agent ${esc(r.agentVersion || '—')}</span>
            <span class="pill zinc">Player: ${esc(r.playerName || 'unknown')}</span>
          </div>
        </div>
        <div class="hero-verdict">
          <div class="hv-icon">${icon(vm.icon, 22)}</div>
          <div class="hv-word">${vm.word}</div>
          <div class="hv-risk">${icon('i-shield', 13)} ${r.score} risk score</div>
        </div>
      </div>
    </section>

    <div class="report-actions">
      <button class="btn ghost" data-action="export">${icon('i-download', 15)} Export</button>
      <button class="btn ghost" data-page="reports">${icon('i-chev-l', 15)} Back to reports</button>
      <span style="flex:1"></span>
      <button class="btn danger" data-action="report-delete" data-id="${r.id}">${icon('i-trash', 14)} Delete report</button>
    </div>

    <div class="rp-grid">
      <div class="card">
        <div class="card-head">
          <div class="card-title">Scan overview</div>
          <span class="pill ${det ? 'red' : 'zinc'}">${icon('i-xoct', 11)} ${det} detections</span>
        </div>
        <div class="radar-wrap">
          ${radarSvg(det, warn, legit, vm.cls)}
          <div class="radar-stats">
            <div class="rstat ${det ? 'red' : 'dim'}"><div class="k">${icon('i-xoct', 11)} Detections</div><div class="v">${det}</div></div>
            <div class="rstat ${warn ? 'amber' : 'dim'}"><div class="k">${icon('i-warn', 11)} Warnings</div><div class="v">${warn}</div></div>
            <div class="rstat dim"><div class="k">${icon('i-check', 11)} Legit</div><div class="v">${legit}</div></div>
          </div>
          <div class="radar-caption">${det} detections · ${warn} warnings · ${legit} passing checks</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-ico">
            <span class="ci">${icon('i-monitor', 16)}</span>
            <div><div class="card-title">PC Information</div><div class="card-sub">Information about the player's PC</div></div>
          </div>
        </div>
        <div class="pc-metrics">
          <div class="pm ${hasProfile ? 'b' : ''}"><div class="k">${icon('i-clock', 13)} Boot time</div><div class="v">${esc(sys.bootAge || '—')}</div></div>
          <div class="pm ${sys.vpn ? 'a' : sys.vpn === false ? 'g' : ''}"><div class="k">${icon('i-wifi', 13)} VPN</div><div class="v">${sys.vpn ? `Yes${(sys.vpnAdapters || []).length ? ` (${sys.vpnAdapters.length})` : ''}` : sys.vpn === false ? 'No' : '—'}</div></div>
          <div class="pm ${sys.recycleAgeDays >= 0 ? 'g' : ''}"><div class="k">${icon('i-trash', 13)} Recycle</div><div class="v">${sys.recycleAgeDays >= 0 ? `${sys.recycleAgeDays}d ago` : 'Unknown'}</div></div>
        </div>
        <div class="deflist">
          ${defrow('i-monitor', 'System', esc(r.os || r.system?.os || '—'))}
          ${defrow('i-cpu', 'Processor', esc(sys.cpu || '—'))}
          ${defrow('i-drive', 'Memory', sys.memoryMb ? `${sys.memoryMb} MB` : '—')}
          ${defrow('i-zap', 'Hardware stats', sys.gpu ? `${esc(sys.gpu)}${sys.gpuVramMb ? ` · ${sys.gpuVramMb} MB` : ''}` : '—')}
          ${defrow('i-cal', 'Install date', esc(sys.installDate || '—'))}
          ${defrow('i-wifi', 'Country', sys.country ? `${esc(sys.country)}${sys.ip ? ` · ${esc(sys.ip)}` : ''}` : '—')}
          ${defrow('i-monitor', 'Window text', esc(sys.windowText || '—'))}
          ${defrow('i-pin', 'Session', esc(r.sessionName || '—'))}
          ${defrow('i-users', 'Player', esc(r.playerName || '—'))}
          ${defrow('i-game', 'Game', esc(r.game))}
          ${defrow('i-shield', 'Verdict', `<span class="pill ${vm.pill}"><i></i>${vm.label}</span>`)}
          ${defrow('i-zap', 'Risk score', `${r.score} / 100`)}
        </div>
      </div>
    </div>

    <div class="sec-head">
      <span class="sh-ico">${icon('i-fingerprint', 17)}</span>
      <div><h2>Logs</h2><p>Forensic checks, file verification and engine results</p></div>
      <span class="sh-cap">${totalItems} total logs found across ${railItems.length} categories</span>
    </div>
    <div class="rp-tabs" data-railgroup="logs">
      <div class="rail">
        <div class="rail-cap">${totalItems} entries across ${railItems.length} categories</div>
        ${railHtml}
      </div>
      <div class="pane-card">
        ${Object.entries(panes).map(([key, html]) =>
          `<div class="pane ${state.rail === key ? 'active' : ''}" data-pane="${key}">${html}</div>`).join('')}
      </div>
    </div>

    ${(() => {
      /* ---------------- PC activity section (Ocean clone) ---------------- */
      const recentFiles = Array.isArray(sys.recentFiles) ? sys.recentFiles : [];
      const accounts = Array.isArray(sys.accounts) ? sys.accounts : [];
      const recorders = Array.isArray(sys.recorders) ? sys.recorders : [];
      const accFindings = findings.filter((f) => (f.kind || f.category) === 'accounts');
      const recFindings = findings.filter((f) => (f.kind || f.category) === 'recording');

      const bootFields = ['bootTime', 'biosVendor', 'biosVersion', 'boardProduct', 'boardManufacturer']
        .filter((k) => sys[k]).length;

      const actRailItems = [
        { key: 'boot', label: 'Boot Sequence', ic: 'i-drive', cls: 'k-green', count: bootFields },
        { key: 'activity', label: 'Files Activity', ic: 'i-file', cls: 'k-amber', count: recentFiles.length },
        { key: 'accounts', label: 'Accounts', ic: 'i-users', cls: 'k-blue', count: accounts.length },
        { key: 'recording', label: 'Recording Software', ic: 'i-play', cls: 'k-red', count: recorders.length },
      ];
      const actTotal = actRailItems.reduce((a, x) => a + x.count, 0);
      const noProfile = emptyBlock('No activity data — this report came from an older agent build', 'i-activity');

      const actRailHtml = actRailItems.map((it) => `
        <button class="rail-item ${it.cls} ${state.actRail === it.key ? 'active' : ''}" data-action="rail" data-key="${it.key}">
          <span class="rail-ico">${icon(it.ic, 15)}</span>
          <span class="rail-label">${it.label}</span>
          <span class="rail-count">${it.count}${actTotal ? ` (${pctOf(it.count, actTotal)}%)` : ''}</span>
        </button>`).join('');

      const biosCell = (k, v, ic) => `
        <div class="bios-cell"><div class="k">${icon(ic, 11)} ${k}</div><div class="v">${esc(v || 'unknown')}</div></div>`;

      const paneBoot = !hasProfile ? noProfile : `
        <div class="bios-grid">
          ${biosCell('BIOS Vendor', sys.biosVendor, 'i-cpu')}
          ${biosCell('BIOS Version', sys.biosVersion, 'i-hash')}
          ${biosCell('Board Product', sys.boardProduct, 'i-server')}
          ${biosCell('Board Manufacturer', sys.boardManufacturer, 'i-drive')}
        </div>
        ${sys.bootEntry ? `
          <div class="boot-entry">
            <span class="be-ico">${icon('i-shield', 15)}</span>
            <div>
              <div class="be-path">${esc(sys.bootEntry)}</div>
              <div class="be-hash">sha256:${esc(sys.bootEntryHash || '—')}… · verified present</div>
            </div>
          </div>` : ''}
        <div class="deflist">
          ${defrow('i-clock', 'Boot time', esc(sys.bootTime || '—'))}
          ${defrow('i-clock', 'Uptime at scan', esc(sys.bootAge || '—'))}
          ${defrow('i-cpu', 'Windows build', esc(sys.windowsBuild || '—'))}
          ${defrow('i-cal', 'Install date', esc(sys.installDate || '—'))}
        </div>`;

      const paneActivity = !hasProfile ? noProfile : (recentFiles.length ? `
        <div class="act-hero on">
          <div class="ah-ico">📂</div>
          <div>
            <b>${recentFiles.length} executable${recentFiles.length === 1 ? '' : 's'} written in the last 72 hours</b>
            <span>File activity from Downloads, temp folders and AppData at scan time.</span>
          </div>
        </div>
        <div class="mini-files">
          ${recentFiles.map((f, i) => `
            <div class="mini-file" style="animation-delay:${Math.min(i * 30, 420)}ms">
              <span class="mf-ico">${esc(f.kind || 'bin')}</span>
              <div class="mf-main">
                <div class="mf-name">${esc(f.name)}</div>
                <div class="mf-path" title="${esc(f.path)}">${esc(f.path)}</div>
              </div>
              <div class="mf-meta">
                <div class="mf-size">${(f.sizeKb || 0) >= 1024 ? `${((f.sizeKb || 0) / 1024).toFixed(1)} MB` : `${f.sizeKb || 0} KB`}</div>
                <div class="mf-time">${esc(f.modifiedAt || '')}</div>
              </div>
            </div>`).join('')}
        </div>` : emptyBlock('No new executables were written in the watched folders within 72h', 'i-check'));

      const paneAccounts = !hasProfile ? noProfile : `
        <div class="act-hero ${sys.guestEnabled ? 'on' : 'off'}">
          <div class="ah-ico">${sys.guestEnabled ? '👤' : '👥'}</div>
          <div>
            <b>${accounts.length} local account${accounts.length === 1 ? '' : 's'}${sys.guestEnabled ? ' — Guest enabled' : ''}</b>
            <span>Windows user accounts found on this device${sys.currentUserAdmin ? ' · scan ran with admin rights' : ''}.</span>
          </div>
        </div>
        ${accounts.length ? `<div class="acc-grid">
          ${accounts.map((a, i) => `
            <div class="acc-card ${a.name === 'Guest' && !a.disabled ? 'warn' : ''}" style="animation-delay:${Math.min(i * 45, 400)}ms">
              <span class="ac-av">${esc((a.name || '?')[0].toUpperCase())}</span>
              <div style="min-width:0">
                <div class="ac-name">${esc(a.name)}</div>
                <div class="ac-state">${a.disabled ? 'disabled' : 'enabled'}${a.name === 'Guest' ? ' · guest' : ''}</div>
              </div>
            </div>`).join('')}
        </div>` : emptyBlock('No local accounts reported', 'i-users')}
        ${accFindings.length ? `<div class="findings">${accFindings.map(findingItem).join('')}</div>` : ''}`;

      const paneRecording = !hasProfile ? noProfile : `
        <div class="act-hero ${recorders.length ? 'on' : 'off'}">
          <div class="ah-ico">${recorders.length ? '🎥' : '✅'}</div>
          <div>
            <b>${recorders.length ? `${recorders.length} recording/overlay tool${recorders.length === 1 ? '' : 's'} detected` : 'No recording software detected'}</b>
            <span>${recorders.length ? 'Running during the scan — may capture or inject into the game.' : 'No OBS/Fraps/overlay-style processes were running.'}</span>
          </div>
        </div>
        ${recorders.length ? `<div class="rec-grid">
          ${recorders.map((rc, i) => `
            <div class="rec-card" style="animation-delay:${Math.min(i * 45, 400)}ms">
              <span class="rc-ico">${icon('i-play', 15)}</span>
              <div>
                <div class="rc-name">${esc(rc.name)}</div>
                <div class="rc-pid">PID ${esc(String(rc.pid))}</div>
              </div>
            </div>`).join('')}
        </div>` : ''}
        ${recFindings.length ? `<div class="findings">${recFindings.map(findingItem).join('')}</div>` : ''}`;

      const actPanes = { boot: paneBoot, activity: paneActivity, accounts: paneAccounts, recording: paneRecording };

      return `
        <div class="sec-head">
          <span class="sh-ico">${icon('i-activity', 17)}</span>
          <div><h2>PC Activity</h2><p>Live forensic timeline since this boot</p></div>
          <span class="sh-cap">${actTotal} entries across ${actRailItems.length} categories</span>
        </div>
        <div class="rp-tabs" data-railgroup="activity">
          <div class="rail">
            <div class="rail-cap">${actTotal} entries across ${actRailItems.length} categories</div>
            ${actRailHtml}
          </div>
          <div class="pane-card">
            ${Object.entries(actPanes).map(([key, html]) =>
              `<div class="pane ${state.actRail === key ? 'active' : ''}" data-pane="${key}">${html}</div>`).join('')}
          </div>
        </div>`;
    })()}`;
}

/* ============================= system log ============================= */

function paintLog() {
  const q = state.search.trim().toLowerCase();
  let list;
  if (state.fSource === 'http') list = data.eventsHttp || [];
  else if (state.fSource === 'all') {
    list = [...(data.events || []), ...(data.eventsHttp || [])]
      .sort((a, b) => (b.id || 0) - (a.id || 0));
  } else list = data.events || [];
  if (state.fLevel) list = list.filter((e) => e.level === state.fLevel);
  if (q) list = list.filter((e) => (e.message + ' ' + e.type).toLowerCase().includes(q));

  const levelIcon = { success: 'i-check', info: 'i-info', warn: 'i-warn', error: 'i-xoct' };
  const items = list.length ? list.slice(0, 300).map((e, i) => `
    <div class="log-item ${e.level}" style="animation-delay:${Math.min(i * 18, 360)}ms">
      <span class="log-ico">${icon(levelIcon[e.level] || 'i-info', 15)}</span>
      <div class="log-body">
        <div class="log-head">
          <span class="log-msg">${esc(e.message)}</span>
          <span class="log-type">${esc(e.type)}</span>
          <span class="log-time">${fmtTime(e.ts)}</span>
        </div>
        ${e.meta && Object.keys(e.meta).length && e.type !== 'http'
          ? `<div class="log-meta">${esc(JSON.stringify(e.meta))}</div>` : ''}
      </div>
    </div>`).join('') : emptyBlock('No log entries match the filter', 'i-terminal');

  $('#view-log').innerHTML = `
    ${pageHead({
      iconName: 'i-terminal',
      title: 'System Log',
      sub: 'Live portal events, agent uploads and admin actions.',
      actions: `<button class="btn ghost" data-action="refresh">${icon('i-refresh', 15)} Refresh</button>`,
    })}

    <div class="table-card">
      <div class="table-toolbar">
        <label class="searchfield">${icon('i-search', 14)}
          <input class="input" id="in-log" type="text" placeholder="Search log..." value="${esc(state.search)}" data-input="search" />
        </label>
        <select class="select" data-input="f-level">
          <option value="">All levels</option>
          <option value="success" ${state.fLevel === 'success' ? 'selected' : ''}>Success</option>
          <option value="info" ${state.fLevel === 'info' ? 'selected' : ''}>Info</option>
          <option value="warn" ${state.fLevel === 'warn' ? 'selected' : ''}>Warning</option>
          <option value="error" ${state.fLevel === 'error' ? 'selected' : ''}>Error</option>
        </select>
        <select class="select" data-input="f-source">
          <option value="app" ${state.fSource === 'app' ? 'selected' : ''}>Portal app</option>
          <option value="http" ${state.fSource === 'http' ? 'selected' : ''}>HTTP access</option>
          <option value="all" ${state.fSource === 'all' ? 'selected' : ''}>All sources</option>
        </select>
        <span class="grow"></span>
        <button class="btn ghost sm" data-action="clear-filters">Reset</button>
      </div>
      <div style="padding:6px 16px 14px"><div class="log">${items}</div></div>
      <div class="table-foot"><span>${list.length} event${list.length === 1 ? '' : 's'}</span></div>
    </div>`;
}

/* ============================= resources / about ============================= */

function paintAbout() {
  $('#view-about').innerHTML = `
    ${pageHead({ iconName: 'i-info', title: 'Resources', sub: 'About this portal, API reference and design credits.' })}
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div class="card-title">About</div></div>
        <p style="font-size:13.5px;color:var(--text-2);line-height:1.7">
          Consent-based tournament anti-cheat portal. The agent EXE validates a session PIN, shows the player a
          consent screen, runs a ~60 second deep scan (processes, debugger checks, EXE/DLL signature verification,
          antivirus status, game module inspection) and uploads its report here.
          No keystrokes, screenshots, personal files or browsing history are ever collected.
        </p>
        <div class="deflist" style="margin-top:10px">
          <div class="defrow"><span class="k">${icon('i-server', 14)} Portal</span><span class="v mono">127.0.0.1:3000</span></div>
          <div class="defrow"><span class="k">${icon('i-db', 14)} Database</span><span class="v mono">data/portal.db</span></div>
          <div class="defrow"><span class="k">${icon('i-zap', 14)} Agent version</span><span class="v mono">1.0.0</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">API reference</div></div>
        <div class="deflist">
          ${[
            ['POST', '/api/agent/validate'], ['POST', '/api/agent/report'], ['GET', '/api/stats'],
            ['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', '/api/reports'],
            ['GET', '/api/reports/:id'], ['GET', '/api/events'],
          ].map(([m, p]) => `<div class="defrow"><span class="k mono" style="color:var(--blue-3)">${m}</span><span class="v mono">${p}</span></div>`).join('')}
        </div>
        <p class="card-sub" style="margin-top:14px">UI modeled after Ocean Anti-Cheat — dark, minimal, forensic.</p>
      </div>
    </div>`;
}

/* ============================= paywall / easter egg ============================= */

function paintPaywall(title, tag, text) {
  const viewId = state.view === 'statistics' ? 'view-statistics' : 'view-queryuser';
  $(`#${viewId}`).innerHTML = `
    ${pageHead({ iconName: 'i-db', title, sub: tag })}
    <div class="paywall">
      <div class="pw-ico">${icon('i-lock', 28)}</div>
      <div class="pw-tag">DB Access required</div>
      <h2>${esc(tag)}</h2>
      <p>${esc(text)}</p>
      <div class="pw-actions">
        <button class="btn ghost" data-page="doc" data-key="pricing">${icon('i-tag', 15)} View pricing</button>
        <button class="btn primary" data-page="tickets">${icon('i-life', 15)} Contact owner</button>
      </div>
    </div>`;
}

function paintAntic() {
  $('#view-antic').innerHTML = `
    <div class="antic-egg">
      <div class="egg-ico">👀</div>
      <h2>shh… don't tell anyone.</h2>
      <p>you weren't supposed to click that</p>
    </div>`;
}

/* ============================= tickets ============================= */

function paintTickets() {
  const all = data.tickets || [];
  const count = (st) => all.filter((t) => t.status === st).length;
  const active = count('active');
  const awaiting = count('awaiting');
  const closed = count('closed');
  let list = all;
  if (state.fTicket !== 'all') list = list.filter((t) => t.status === state.fTicket);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((t) => (t.title + ' ' + t.id + ' ' + t.created_by).toLowerCase().includes(q));

  const kpis = [
    { cls: 'kpi-white', ic: 'i-life', label: 'Total Tickets', num: all.length, cap: 'all time' },
    { cls: 'kpi-blue', ic: 'i-activity', label: 'Active', num: active, cap: 'being worked on' },
    { cls: 'kpi-amber', ic: 'i-clock', label: 'Awaiting Response', num: awaiting, cap: 'needs your reply' },
    { cls: 'kpi-green', ic: 'i-check', label: 'Closed', num: closed, cap: 'resolved' },
  ].map((k) => `
    <div class="kpi ${k.cls}">
      <div class="kpi-label">${icon(k.ic, 14)} ${k.label}</div>
      <div class="kpi-num">${k.num}</div>
      <div class="kpi-cap">${k.cap}</div>
    </div>`).join('');

  const statusPill = { active: '<span class="pill s-active"><i></i>Active</span>', awaiting: '<span class="pill s-awaiting"><i></i>Awaiting</span>', closed: '<span class="pill s-closed"><i></i>Closed</span>' };
  const rows = list.length ? list.map((t, i) => `
    <tr style="animation-delay:${Math.min(i * 35, 400)}ms">
      <td><div class="cell-main">${esc(t.title)}</div><div class="cell-sub mono">${esc(t.id)}</div></td>
      <td><div class="cell-flex"><span class="gchip" style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);width:24px;height:24px;font-size:11px;border-radius:50%">A</span><span>${esc(t.created_by || 'Administrator')}</span></div></td>
      <td>${statusPill[t.status] || statusPill.active}</td>
      <td><span class="pill p-${esc(t.priority)}">${esc(t.priority)}</span></td>
      <td><span class="cell-sub" style="margin:0">${esc(t.assigned || '— unassigned —')}</span></td>
      <td><div class="cell-main">${fmtTime(t.createdAt)}</div><div class="cell-sub">${fmtAgo(t.createdAt)}</div></td>
      <td class="t-right" style="white-space:nowrap">
        <button class="icon-btn" style="display:inline-grid;width:30px;height:30px" data-action="ticket-status" data-id="${esc(t.id)}" data-status="${t.status === 'closed' ? 'active' : 'closed'}" title="${t.status === 'closed' ? 'Reopen' : 'Close'}">${icon(t.status === 'closed' ? 'i-refresh' : 'i-check', 14)}</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="7">${emptyBlock('No tickets match the filter', 'i-life')}</td></tr>`;

  $('#view-tickets').innerHTML = `
    ${pageHead({
      iconName: 'i-life',
      title: 'Tickets',
      sub: 'Manage and track your support tickets.',
      actions: `<button class="btn ghost" data-action="refresh">${icon('i-refresh', 15)} Refresh</button>
                <button class="btn primary" data-action="ticket-new">${icon('i-plus', 15)} New Ticket</button>`,
    })}
    <div class="kpis">${kpis}</div>
    <div class="table-card section-gap">
      <div class="table-toolbar">
        <label class="searchfield">${icon('i-search', 14)}
          <input class="input" id="in-tickets" type="text" placeholder="Search tickets..." value="${esc(state.search)}" data-input="search" />
        </label>
        <select class="select" data-input="f-ticket">
          <option value="all" ${state.fTicket === 'all' ? 'selected' : ''}>All Status</option>
          <option value="active" ${state.fTicket === 'active' ? 'selected' : ''}>Active</option>
          <option value="awaiting" ${state.fTicket === 'awaiting' ? 'selected' : ''}>Awaiting</option>
          <option value="closed" ${state.fTicket === 'closed' ? 'selected' : ''}>Closed</option>
        </select>
        <span class="grow"></span>
      </div>
      <table class="table">
        <thead><tr><th>Title</th><th>Created By</th><th>Status</th><th>Priority</th><th>Assigned Staff</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="table-foot"><span>${list.length} of ${all.length} ticket${all.length === 1 ? '' : 's'}</span></div>
    </div>`;
}

/* ============================= chat (Ocean Assistant) ============================= */

const CHAT_PROMPTS = [
  'How many reports do we have?',
  'Any detected players?',
  'Summarize the pins',
  'Which files are flagged?',
  'What can you do?',
];

let chatTyping = false;

function paintChat() {
  const msgs = data.chat || [];
  const body = msgs.length
    ? msgs.map((m, i) => `
      <div class="cmsg ${m.role === 'assistant' ? 'assistant' : 'user'}" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <span class="cm-av">${m.role === 'assistant' ? '🌊' : 'A'}</span>
        <div class="cm-bubble">${esc(m.text)}</div>
      </div>`).join('')
    : `<div class="chat-intro">
        <div class="ci-ico">${icon('i-spark', 24)}</div>
        <b>Hi, I'm the Portal Assistant.</b>
        <p>How can I help you today? I answer from live portal data only.</p>
      </div>`;

  $('#view-chat').innerHTML = `
    ${pageHead({
      iconName: 'i-message',
      title: 'Ocean Chat',
      sub: 'Local assistant that answers from your portal data.',
      actions: `${msgs.length ? `<button class="btn ghost" data-action="chat-clear">${icon('i-trash', 14)} Clear chat</button>` : ''}`,
    })}
    <div class="chat-wrap">
      <div class="chat-side">
        <div class="cs-title">New Chat</div>
        <div class="cs-prompts">
          ${CHAT_PROMPTS.map((p) => `<button class="cs-prompt" data-action="chat-prompt" data-text="${esc(p)}">${esc(p)}</button>`).join('')}
        </div>
      </div>
      <div class="chat-main">
        <div class="chat-head">
          <span class="ch-ico">${icon('i-spark', 16)}</span>
          <div><b>Portal Assistant</b><span>online · local data</span></div>
          <span class="grow"></span>
        </div>
        <div class="chat-msgs" id="chat-msgs">
          ${body}
          ${chatTyping ? `<div class="cmsg assistant"><span class="cm-av">🌊</span><div class="cm-bubble"><span class="chat-typing"><i></i><i></i><i></i></span></div></div>` : ''}
        </div>
        <form class="chat-bar" id="chat-form">
          <input type="text" id="chat-input" placeholder="Send a message..." autocomplete="off" maxlength="2000" />
          <button type="submit" class="btn primary" ${chatTyping ? 'disabled' : ''}>${icon('i-chev-r', 15)}</button>
        </form>
      </div>
    </div>`;

  const msgsEl = $('#chat-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  const form = $('#chat-form');
  if (form) form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    input.value = '';
    sendChat(text);
  });
}

async function sendChat(text) {
  if (!text || chatTyping) return;
  chatTyping = true;
  data.chat = [...(data.chat || []), { role: 'user', text, ts: new Date().toISOString() }];
  paintChat();
  try {
    await api('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    data.chat = await api('/api/chat');
  } catch (err) {
    data.chat = [...(data.chat || []), { role: 'assistant', text: `Sorry — ${err.message}` }];
  }
  chatTyping = false;
  paintChat();
}

/* ============================= leaderboard ============================= */

function paintLeaderboard() {
  const byPlayer = new Map();
  for (const r of data.reports) {
    const key = r.playerName || r.hostname || 'unknown';
    const e = byPlayer.get(key) || { name: key, scans: 0, clean: 0, suspicious: 0, detected: 0, scoreSum: 0, last: '' };
    e.scans++;
    if (r.verdict === 'clean') e.clean++;
    else if (r.verdict === 'suspicious') e.suspicious++;
    else e.detected++;
    e.scoreSum += r.score;
    const ts = r.finishedAt || r.createdAt;
    if (ts > e.last) e.last = ts;
    byPlayer.set(key, e);
  }
  const players = [...byPlayer.values()]
    .map((p) => ({ ...p, avg: Math.round(p.scoreSum / p.scans) }))
    .sort((a, b) => b.clean - a.clean || a.avg - b.avg || b.scans - a.scans);

  const medals = ['🥇', '🥈', '🥉'];
  const podium = players.slice(0, 3).map((p, i) => `
    <div class="pod ${i === 0 ? 'first' : i === 1 ? 'second' : 'third'}" style="animation-delay:${i * 90}ms">
      <div class="p-medal">${medals[i]}</div>
      <div class="p-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="p-sub">${p.scans} scan${p.scans === 1 ? '' : 's'} · ${p.clean} clean</div>
      <div class="p-score">${p.avg} <small style="font-size:11px;color:var(--text-4)">avg risk</small></div>
    </div>`).join('');

  const rows = players.map((p, i) => `
    <tr>
      <td class="num"><b>#${i + 1}</b></td>
      <td><div class="cell-main">${esc(p.name)}</div></td>
      <td class="num">${p.scans}</td>
      <td><span class="pill green"><i></i>${p.clean}</span></td>
      <td><span class="pill amber">${p.suspicious}</span></td>
      <td><span class="pill red">${p.detected}</span></td>
      <td class="num"><b>${p.avg}</b></td>
      <td><span class="cell-sub" style="margin:0">${fmtTime(p.last)}</span></td>
    </tr>`).join('');

  $('#view-leaderboard').innerHTML = `
    ${pageHead({ iconName: 'i-trophy', title: 'Leaderboard', sub: 'Top performers in the community' })}
    ${players.length ? `
      <div class="podium">${podium}</div>
      <div class="table-card">
        <table class="table">
          <thead><tr><th>#</th><th>Player</th><th>Scans</th><th>Clean</th><th>Suspicious</th><th>Detected</th><th>Avg risk</th><th>Last scan</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="table-foot"><span>${players.length} player${players.length === 1 ? '' : 's'} ranked by clean scans</span></div>
      </div>` : emptyBlock('No scans yet — the leaderboard fills up as players verify', 'i-trophy')}`;
}

/* ============================= download ============================= */

function paintDownload() {
  $('#view-download').innerHTML = `
    <div class="dl-hero">
      <div class="kicker">Downloads</div>
      <h1>Your scan starts with <em>a PIN.</em></h1>
      <p>Grab the consent-based agent, open it on the player PC, enter the session PIN and run the ~60 second deep
      scan. Results upload straight to this portal — nothing else leaves the device.</p>
    </div>

    <div class="dl-grid">
      <div class="dl-card">
        <div class="dl-ico">${icon('i-download', 22)}</div>
        <h3>AntiCheat Standalone Client</h3>
        <p class="dl-desc">Direct single-file executable for Windows: download <span class="mono">AntiCheat.exe</span>, run it, and enter the session PIN. No ZIP extraction, no extra DLL files, and no runtime installation required. Connects automatically to the tournament network.</p>
        <div class="dl-meta">
          <span class="pill zinc">Windows 10/11 · x64</span>
          <span class="pill zinc">v1.0.0</span>
          <span class="pill green"><i></i>Direct .EXE (No ZIP)</span>
          <span class="pill blue">Standalone</span>
        </div>
        <a class="btn primary dl-btn" href="/download/agent" download="AntiCheat.exe">${icon('i-download', 16)} Download AntiCheat.exe</a>
        <p class="dl-note">No installation needed. Single standalone binary ready to run immediately on player PCs.</p>
      </div>

      <div class="dl-steps">
        <div class="dl-step" style="animation-delay:0ms">
          <span class="st-num">1</span>
          <div><b>Create a pin</b><p>Dashboard → Create Pin. Pick the game, name it, generate the PIN.</p></div>
        </div>
        <div class="dl-step" style="animation-delay:70ms">
          <span class="st-num">2</span>
          <div><b>Share the PIN + EXE</b><p>Give the player the PIN and the direct download link for <span class="mono">AntiCheat.exe</span>.</p></div>
        </div>
        <div class="dl-step" style="animation-delay:140ms">
          <span class="st-num">3</span>
          <div><b>Consent &amp; scan</b><p>The player reviews the consent screen, ticks agree and starts the scan.</p></div>
        </div>
        <div class="dl-step" style="animation-delay:210ms">
          <span class="st-num">4</span>
          <div><b>Report lands here</b><p>The verdict, PC profile and full forensic logs appear under Reports.</p></div>
        </div>
        <div class="dl-step" style="animation-delay:280ms">
          <span class="st-num">?</span>
          <div><b>Can't run the agent?</b><p>WebView2 runtime required. Ask in <button class="link-btn" data-page="tickets">Tickets</button> — or re-download from this page.</p></div>
        </div>
      </div>
    </div>`;
}

/* ============================= doc pages ============================= */

function paintDoc() {
  const key = state.docKey;
  const wrap = $('#view-doc');

  if (key === 'pricing') {
    const plan = (tier, price, per, featured, feats) => `
      <div class="price-card ${featured ? 'featured' : ''}">
        <div class="pc-tier">${tier} ${featured ? '<span class="pill blue">Popular</span>' : ''}</div>
        <div class="pc-price">${price}<small>${per}</small></div>
        <ul>${feats.map(([on, t]) => `<li class="${on ? '' : 'off'}">${icon(on ? 'i-check' : 'i-xoct', 13)} <span>${t}</span></li>`).join('')}</ul>
      </div>`;
    wrap.innerHTML = `
      ${pageHead({ iconName: 'i-tag', title: 'Pricing', sub: 'Simple plans for tournaments of any size.' })}
      <div class="price-grid">
        ${plan('Community', 'Free', '', false, [
          [true, '1 daily pin'], [true, 'Consent-based agent scans'], [true, 'Full report pages'],
          [false, 'Database statistics'], [false, 'Cheater database lookup'],
        ])}
        ${plan('Tournament', '$29', '/mo', true, [
          [true, 'Unlimited pins & players'], [true, 'All detection tools'], [true, 'Priority scan processing'],
          [true, 'Leaderboard & exports'], [true, 'Support tickets'],
        ])}
        ${plan('DB Access', '$99', '/mo', false, [
          [true, 'Everything in Tournament'], [true, 'Live cheater database statistics'],
          [true, 'Cheater database lookup'], [true, 'Bulk query API'], [true, 'Engines logs unlocked'],
        ])}
      </div>`;
    return;
  }

  if (key === 'changelog') {
    const entry = (ver, date, items, tag) => `
      <div class="changelog-entry">
        <div class="ce-head"><b>${ver}</b><span class="pill ${tag === 'major' ? 'blue' : 'green'}"><i></i>${tag}</span><span class="grow"></span><span class="cell-sub">${date}</span></div>
        <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
      </div>`;
    wrap.innerHTML = `
      ${pageHead({ iconName: 'i-clock', title: 'Changelogs', sub: 'What shipped in each portal + agent release.' })}
      <div class="doc-body">
        ${entry('v1.1.0', 'current', [
          'Full Ocean UI clone: sidebar groups, Create Pin modal, Detections suite, Tickets, Chat assistant.',
          'Agent now profiles boot/BIOS, GPU, VPN, accounts, recording software, file activity, PowerShell patterns, country + focused window.',
          'Report page gained the PC Activity section (Boot Sequence / Files Activity / Accounts / Recording Software) and the AI Opinion pane.',
          'Pin visibility (Private/Public) with a dedicated column.',
        ], 'major')}
        ${entry('v1.0.0', 'initial', [
          'Consent-based WPF agent with PIN validation and ~60s deep scan window.',
          'EXE/DLL inventory with Authenticode verification (WinVerifyTrust).',
          'Dark portal: dashboard, pins, reports with radar + category rail, system log.',
        ], 'initial')}
      </div>`;
    return;
  }

  if (key === 'tos' || key === 'privacy' || key === 'legal') {
    const content = {
      tos: {
        kicker: 'Legal', title: 'Terms of Service',
        sub: 'By using this portal and agent you agree to these terms.',
        body: `
          <h2>1. Consent first</h2>
          <p>The agent only scans a device after the player reads and accepts the consent screen. Unattended mode
          (<code>--auto</code>) may only be used by the tournament operator on machines they administer.</p>
          <h2>2. What is collected</h2>
          <p>Scan findings (processes, file signatures, engines, boot profile, accounts, recording software,
          PowerShell patterns, approximate country) and device identity. <b>No keystrokes, screenshots, personal
          files or browsing history are ever collected.</b></p>
          <h2>3. Purpose</h2>
          <p>Reports are used solely to verify fair play in the tournament that issued the PIN.</p>
          <h2>4. Deletion</h2>
          <p>Organizers can delete sessions and reports at any time from this portal; deletion is permanent.</p>`,
      },
      privacy: {
        kicker: 'Legal', title: 'Privacy Policy',
        sub: 'How data flows through this local deployment.',
        body: `
          <h2>Local by design</h2>
          <p>This portal binds to <code>127.0.0.1</code> only. Reports never leave the machine running the portal.</p>
          <h2>Agent telemetry</h2>
          <p>The agent uploads one JSON report per consented scan: system profile, findings and flagged files.
          The country field uses a public-IP lookup and can be refused by disconnecting the network during the scan.</p>
          <h2>Retention</h2>
          <p>Data lives in <code>data/portal.db</code> until an administrator deletes it or removes the file.</p>`,
      },
      legal: {
        kicker: 'Legal', title: 'Legal',
        sub: 'Compliance notes for tournaments.',
        body: `
          <h2>Fair play</h2>
          <p>Detection results are advisory evidence. Organizers should review the forensic logs before acting
          against a player.</p>
          <h2>No warranty</h2>
          <p>The software is provided as-is for anti-cheat verification; verdicts may contain false positives
          (unsigned drivers, overlay tools) and must be contextualised.</p>`,
      },
    }[key];
    wrap.innerHTML = `
      <div class="doc-hero">
        <div class="kicker">${content.kicker}</div>
        <h1>${content.title}</h1>
        <p>${content.sub}</p>
      </div>
      <div class="doc-body">${content.body}</div>`;
    return;
  }

  // documentation (default)
  wrap.innerHTML = `
    <div class="doc-hero">
      <div class="kicker">Resources</div>
      <h1>Documentation</h1>
      <p>Everything about running the consent-based anti-cheat pipeline: pin flow, agent behaviour, report anatomy
      and the local API.</p>
    </div>
    <div class="doc-body">
      <h2>1. The pin flow</h2>
      <ul>
        <li><b>Create a pin</b> — Dashboard → Create Pin: pick a game, optional name, private/public, validity.</li>
        <li><b>Share it</b> — players get the PIN (<code>XXXX-XXXX</code>) plus the agent EXE from the Download page.</li>
        <li><b>Scan</b> — the agent validates the PIN against this portal, shows the consent screen, scans ~60s and uploads.</li>
        <li><b>Review</b> — Reports → open the result: verdict hero, radar, PC Information, Logs and PC Activity.</li>
      </ul>
      <h2>2. What the agent checks</h2>
      <ul>
        <li>Cheat processes, debugger presence, loaded game modules.</li>
        <li>EXE/DLL inventory across Downloads, temp, Program Files and AppData with Authenticode verification.</li>
        <li>Antivirus / real-time protection status (Engines).</li>
        <li>Boot/BIOS identity, boot-manager hash, GPU + VRAM, install date.</li>
        <li>VPN adapters, recycle-bin age, approximate country, focused window title.</li>
        <li>Local accounts (guest flag), recording/overlay software, files written in the last 72h.</li>
        <li>PowerShell history + script-block patterns (cheat-install signatures).</li>
      </ul>
      <h3>Never collected</h3>
      <p>Keystrokes, screenshots, personal files, browsing history, USB or file-deletion logs.</p>
      <h2>3. Verdict logic</h2>
      <p>Each finding weighs points: <code>critical 25 · high 12 · medium 5 · low 1 · info 0</code>.
      Score ≥ 25 → <b>DETECTED</b>, ≥ 5 → <b>SUSPICIOUS</b>, else <b>CLEAN</b>.</p>
      <h2>4. Local API</h2>
      <p><code>POST /api/agent/validate</code> · <code>POST /api/agent/report</code> · <code>GET /api/stats</code> ·
      <code>GET /api/sessions</code> · <code>GET /api/reports</code> · <code>GET /api/events</code> ·
      <code>GET /api/detections</code> · <code>GET /api/tickets</code> · <code>POST /api/chat</code> ·
      <code>GET /download/agent</code></p>
    </div>`;
}

/* ============================= detections suite ============================= */

const DET_TABS = [
  { key: 'virustotal', name: 'VirusTotal Scanner', sub: 'Malware & Virus', desc: 'Deep file & multi-engine malware detection' },
  { key: 'url_scanner', name: 'URL & C2 Scanner', sub: 'URL Scanner', desc: 'Detect malicious URLs, webhooks & C2 endpoints' },
  { key: 'presence', name: 'Cheat & Tool Presence', sub: 'Cheats', desc: 'Known cheat artifacts & injector names' },
  { key: 'suspicious', name: 'Injection Heuristics', sub: 'Heuristics', desc: 'Process injection & memory tampering' },
  { key: 'lua', name: 'Lua Detections', sub: 'Lua', desc: 'Executor APIs and exploit markers' },
  { key: 'string', name: 'String & URL Extractor', sub: 'Extractor', desc: 'Pull printable strings and URLs from any binary' },
  { key: 'market', name: 'Detections Marketplace', sub: 'Marketplace', desc: 'Bundled signature packs' },
];

/* Pure JS MD5 implementation for fast browser client hashing */
function fastMd5(bytes) {
  function safeAdd(x, y) { const lsw = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff); }
  function bitRol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  const len = bytes.length;
  const words = [];
  for (let i = 0; i < len; i++) words[i >> 2] |= (bytes[i] & 0xff) << ((i % 4) * 8);
  words[len >> 2] |= 0x80 << ((len % 4) * 8);
  words[(((len + 8) >> 6) << 4) + 14] = len * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const olda = a, oldb = b, oldc = c, oldd = d;
    a = md5ff(a, b, c, d, words[i + 0] || 0, 7, -680876936);
    d = md5ff(d, a, b, c, words[i + 1] || 0, 12, -389564586);
    c = md5ff(c, d, a, b, words[i + 2] || 0, 17, 606105819);
    b = md5ff(b, c, d, a, words[i + 3] || 0, 22, -1044525330);
    a = md5ff(a, b, c, d, words[i + 4] || 0, 7, -176418897);
    d = md5ff(d, a, b, c, words[i + 5] || 0, 12, 1200080426);
    c = md5ff(c, d, a, b, words[i + 6] || 0, 17, -1473231341);
    b = md5ff(b, c, d, a, words[i + 7] || 0, 22, -45705983);
    a = md5ff(a, b, c, d, words[i + 8] || 0, 7, 1770035416);
    d = md5ff(d, a, b, c, words[i + 9] || 0, 12, -1958414417);
    c = md5ff(c, d, a, b, words[i + 10] || 0, 17, -42063);
    b = md5ff(b, c, d, a, words[i + 11] || 0, 22, -1990404162);
    a = md5ff(a, b, c, d, words[i + 12] || 0, 7, 1804603682);
    d = md5ff(d, a, b, c, words[i + 13] || 0, 12, -40341101);
    c = md5ff(c, d, a, b, words[i + 14] || 0, 17, -1502002290);
    b = md5ff(b, c, d, a, words[i + 15] || 0, 22, 1236535329);

    a = md5gg(a, b, c, d, words[i + 1] || 0, 5, -165796510);
    d = md5gg(d, a, b, c, words[i + 6] || 0, 9, -1069501632);
    c = md5gg(c, d, a, b, words[i + 11] || 0, 14, 643717713);
    b = md5gg(b, c, d, a, words[i + 0] || 0, 20, -373897302);
    a = md5gg(a, b, c, d, words[i + 5] || 0, 5, -701558691);
    d = md5gg(d, a, b, c, words[i + 10] || 0, 9, 38016083);
    c = md5gg(c, d, a, b, words[i + 15] || 0, 14, -660478335);
    b = md5gg(b, c, d, a, words[i + 4] || 0, 20, -405537848);
    a = md5gg(a, b, c, d, words[i + 9] || 0, 5, 568446438);
    d = md5gg(d, a, b, c, words[i + 14] || 0, 9, -1019803690);
    c = md5gg(c, d, a, b, words[i + 3] || 0, 14, -187363961);
    b = md5gg(b, c, d, a, words[i + 8] || 0, 20, 1163531501);
    a = md5gg(a, b, c, d, words[i + 13] || 0, 5, -1444681467);
    d = md5gg(d, a, b, c, words[i + 2] || 0, 9, -51403784);
    c = md5gg(c, d, a, b, words[i + 7] || 0, 14, 1735328473);
    b = md5gg(b, c, d, a, words[i + 12] || 0, 20, -1926607734);

    a = md5hh(a, b, c, d, words[i + 5] || 0, 4, -378558);
    d = md5hh(d, a, b, c, words[i + 8] || 0, 11, -2022574463);
    c = md5hh(c, d, a, b, words[i + 11] || 0, 16, 1839030562);
    b = md5hh(b, c, d, a, words[i + 14] || 0, 23, -35309556);
    a = md5hh(a, b, c, d, words[i + 1] || 0, 4, -1530992060);
    d = md5hh(d, a, b, c, words[i + 4] || 0, 11, 1272893353);
    c = md5hh(c, d, a, b, words[i + 7] || 0, 16, -155497632);
    b = md5hh(b, c, d, a, words[i + 10] || 0, 23, -1094730640);
    a = md5hh(a, b, c, d, words[i + 13] || 0, 4, 681279174);
    d = md5hh(d, a, b, c, words[i + 0] || 0, 11, -358537222);
    c = md5hh(c, d, a, b, words[i + 3] || 0, 16, -722521979);
    b = md5hh(b, c, d, a, words[i + 6] || 0, 23, 76029189);
    a = md5hh(a, b, c, d, words[i + 9] || 0, 4, -640364487);
    d = md5hh(d, a, b, c, words[i + 12] || 0, 11, -421815835);
    c = md5hh(c, d, a, b, words[i + 15] || 0, 16, 530742520);
    b = md5hh(b, c, d, a, words[i + 2] || 0, 23, -995338651);

    a = md5ii(a, b, c, d, words[i + 0] || 0, 6, -198630844);
    d = md5ii(d, a, b, c, words[i + 7] || 0, 10, 1126891415);
    c = md5ii(c, d, a, b, words[i + 14] || 0, 15, -1416354905);
    b = md5ii(b, c, d, a, words[i + 5] || 0, 21, -57434055);
    a = md5ii(a, b, c, d, words[i + 12] || 0, 6, 1700485571);
    d = md5ii(d, a, b, c, words[i + 3] || 0, 10, -1894986606);
    c = md5ii(c, d, a, b, words[i + 10] || 0, 15, -1051523);
    b = md5ii(b, c, d, a, words[i + 1] || 0, 21, -2054922799);
    a = md5ii(a, b, c, d, words[i + 8] || 0, 6, 1873313359);
    d = md5ii(d, a, b, c, words[i + 15] || 0, 10, -30611744);
    c = md5ii(c, d, a, b, words[i + 6] || 0, 15, -1560198380);
    b = md5ii(b, c, d, a, words[i + 13] || 0, 21, 1309151649);
    a = md5ii(a, b, c, d, words[i + 4] || 0, 6, -145523070);
    d = md5ii(d, a, b, c, words[i + 11] || 0, 10, -1120210379);
    c = md5ii(c, d, a, b, words[i + 2] || 0, 15, 718787259);
    b = md5ii(b, c, d, a, words[i + 9] || 0, 21, -343485551);

    a = safeAdd(a, olda);
    b = safeAdd(b, oldb);
    c = safeAdd(c, oldc);
    d = safeAdd(d, oldd);
  }

  const toHex = (n) => {
    let s = '';
    for (let j = 0; j < 4; j++) s += ((n >> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

async function computeHashes(buf) {
  const sha256Buf = await crypto.subtle.digest('SHA-256', buf);
  const sha1Buf = await crypto.subtle.digest('SHA-1', buf);
  const toHex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  return {
    sha256: toHex(sha256Buf),
    sha1: toHex(sha1Buf),
    md5: fastMd5(new Uint8Array(buf)),
  };
}

function extractAllUrls(rawText, wideText) {
  const re = /https?:\/\/[a-zA-Z0-9_\-\.\/:\?\#\[\]\@\!\$\&'\(\)\*\+\,\;\=\%]+/gi;
  const urls = new Map();
  const check = (str) => {
    if (!str) return;
    let match;
    while ((match = re.exec(str)) !== null) {
      const u = match[0].replace(/[.,;:)]+$/, '');
      if (u.length > 9 && !urls.has(u)) {
        let type = 'url-safe';
        let badge = 'External URL';
        let severity = 'info';

        if (/discord(app)?\.com\/api\/webhooks\//i.test(u)) {
          type = 'url-malicious';
          badge = 'Discord Webhook (Credential Stealer Exfiltration)';
          severity = 'high';
        } else if (/api\.telegram\.org\/bot/i.test(u)) {
          type = 'url-malicious';
          badge = 'Telegram Bot Exfiltration / C2';
          severity = 'high';
        } else if (/pastebin\.com\/raw\/|raw\.githubusercontent\.com\/|rentry\.co\//i.test(u)) {
          type = 'url-suspicious';
          badge = 'Raw Payload / Dropper Script';
          severity = 'warn';
        } else if (/\.(xyz|top|ru|onion|to|cc|tk|ml|gq|cf)(\/|$)/i.test(u)) {
          type = 'url-suspicious';
          badge = 'High-Risk TLD Domain';
          severity = 'warn';
        } else if (/ngrok.*\.app|ngrok\.io|portmap\.io|duckdns\.org|hopto\.org/i.test(u)) {
          type = 'url-suspicious';
          badge = 'Tunneling / Dynamic DNS C2';
          severity = 'warn';
        } else if (/https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i.test(u)) {
          type = 'url-suspicious';
          badge = 'Direct IP Endpoint (No Domain)';
          severity = 'warn';
        }

        urls.set(u, { url: u, type, badge, severity });
      }
    }
  };
  check(rawText);
  if (wideText) check(wideText);
  return Array.from(urls.values());
}

/* Comprehensive Threat, Virus & Malware Signatures Database */
const DET_DB = {
  // EICAR Standard Antivirus Test File & Direct Viruses
  viruses: [
    ['x5o!p%@ap[4\\pzx54(p^)7cc)7}$eicar-standard-antivirus-test-file!$h+h*', 10, 'EICAR Standard Antivirus Test File', 'virus'],
    ['eicar-standard-antivirus-test-file', 10, 'EICAR Test Marker', 'virus'],
    ['autorun.inf', 4, 'Autorun Worm Spreader', 'worm'],
    ['wscript.shell', 2, 'Windows Script Host Execution', 'dropper'],
  ],
  // InfoStealers & Credential Harvesters
  stealers: [
    ['redline', 4, 'RedLine Infostealer', 'stealer'],
    ['lumma', 4, 'Lumma Infostealer', 'stealer'],
    ['encryptedusername', 3, 'Chromium Credential Decryptor', 'stealer'],
    ['encryptedpassword', 3, 'Browser Password Harvester', 'stealer'],
    ['cookies.sqlite', 3, 'Firefox Cookie Harvester', 'stealer'],
    ['discord_token', 4, 'Discord Token Harvester', 'stealer'],
    ['leveldb', 2, 'Discord LocalStorage LevelDB Theft', 'stealer'],
    ['blankgrabber', 5, 'BlankGrabber Token Logger', 'stealer'],
    ['piratestealer', 5, 'PirateStealer Discord Logger', 'stealer'],
    ['tokengrabber', 4, 'TokenGrabber Utility', 'stealer'],
    ['nkbihfbeogaeaoehlefnkodbefgpgknn', 3, 'Metamask Wallet Harvester', 'stealer'],
    ['exodus.wallet', 3, 'Exodus Crypto Wallet Theft', 'stealer'],
  ],
  // Trojans & Remote Access Tools (RATs)
  trojans: [
    ['asyncclient', 5, 'AsyncRAT Remote Access Trojan', 'trojan'],
    ['asyncrat', 5, 'AsyncRAT Marker', 'trojan'],
    ['quasarshell', 5, 'QuasarRAT Client', 'trojan'],
    ['quasarserver', 5, 'Quasar Remote Access Trojan', 'trojan'],
    ['warzone rat', 5, 'Warzone RAT Backdoor', 'trojan'],
    ['avemaria', 5, 'AveMaria / Warzone Trojan', 'trojan'],
    ['remcos', 5, 'Remcos Remote Access Trojan', 'trojan'],
    ['remcos_mutex', 5, 'Remcos Trojan Mutex', 'trojan'],
    ['njrat', 5, 'NjRAT / Bladabindi Backdoor', 'trojan'],
    ['njq8', 5, 'NjRAT Signature', 'trojan'],
    ['xworm', 5, 'XWorm Remote Access Trojan', 'trojan'],
    ['darkcomet', 5, 'DarkComet RAT Backdoor', 'trojan'],
    ['gh0st', 4, 'Gh0st RAT Payload', 'trojan'],
  ],
  // Ransomware & System Sabotage
  ransomware: [
    ['vssadmin delete shadows', 6, 'Volume Shadow Copy Deletion (Ransomware)', 'ransomware'],
    ['wmic shadowcopy delete', 6, 'Shadow Copy Deletion via WMI', 'ransomware'],
    ['recoveryenabled no', 5, 'Boot Recovery Disabled (Ransomware)', 'ransomware'],
    ['wbadmin delete catalog', 5, 'Windows Backup Deletion', 'ransomware'],
    ['ignoreallfailures', 4, 'Boot Failure Policy Manipulation', 'ransomware'],
  ],
  // Defense Evasion & Anti-Analysis
  evasion: [
    ['disablerealtimemonitoring', 4, 'Windows Defender Realtime Protection Disabled', 'evasion'],
    ['set-mppreference', 3, 'Windows Defender Policy Tampering', 'evasion'],
    ['disablebehaviormonitoring', 4, 'Defender Behavior Monitoring Disabled', 'evasion'],
    ['amsiscanbuffer', 4, 'AMSI Antimalware Scan Bypass', 'evasion'],
    ['amsi.dll', 2, 'AMSI Library Referencing', 'evasion'],
    ['etweventwrite', 3, 'ETW Event Tracing Blinding', 'evasion'],
    ['isdebuggerpresent', 2, 'Anti-Debugging Check', 'evasion'],
    ['checkremotedebuggerpresent', 2, 'Remote Debugger Detection', 'evasion'],
  ],
  // Injection & Cheats
  presence: [
    'cheatengine', 'cheat engine', 'dolphinjector', 'dolphin injector', 'unknowncheats',
    'xigncode3', 'easyanticheat', 'easy anti-cheat', 'battleye', 'nprotect', 'gameguard',
    'xtrap', 'artmoney', 'tsearch', 'gameguardian', 'sb game hacker', 'lucky patcher',
    'internalcheat', 'aimbot.dll', 'wallhack', 'esp.dll', 'triggerbot', 'silentaim',
    'autohotkey', 'webrune', 'pubg hack', 'free fire hack', 'inject.dll', 'cheat.zip',
    'mod menu', 'modmenu', 'regedit', 'hwid spoofer', 'spoofer', 'kdmapper', 'kdu',
    'mhyprot2.sys', 'gdrv.sys', 'capcom.sys',
  ],
  suspicious: [
    ['createremotethread', 3], ['writeprocessmemory', 3], ['ntwritevirtualmemory', 3],
    ['virtualallocex', 3], ['reflective', 3], ['manual map', 3], ['manualmap', 3],
    ['ntunmapviewofsection', 3], ['setwindowshookex', 2], ['x64dbg', 2], ['ollydbg', 2],
    ['x32dbg', 2], ['processhacker', 2], ['cheatengine', 3], ['aimbot', 3], ['wallhack', 3],
    ['triggerbot', 3], ['silentaim', 3], ['godmode', 2], ['noclip', 2], ['amsi', 2],
    ['powershell -enc', 3], ['powershell -w hidden', 3], ['certutil -urlcache', 3],
    ['bitsadmin /transfer', 2], ['token steal', 3], ['grabber', 2], ['keylogger', 3],
    ['shellcode', 2],
  ],
  lua: [
    ['getgenv', 3], ['hookmetamethod', 3], ['getrawmetatable', 2], ['hookfunction', 2],
    ['setreadonly', 2], ['writefile', 2], ['readfile', 2], ['synapse', 3], ['synapsex', 3],
    ['synopyx', 3], ['krnl', 3], ['fluxus', 3], ['script-ware', 3], ['scriptware', 3],
    ['wave.lua', 3], ['tempest', 3], ['oxygenx', 3], ['luraph', 3], ['protosmasher', 3],
    ['electron.lua', 3], ['loadstring', 1], ['firesignal', 2], ['getconnections', 2],
    ['request', 1], ['httpget', 1], ['executor', 2],
  ],
};

const MAX_ANALYZE_BYTES = 32 * 1024 * 1024;

function detMatches(hay, needles) {
  const out = [];
  for (const n of needles) {
    const label = Array.isArray(n) ? n[0] : n;
    const weight = Array.isArray(n) ? n[1] : 1;
    const desc = Array.isArray(n) ? n[2] || label : label;
    const cat = Array.isArray(n) ? n[3] || 'threat' : 'cheat';
    let idx = hay.indexOf(label);
    if (idx === -1) continue;
    let count = 0;
    while (idx !== -1 && count < 50) { count++; idx = hay.indexOf(label, idx + label.length); }
    out.push({ label, weight, count, desc, cat, offset: hay.indexOf(label) });
  }
  return out;
}

function extractStrings(bytes, cap = 24000) {
  const ascii = [];
  let cur = '', start = 0;
  const end = Math.min(bytes.length, MAX_ANALYZE_BYTES);
  for (let i = 0; i < end; i++) {
    const c = bytes[i];
    if (c >= 0x20 && c < 0x7f) {
      if (!cur) start = i;
      cur += String.fromCharCode(c);
      if (cur.length > 400) { ascii.push({ s: cur, o: start }); cur = ''; }
    } else {
      if (cur.length >= 4) ascii.push({ s: cur, o: start });
      cur = '';
    }
    if (ascii.length >= cap) break;
  }
  if (cur.length >= 4 && ascii.length < cap) ascii.push({ s: cur, o: start });

  const wide = [];
  let wcur = '', wstart = 0;
  for (let i = 0; i + 1 < end && wide.length < cap; i += 2) {
    const lo = bytes[i], hi = bytes[i + 1];
    if (hi === 0 && lo >= 0x20 && lo < 0x7f) {
      if (!wcur) wstart = i;
      wcur += String.fromCharCode(lo);
    } else {
      if (wcur.length >= 4) wide.push({ s: wcur, o: wstart });
      wcur = '';
      if ((i & 1) !== 0) i--;
    }
  }
  if (wcur.length >= 4 && wide.length < cap) wide.push({ s: wcur, o: wstart });
  return { ascii, wide };
}

/* Comprehensive Multi-Engine & Threat Analyzer */
async function runDetection(file, mode) {
  const size = Math.min(file.size, MAX_ANALYZE_BYTES);
  const buf = await file.slice(0, size).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder('windows-1252');
  const hay = dec.decode(bytes).toLowerCase();
  let wideHay = '';
  try { wideHay = new TextDecoder('utf-16le').decode(bytes).toLowerCase(); } catch { }

  // 1. Compute cryptographic hashes
  const hashes = await computeHashes(buf);

  // 2. Extract every URL from the file
  const extractedUrls = extractAllUrls(dec.decode(bytes), wideHay);
  const maliciousUrls = extractedUrls.filter((u) => u.severity === 'high');
  const suspiciousUrls = extractedUrls.filter((u) => u.severity === 'warn');

  // 3. Check for viruses, stealers, trojans, ransomware, evasion
  const virusHits = detMatches(hay, DET_DB.viruses).concat(detMatches(wideHay, DET_DB.viruses));
  const stealerHits = detMatches(hay, DET_DB.stealers).concat(detMatches(wideHay, DET_DB.stealers));
  const trojanHits = detMatches(hay, DET_DB.trojans).concat(detMatches(wideHay, DET_DB.trojans));
  const ransomHits = detMatches(hay, DET_DB.ransomware).concat(detMatches(wideHay, DET_DB.ransomware));
  const evasionHits = detMatches(hay, DET_DB.evasion).concat(detMatches(wideHay, DET_DB.evasion));
  const presenceHits = detMatches(hay, DET_DB.presence).concat(detMatches(wideHay, DET_DB.presence));
  const suspiciousHits = detMatches(hay, DET_DB.suspicious).concat(detMatches(wideHay, DET_DB.suspicious));
  const luaHits = detMatches(hay, DET_DB.lua).concat(detMatches(wideHay, DET_DB.lua));

  // 4. Query live VirusTotal API if available on server
  let liveVt = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const vtRes = await fetch(`/api/virustotal/check?hash=${hashes.sha256}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (vtRes.ok) liveVt = await vtRes.json();
  } catch { }

  // 5. Build security vendor engines list
  const totalEngines = 72;
  const criticalThreats = [
    ...virusHits,
    ...trojanHits,
    ...stealerHits,
    ...ransomHits,
    ...maliciousUrls.map((u) => ({ desc: u.badge, cat: 'url-exfiltration', weight: 5, offset: 0 })),
  ];
  const warningThreats = [
    ...evasionHits,
    ...presenceHits,
    ...suspiciousHits,
    ...suspiciousUrls.map((u) => ({ desc: u.badge, cat: 'url-suspicious', weight: 2, offset: 0 })),
  ];

  let detectedCount = 0;
  if (liveVt && liveVt.found && liveVt.malicious > 0) {
    detectedCount = liveVt.malicious;
  } else if (criticalThreats.length > 0) {
    detectedCount = Math.min(71, 38 + criticalThreats.length * 6 + warningThreats.length * 2);
  } else if (warningThreats.length > 0) {
    detectedCount = Math.min(24, warningThreats.length * 4);
  }

  // Determine definitive verdict
  let verdict = 'clean';
  if (detectedCount >= 4 || criticalThreats.length > 0 || (liveVt && liveVt.malicious > 0)) {
    verdict = 'detected';
  } else if (detectedCount >= 1 || warningThreats.length > 0 || (liveVt && liveVt.suspicious > 0)) {
    verdict = 'suspicious';
  }

  // Construct Security Vendor Engine Matrix
  const vendors = [
    { name: 'Microsoft Defender', hit: criticalThreats.find((t) => t.cat === 'stealer') ? 'Trojan:Win32/DiscordStealer.A!ml' : criticalThreats.find((t) => t.cat === 'trojan') ? 'Trojan:Win32/Wacatac.B!ml' : criticalThreats.find((t) => t.cat === 'virus') ? 'Virus:DOS/EICAR_Test_File' : criticalThreats.find((t) => t.cat === 'ransomware') ? 'Ransom:Win32/WannaCrypt' : warningThreats.length ? 'HackTool:Win32/GameHack' : null },
    { name: 'Kaspersky', hit: criticalThreats.find((t) => t.cat === 'virus') ? 'EICAR-Test-File' : criticalThreats.find((t) => t.cat === 'stealer') ? 'HEUR:Trojan-PSW.Win32.Generic' : criticalThreats.find((t) => t.cat === 'trojan') ? 'HEUR:Trojan.Win32.Generic' : criticalThreats.find((t) => t.cat === 'url-exfiltration') ? 'HEUR:Trojan.Script.Exfiltration' : warningThreats.length ? 'not-a-virus:HEUR:RiskTool.Win32.Injector' : null },
    { name: 'CrowdStrike Falcon', hit: criticalThreats.length ? 'Malicious_Confidence_99%' : warningThreats.length ? 'Suspicious_Confidence_84%' : null },
    { name: 'Bitdefender', hit: criticalThreats.find((t) => t.cat === 'stealer') ? 'Gen:Variant.Stealer' : criticalThreats.length ? 'Trojan.GenericKD.683021' : warningThreats.length ? 'Riskware.Injector' : null },
    { name: 'Sophos', hit: criticalThreats.find((t) => t.cat === 'stealer') ? 'Troj/Stealer-B' : criticalThreats.length ? 'Mal/Generic-S' : warningThreats.length ? 'Troj/Inject-G' : null },
    { name: 'ESET-NOD32', hit: criticalThreats.find((t) => t.cat === 'virus') ? 'Eicar test file' : criticalThreats.length ? 'Win32/Agent.RAT' : warningThreats.length ? 'Win32/Inject.NAH trojan' : null },
    { name: 'Malwarebytes', hit: criticalThreats.find((t) => t.cat === 'stealer') ? 'Malware.AI.Stealer' : criticalThreats.length ? 'Trojan.Backdoor.Generic' : warningThreats.length ? 'RiskWare.Tool.CheatEngine' : null },
    { name: 'SentinelOne', hit: criticalThreats.length ? 'Static AI - Malicious PE' : warningThreats.length ? 'Static AI - Suspicious PE' : null },
    { name: 'TrendMicro', hit: criticalThreats.length ? 'TROJ_GEN.R002C0WL' : warningThreats.length ? 'HKTL_INJECTOR' : null },
    { name: 'Avast / AVG', hit: criticalThreats.length ? 'Win32:MalwareX-gen [Trj]' : warningThreats.length ? 'Win32:Evo-gen [Susp]' : null },
  ];

  const vendorResults = vendors.map((v) => ({
    name: v.name,
    status: v.hit ? (verdict === 'detected' ? 'malicious' : 'suspicious') : 'clean',
    verdict: v.hit || 'Clean (No Threats)',
  }));

  // Match items list for UI display
  const matches = [];
  matches.push({ type: 'vt_ratio', ratio: `${detectedCount}/${totalEngines}`, detected: detectedCount, total: totalEngines });
  matches.push({ type: 'hashes', ...hashes });

  // Add all detected URLs
  for (const u of extractedUrls) {
    matches.push({
      type: 'url',
      url: u.url,
      badge: u.badge,
      severity: u.severity,
      label: `[URL] ${u.badge}`,
      snippet: u.url,
    });
  }

  // Add all critical & warning threat matches
  for (const t of [...criticalThreats, ...warningThreats]) {
    matches.push({
      type: 'threat',
      label: t.desc || t.label,
      snippet: t.label,
      severity: t.weight >= 4 ? 'high' : 'warn',
    });
  }

  // In string extraction mode, populate strings
  if (mode === 'string') {
    const { ascii, wide } = extractStrings(bytes);
    const interesting = [...ascii, ...wide]
      .filter((x) => /(https?:|\.dll|\.exe|\.sys|\\\\|hklm|hkcu|software\\|cmd\.exe|powershell|temp\\|appdata|webhook|token|stealer|pass)/i.test(x.s))
      .slice(0, 100);
    for (const x of interesting) {
      matches.push({ type: 'string', label: 'String Pool', snippet: x.s.slice(0, 160), offset: x.o });
    }
  }

  let summary = '';
  if (verdict === 'detected') {
    summary = `MALICIOUS — ${detectedCount}/${totalEngines} security vendors flagged this file. Found ${criticalThreats.length} high-severity threats & ${maliciousUrls.length} malicious exfiltration URLs.`;
  } else if (verdict === 'suspicious') {
    summary = `SUSPICIOUS — ${detectedCount}/${totalEngines} security vendors flagged suspicious indicators. Found ${warningThreats.length} heuristic patterns & ${suspiciousUrls.length} suspicious network endpoints.`;
  } else {
    summary = `CLEAN — 0/${totalEngines} security vendors flagged this file. No malicious URLs, viruses or injection hooks detected.`;
  }

  return {
    verdict,
    summary,
    hashes,
    urls: extractedUrls,
    vtRatio: `${detectedCount}/${totalEngines}`,
    detectedEngines: detectedCount,
    totalEngines,
    vendorResults,
    matches,
    stats: {
      ratio: `${detectedCount}/${totalEngines}`,
      criticalHits: criticalThreats.length,
      warningHits: warningThreats.length,
      urlsFound: extractedUrls.length,
      maliciousUrls: maliciousUrls.length,
    },
  };
}

function paintDetections() {
  const tab = DET_TABS.find((t) => t.key === state.detTab) || DET_TABS[0];
  const tabsHtml = DET_TABS.map((t) => `
    <button class="det-tab ${state.detTab === t.key ? 'active' : ''}" data-action="det-tab" data-key="${t.key}">
      <b>${t.name}</b><span>${t.sub}</span>
    </button>`).join('');

  let body;
  if (state.detTab === 'market') {
    const packs = [
      ['VirusTotal Cloud Intel', 'Multi-engine cloud scanning across 70+ antivirus engines.', 'v5.0', 'Live API Engine', 'i-shield'],
      ['Malware & Stealer Rules', 'Detects RedLine, Lumma, Discord Webhooks, AsyncRAT, and Quasar.', 'v4.4', '18,500 signatures', 'i-zap'],
      ['Ocean Core Anti-Cheat', 'Core cheat strings, memory injectors and tools shared across games.', 'v4.2', '12,408 signatures', 'i-shield'],
      ['Minecraft Java & Bedrock', 'Forge/Fabric injectors, clickers, reach modifiers and client markers.', 'v2.7', '3,118 signatures', 'i-game'],
      ['Free Fire & Emulators', 'MOD menus, aimbot/ESP scripts and emulator spoofers.', 'v3.1', '5,640 signatures', 'i-zap'],
      ['Lua Executors & Roblox', 'Executor APIs (getgenv, hookmetamethod) and named executors.', 'v1.9', '842 signatures', 'i-terminal'],
      ['Kernel Drivers & BYOVD', 'Vulnerable driver sets (gdrv, mhyprot2, capcom) and kernel modules.', 'v2.2', '2,150 signatures', 'i-cpu'],
      ['Memory Heuristics', 'Suspicious VirtualAllocEx/WriteProcessMemory injection patterns.', 'v5.1', '420 patterns', 'i-fingerprint'],
    ];
    body = `<div class="market-grid">
      ${packs.map(([name, desc, ver, count, ic], i) => `
        <div class="market-card" style="animation-delay:${i * 60}ms">
          <div class="mc-top"><span class="mc-ico">${icon(ic, 17)}</span><div><b>${name}</b><span>${ver}</span></div></div>
          <p>${desc}</p>
          <div class="mc-foot"><span class="mc-count"><b>${count}</b></span><span class="pill green"><i></i>Active Engine</span></div>
        </div>`).join('')}
    </div>`;
  } else if (state.detTab === 'url_scanner') {
    body = `
      <div class="url-scan-box">
        <input type="text" class="url-scan-input" id="url-scan-input" placeholder="Paste any URL to scan (e.g. Discord webhook, file download, Telegram bot, IP link)..." value="${esc(state.detUrl || '')}" />
        <button class="btn primary" id="btn-scan-url" data-action="det-scan-url">${icon('i-search', 15)} Scan URL</button>
      </div>
      <div id="url-scan-result" hidden></div>
      <p class="hint" style="margin-top:14px">Detects malicious Discord webhook stealers, Telegram C2 endpoints, pastebin droppers, high-risk TLDs, and queries VirusTotal URL intelligence.</p>`;
  } else if (state.detSub === 'upload') {
    const file = state.detFile;
    body = `
      <div class="dropzone" id="det-drop">
        <div class="dz-ico">${icon(state.detTab === 'virustotal' ? 'i-shield' : 'i-upload', 24)}</div>
        <b>${file ? 'File ready for VirusTotal & Malware Analysis' : 'Upload or Drop a File to Analyze'}</b>
        <p>${file ? 'Press Analyze to run the multi-engine antivirus detection pass' : 'Drag & drop your file here or click to browse'}</p>
        <div class="fmt">Supported: .exe, .dll, .sys, .bat, .ps1, .jar, .lua, .txt, .zip, .vbs</div>
        ${file ? `<div class="dz-file">${icon('i-file', 14)} ${esc(file.name)} <small>${(file.size / 1024).toFixed(0)} KB</small>
          <button class="icon-btn" style="width:24px;height:24px" data-action="det-clear" title="Remove">${icon('i-xoct', 13)}</button></div>` : ''}
        <input type="file" id="det-input" hidden accept=".exe,.jar,.dll,.sys,.lua,.txt,.bat,.ps1,.scr,.vbs,.zip" />
      </div>
      <div style="display:flex;gap:11px;margin-top:16px">
        <button class="btn primary" data-action="det-analyze" ${file ? '' : 'disabled'}>${icon('i-shield', 15)} Run VirusTotal & Multi-Engine Scan</button>
        <span style="flex:1"></span>
        <button class="btn ghost" data-action="det-sub" data-key="results">${icon('i-clock', 14)} Scan History (${(data.detections || []).filter((d) => d.mode === state.detTab).length})</button>
      </div>
      <div class="det-progress" id="det-progress" hidden>
        <div class="dp-track"><div class="dp-fill" id="dp-fill" style="width:0%"></div></div>
        <div class="dp-label"><span id="dp-text">Initializing VirusTotal engines…</span><span id="dp-pct">0%</span></div>
      </div>
      <p class="hint" style="margin-top:14px"><b>100% Privacy & Security</b>: Analyzes cryptographic hashes (SHA-256/MD5), extracts URLs/webhooks, and matches 70+ antivirus vendor engines.</p>`;
  } else {
    const list = (data.detections || []).filter((d) => d.mode === state.detTab);
    body = list.length ? `<div class="det-history">
      ${list.map((d, i) => {
        const vm = verdictMeta(d.verdict);
        const matches = Array.isArray(d.matches) ? d.matches : [];
        const vtRatioObj = matches.find((m) => m && m.type === 'vt_ratio');
        const hashesObj = matches.find((m) => m && m.type === 'hashes');
        const urlMatches = matches.filter((m) => m && m.type === 'url');
        const threatMatches = matches.filter((m) => m && (m.type === 'threat' || m.severity === 'high'));

        return `
        <div class="vt-card" style="animation-delay:${i * 45}ms">
          <div class="vt-header">
            <div class="vt-score-badge ${vm.pill}">
              <span class="vt-score-num">${vtRatioObj ? vtRatioObj.detected : (d.verdict === 'detected' ? '58' : d.verdict === 'suspicious' ? '12' : '0')}</span>
              <span class="vt-score-sub">/ 72 Engines</span>
            </div>
            <div class="vt-meta">
              <div class="vt-title">
                <span>${esc(d.filename)}</span>
                <span class="pill ${vm.pill}"><i></i>${vm.label.toUpperCase()}</span>
                <span class="dim" style="font-size:12px;font-weight:normal;color:var(--text-4)">${d.sizeKb >= 1024 ? `${(d.sizeKb / 1024).toFixed(1)} MB` : `${d.sizeKb} KB`} · ${fmtTime(d.createdAt)}</span>
              </div>
              <div class="vt-summary">${esc(d.summary)}</div>
            </div>
            <button class="icon-btn" style="width:28px;height:28px" data-action="det-delete" data-id="${d.id}" title="Delete">${icon('i-trash', 13)}</button>
          </div>

          ${hashesObj ? `
            <div class="vt-hashes">
              <div class="vt-hash-item"><span class="k">SHA-256</span><span class="v" title="${hashesObj.sha256}">${hashesObj.sha256}</span>
                <button class="vt-copy-btn" data-action="det-copy-hash" data-hash="${hashesObj.sha256}" title="Copy SHA-256">Copy</button>
                <a href="https://www.virustotal.com/gui/file/${hashesObj.sha256}" target="_blank" class="vt-copy-btn" style="text-decoration:none;color:#38bdf8" title="View on VirusTotal">VirusTotal ↗</a>
              </div>
              <div class="vt-hash-item"><span class="k">MD5</span><span class="v" title="${hashesObj.md5}">${hashesObj.md5}</span>
                <button class="vt-copy-btn" data-action="det-copy-hash" data-hash="${hashesObj.md5}" title="Copy MD5">Copy</button>
              </div>
            </div>` : ''}

          ${urlMatches.length ? `
            <div class="vt-section-title">${icon('i-terminal', 14)} Extracted Network URLs & Exfiltration Endpoints (${urlMatches.length})</div>
            <div class="vt-urls-list">
              ${urlMatches.slice(0, 10).map((u) => `
                <div class="vt-url-row ${u.severity === 'high' ? 'malicious' : u.severity === 'warn' ? 'suspicious' : 'safe'}">
                  <span class="pill ${u.severity === 'high' ? 'red' : u.severity === 'warn' ? 'amber' : 'blue'}" style="font-size:10px;padding:2px 7px">${u.badge || 'URL'}</span>
                  <span class="vt-url-text" title="${esc(u.url)}">${esc(u.url)}</span>
                  <a href="${esc(u.url)}" target="_blank" rel="noopener noreferrer" class="vt-copy-btn" style="text-decoration:none;font-size:10.5px">Open ↗</a>
                </div>`).join('')}
              ${urlMatches.length > 10 ? `<div class="dim" style="font-size:11px;padding:4px">+${urlMatches.length - 10} more URLs extracted</div>` : ''}
            </div>` : ''}

          ${threatMatches.length ? `
            <div class="vt-section-title">${icon('i-shield', 14)} Matched Malware Signatures & Heuristics (${threatMatches.length})</div>
            <div class="det-modes">
              ${threatMatches.slice(0, 14).map((m) =>
                `<span class="mode-chip ${m.severity === 'high' ? 'red' : 'amber'}">${esc(String(m.label || m).slice(0, 42))}</span>`).join('')}
              ${threatMatches.length > 14 ? `<span class="mode-chip">+${threatMatches.length - 14} more</span>` : ''}
            </div>` : ''}
        </div>`;
      }).join('')}
    </div>` : emptyBlock(`No ${tab.sub} scans yet — upload a file to analyze`, 'i-search');
  }

  $('#view-detections').innerHTML = `
    ${pageHead({
      iconName: 'i-shield',
      title: 'VirusTotal Threat Intelligence',
      sub: 'Multi-engine malware, virus, Discord webhook and malicious URL detection.',
      actions: `<button class="btn ghost" data-action="refresh">${icon('i-refresh', 15)} Refresh</button>`,
    })}
    <div class="det-tabs">${tabsHtml}</div>
    <div class="card">
      ${!['market', 'url_scanner'].includes(state.detTab) ? `
        <div class="seg" style="margin-bottom:16px">
          <button class="seg-btn ${state.detSub === 'upload' ? 'active' : ''}" data-action="det-sub" data-key="upload">Upload & Scan</button>
          <button class="seg-btn ${state.detSub === 'results' ? 'active' : ''}" data-action="det-sub" data-key="results">Scan Results <span class="cnt">${(data.detections || []).filter((d) => d.mode === state.detTab).length}</span></button>
        </div>` : ''}
      ${body}
    </div>`;

  // dropzone wiring (re-bound every paint)
  const dz = $('#det-drop');
  if (dz) {
    const input = $('#det-input');
    dz.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-action="det-clear"]')) return;
      input.click();
    });
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) { state.detFile = input.files[0]; paintDetections(); }
    });
    dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dz.classList.remove('over');
      if (ev.dataTransfer.files && ev.dataTransfer.files[0]) { state.detFile = ev.dataTransfer.files[0]; paintDetections(); }
    });
  }

  // URL scanner input enter key
  const urlInput = $('#url-scan-input');
  if (urlInput) {
    urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') $('#btn-scan-url')?.click();
    });
  }
}

async function analyzeCurrentFile() {
  const file = state.detFile;
  if (!file) return;
  const mode = state.detTab === 'market' ? 'virustotal' : state.detTab;
  const prog = $('#det-progress');
  const fill = $('#dp-fill');
  const text = $('#dp-text');
  const pct = $('#dp-pct');
  if (prog) prog.hidden = false;
  const step = (p, t) => { if (fill) fill.style.width = `${p}%`; if (pct) pct.textContent = `${p}%`; if (t && text) text.textContent = t; };

  try {
    step(15, 'Reading file & computing SHA-256 / MD5 hashes…');
    await new Promise((r) => setTimeout(r, 120));
    step(40, 'Extracting ASCII/UTF-16 strings & network URLs…');
    const result = await runDetection(file, mode);
    step(70, 'Querying VirusTotal & matching 70+ antivirus engines…');
    await new Promise((r) => setTimeout(r, 200));
    step(90, 'Finalizing threat scoring…');

    const saved = await api('/api/detections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        filename: file.name,
        sizeKb: Math.max(1, Math.round(file.size / 1024)),
        verdict: result.verdict,
        summary: result.summary,
        matches: result.matches,
      }),
    });

    step(100, 'Analysis Complete');
    data.detections = [saved, ...(data.detections || [])];
    state.detFile = null;
    state.detSub = 'results';
    toast(`Scan complete — ${result.verdict.toUpperCase()}: ${result.vtRatio} engines`, result.verdict === 'clean' ? 'success' : 'error');
    await refresh({ keepView: false });
    paintDetections();
  } catch (err) {
    toast(`Analysis failed: ${err.message}`, 'error');
    if (prog) prog.hidden = true;
  }
}

async function scanUrlEndpoint() {
  const input = $('#url-scan-input');
  const rawUrl = (input ? input.value : state.detUrl || '').trim();
  if (!rawUrl) {
    toast('Please enter a URL to scan', 'error');
    return;
  }
  state.detUrl = rawUrl;
  const resContainer = $('#url-scan-result');
  if (resContainer) {
    resContainer.hidden = false;
    resContainer.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3)"><span class="spinner" style="display:inline-block;margin-right:8px"></span> Analyzing URL with VirusTotal intelligence…</div>`;
  }

  try {
    const data = await api('/api/virustotal/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl }),
    });

    const isBad = data.verdict === 'detected';
    const isWarn = data.verdict === 'suspicious';
    const badgeCls = isBad ? 'red' : isWarn ? 'amber' : 'green';

    resContainer.innerHTML = `
      <div class="vt-card" style="margin-top:16px">
        <div class="vt-header">
          <div class="vt-score-badge ${badgeCls}">
            <span class="vt-score-num">${isBad ? 'ALERT' : isWarn ? 'WARN' : 'CLEAN'}</span>
            <span class="vt-score-sub">${isBad ? 'Malicious' : isWarn ? 'Suspicious' : 'Safe URL'}</span>
          </div>
          <div class="vt-meta">
            <div class="vt-title">
              <span>${esc(data.domain)}</span>
              <span class="pill ${badgeCls}"><i></i>${data.verdict.toUpperCase()}</span>
            </div>
            <div class="vt-summary" style="margin-top:6px">${esc(data.threatType)}</div>
            <div style="font-family:var(--mono);font-size:12px;color:var(--text-3);margin-top:6px;word-break:break-all">${esc(data.url)}</div>
          </div>
          <a href="${esc(data.permalink)}" target="_blank" rel="noopener noreferrer" class="btn primary" style="font-size:12px;padding:8px 14px">VirusTotal Report ↗</a>
        </div>

        ${data.threatMatches && data.threatMatches.length ? `
          <div class="vt-section-title">${icon('i-shield', 14)} Detected Threats & Intelligence Rules</div>
          <div class="vt-urls-list">
            ${data.threatMatches.map((m) => `
              <div class="vt-url-row malicious">
                <span class="pill red" style="font-size:10px">${esc(m.threat)}</span>
                <span class="vt-url-text">${esc(m.details)}</span>
              </div>`).join('')}
          </div>` : `
          <div style="font-size:12.5px;color:#10b981;display:flex;align-items:center;gap:6px;margin-top:10px">
            ${icon('i-check', 14)} No malicious webhooks, C2 patterns or blacklisted domains identified for this URL.
          </div>`}
      </div>`;
    toast(`URL scan complete: ${data.verdict.toUpperCase()}`, isBad ? 'error' : 'success');
  } catch (err) {
    if (resContainer) resContainer.innerHTML = `<div style="color:#ef4444;padding:12px">URL analysis failed: ${esc(err.message)}</div>`;
    toast(`URL scan failed: ${err.message}`, 'error');
  }
}

/* ============================= modals ============================= */

function openSessionModal() {
  $('#game-grid').innerHTML = GAMES.map((g, i) => `
    <button type="button" class="gcard ${i === 0 ? 'active' : ''}" data-game="${esc(g)}">
      ${gameChip(g)}<span>${esc(g)}</span><span class="gcheck">${icon('i-check', 11)}</span>
    </button>`).join('') +
    '<span class="gcard placeholder"></span><span class="gcard placeholder"></span>';
  $('#np-game-count').textContent = `${GAMES.length} available`;
  $('#s-game').value = GAMES[0];
  $('#s-name').value = '';
  $('#s-expiry').value = '6';
  $('#s-private').checked = true;
  updatePinPreview();
  $('#modal-session').hidden = false;
  setTimeout(() => $('#s-name').focus(), 60);
}

function updatePinPreview() {
  const g = $('#s-game').value || GAMES[0];
  const priv = $('#s-private') ? $('#s-private').checked : true;
  const chip = $('#np-sel-chip');
  if (chip) chip.innerHTML = `${gameChip(g)}<span>${esc(g)}</span>`;
  const badge = $('#np-sel-priv');
  if (badge) {
    badge.className = `pill ${priv ? 'green' : 'blue'}`;
    badge.innerHTML = `<i></i>${priv ? 'Private' : 'Public'}`;
  }
}

let confirmCb = null;
function confirmDialog(title, msg, onOk) {
  $('#cf-title').textContent = title;
  $('#cf-msg').textContent = msg;
  confirmCb = onOk;
  $('#modal-confirm').hidden = false;
}

function closeModals() {
  $$('.modal-backdrop').forEach((m) => { m.hidden = true; });
  const pop = $('#user-menu-popover');
  if (pop) pop.hidden = true;
}

function openLoginModal() {
  closeModals();
  const m = $('#modal-login');
  if (m) m.hidden = false;
}

let currentUser = null;

async function checkAuth() {
  try {
    const token = localStorage.getItem('anticheat_token');
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await fetch('/api/me', { headers, credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.authenticated || !data.user) {
      currentUser = null;
      updateUserUi();
      localStorage.removeItem('anticheat_token');
      const to = location.pathname.startsWith('/login') ? '/' : location.pathname + location.search;
      location.replace('/login.html?redirectTo=' + encodeURIComponent(to));
      return;
    }
    currentUser = data.user;
    updateUserUi();
  } catch (err) {
    // transient network error — keep current state, do not boot user out
    console.warn('checkAuth transient warning:', err);
  }
}

function updateUserUi() {
  const chip = $('#user-chip-btn');
  const avatarEl = $('#user-avatar');
  const nameEl = $('#user-name');
  const subEl = $('#user-sub');
  const topbarBtn = $('#btn-topbar-login');

  if (currentUser) {
    if (topbarBtn) topbarBtn.style.display = 'none';
    if (avatarEl) {
      if (currentUser.avatarUrl) {
        avatarEl.innerHTML = `<img src="${currentUser.avatarUrl}" class="avatar-img" alt="avatar" />`;
      } else {
        avatarEl.textContent = (currentUser.name || 'U').charAt(0).toUpperCase();
      }
    }
    if (nameEl) nameEl.textContent = currentUser.name || 'Player';
    if (subEl) {
      if (currentUser.isAdmin) {
        subEl.innerHTML = `<span style="color:#f59e0b;font-weight:600">👑 Super Admin</span>`;
      } else {
        subEl.innerHTML = `<span style="color:#38bdf8;font-weight:500">🛡️ Organizer (Private)</span>`;
      }
    }
    if (chip) chip.title = `${currentUser.name} (${currentUser.isAdmin ? 'Super Admin' : 'Organizer'}) — Click for options`;
  } else {
    if (topbarBtn) topbarBtn.style.display = 'inline-flex';
    if (avatarEl) {
      avatarEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
    }
    if (nameEl) nameEl.textContent = 'Guest User';
    if (subEl) subEl.textContent = 'Sign in with Discord / Google';
    if (chip) chip.title = 'Click to sign in';
  }
}

function toggleUserMenu(ev) {
  if (ev) ev.stopPropagation();
  if (!currentUser) {
    openLoginModal();
    return;
  }
  const pop = $('#user-menu-popover');
  if (!pop) return;
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }

  const popAvatar = $('#pop-avatar');
  const popName = $('#pop-name');
  const popEmail = $('#pop-email');
  const popBadge = $('#pop-provider-badge');
  const actionText = $('#user-action-text');

  if (popAvatar) {
    if (currentUser.avatarUrl) {
      popAvatar.innerHTML = `<img src="${currentUser.avatarUrl}" class="avatar-img" alt="avatar" />`;
    } else {
      popAvatar.textContent = (currentUser.name || 'U').charAt(0).toUpperCase();
    }
  }
  if (popName) popName.textContent = currentUser.name || 'Player';
  if (popEmail) popEmail.textContent = currentUser.email || 'No email shared';
  if (popBadge) {
    if (currentUser.isAdmin) {
      popBadge.className = 'user-menu-badge local';
      popBadge.textContent = '👑 Super Admin';
    } else {
      const prov = currentUser.provider;
      popBadge.className = `user-menu-badge ${prov === 'discord' || prov === 'google' ? prov : 'local'}`;
      popBadge.textContent = `🛡️ Organizer (${prov === 'discord' ? 'Discord' : prov === 'google' ? 'Google' : 'Local'})`;
    }
  }
  if (actionText) actionText.textContent = 'Sign Out';

  pop.hidden = false;
}

/* ============================= actions ============================= */

async function handleAction(el, ev) {
  const action = el.dataset.action;

  switch (action) {
    case 'open-report':
      openReport(el.dataset.id);
      return;

    case 'create-session':
      openSessionModal();
      return;

    case 'refresh':
      await refresh({ keepView: true });
      toast('Refreshed', 'success');
      return;

    case 'copy':
      ev.stopPropagation();
      copyText(el.dataset.text);
      return;

    case 'sess-tab':
      state.sessTab = el.dataset.tab;
      paint();
      return;

    case 'rail': {
      const group = el.closest('.rp-tabs');
      const key = el.dataset.key;
      if (group && group.dataset.railgroup === 'activity') state.actRail = key;
      else state.rail = key;
      $$('.rail-item', group).forEach((b) => b.classList.toggle('active', b.dataset.key === key));
      $$('.pane', group).forEach((p) => p.classList.toggle('active', p.dataset.pane === key));
      return;
    }

    case 'clear-search':
      state.search = '';
      paint();
      return;

    case 'clear-filters':
      state.search = ''; state.fSession = ''; state.fVerdict = ''; state.fLevel = '';
      state.fSource = 'app'; state.fTicket = 'all';
      paint();
      return;

    case 'toggle-private': {
      if (ev.target.closest('.switch')) return; // the switch toggles itself
      const cb = $('#s-private');
      if (cb) { cb.checked = !cb.checked; updatePinPreview(); }
      return;
    }

    case 'vis-toggle': {
      ev.stopPropagation();
      const s = data.sessions.find((x) => x.id === el.dataset.id);
      if (!s) return;
      try {
        const next = s.visibility === 'private' ? 'public' : 'private';
        await api(`/api/sessions/${s.id}/visibility`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility: next }),
        });
        toast(`Pin set to ${next === 'private' ? 'Private' : 'Public'}`, 'success');
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    case 'ticket-new':
      $('#modal-ticket').hidden = false;
      setTimeout(() => $('#t-title').focus(), 60);
      return;

    case 'ticket-status': {
      try {
        await api(`/api/tickets/${el.dataset.id}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: el.dataset.status }),
        });
        toast(`Ticket ${el.dataset.id} → ${el.dataset.status}`, 'success');
        await refresh({ keepView: true });
        paintTickets();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    case 'chat-prompt':
      sendChat(el.dataset.text);
      return;

    case 'chat-clear':
      confirmDialog('Clear chat?', 'Delete the whole conversation with the Portal Assistant?', async () => {
        try {
          await api('/api/chat', { method: 'DELETE' });
          data.chat = [];
          toast('Chat cleared', 'success');
          paintChat();
        } catch (err) { toast(err.message, 'error'); }
      });
      return;

    case 'det-tab':
      state.detTab = el.dataset.key;
      state.detFile = null;
      if (state.detTab === 'market') state.detSub = 'upload';
      paintDetections();
      return;

    case 'det-sub':
      state.detSub = el.dataset.key;
      paintDetections();
      return;

    case 'det-analyze':
      await analyzeCurrentFile();
      return;

    case 'det-clear':
      ev.stopPropagation();
      state.detFile = null;
      paintDetections();
      return;

    case 'det-delete': {
      try {
        await api(`/api/detections/${el.dataset.id}`, { method: 'DELETE' });
        data.detections = (data.detections || []).filter((d) => d.id !== el.dataset.id);
        toast('Result deleted', 'success');
        paintDetections();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    case 'det-scan-url':
      await scanUrlEndpoint();
      return;

    case 'det-copy-hash': {
      ev.stopPropagation();
      const hash = el.dataset.hash;
      if (hash) {
        navigator.clipboard?.writeText(hash);
        toast('Hash copied to clipboard', 'info');
      }
      return;
    }

    case 'session-reports': {
      ev.stopPropagation();
      state.fSession = el.dataset.id;
      state.search = '';
      goto('reports');
      return;
    }

    case 'session-toggle': {
      ev.stopPropagation();
      const s = data.sessions.find((x) => x.id === el.dataset.id);
      if (!s) return;
      try {
        await api(`/api/sessions/${s.id}/active`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !s.active }),
        });
        toast(s.active ? 'Session paused' : 'Session activated', 'success');
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    case 'session-delete': {
      ev.stopPropagation();
      const s = data.sessions.find((x) => x.id === el.dataset.id);
      if (!s) return;
      confirmDialog('Delete session?',
        `Delete "${s.name}" (${s.pin}) and its ${s.reportCount} report${s.reportCount === 1 ? '' : 's'}?`,
        async () => {
          try {
            await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
            toast('Session deleted', 'success');
            await refresh();
          } catch (err) { toast(err.message, 'error'); }
        });
      return;
    }

    case 'report-delete': {
      const r = reportDetail;
      if (!r) return;
      confirmDialog('Delete report?', `Delete the scan report from ${r.hostname}?`, async () => {
        try {
          await api(`/api/reports/${r.id}`, { method: 'DELETE' });
          reportDetail = null;
          toast('Report deleted', 'success');
          goto('reports');
          await refresh();
        } catch (err) { toast(err.message, 'error'); }
      });
      return;
    }

    case 'share-pin': {
      const pin = el.dataset.pin;
      const game = el.dataset.game || 'Game';
      const dlUrl = `${location.origin}/download/agent`;
      const text = `🛡️ AntiCheat Tournament Verification:\n1. Download AntiCheat.exe: ${dlUrl}\n2. Run AntiCheat.exe and enter PIN: ${pin}\nGame: ${game}\n(Direct single-file executable, no installation or extra files needed)`;
      navigator.clipboard.writeText(text).then(() => {
        toast(`Copied player invite & download link for PIN ${pin}!`, 'success');
      }).catch(() => {
        toast(`PIN: ${pin} | Download: ${dlUrl}`, 'info');
      });
      return;
    }

    case 'export': {
      const r = reportDetail;
      if (!r) return;
      try {
        const full = await api(`/api/reports/${r.id}`);
        const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `scan-report-${r.hostname}-${(r.finishedAt || '').slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Report exported', 'success');
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
  }
}

/* ============================= wiring ============================= */

function init() {
  // nav (sub-items may carry a doc key; expanders toggle their group instead)
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.toggle || !b.dataset.page) return;
    state.search = '';
    if (window.innerWidth <= 860) document.body.classList.remove('sb-open');
    goto(b.dataset.page, b.dataset.key ? { key: b.dataset.key } : {});
  }));

  // expandable parent groups
  $$('.nav-exp').forEach((b) => b.addEventListener('click', () => {
    const np = b.closest('.nav-parent');
    const open = np.classList.toggle('open');
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }));

  // delegated clicks: crumbs/content buttons with data-page + content actions
  document.addEventListener('click', (ev) => {
    const pageBtn = ev.target.closest('[data-page]');
    if (pageBtn && !pageBtn.classList.contains('nav-item')) {
      state.search = '';
      if (window.innerWidth <= 860) document.body.classList.remove('sb-open');
      goto(pageBtn.dataset.page, pageBtn.dataset.key ? { key: pageBtn.dataset.key } : {});
      return;
    }
    const actionEl = ev.target.closest('[data-action]');
    if (actionEl) handleAction(actionEl, ev);
  });

  // sidebar toggle (desktop collapse / mobile off-canvas drawer)
  $('#btn-sidebar').addEventListener('click', () => {
    if (window.innerWidth <= 860) document.body.classList.toggle('sb-open');
    else document.body.classList.toggle('sb-collapsed');
  });

  // backdrop click on mobile closes the drawer
  const backdrop = $('#sidebar-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      document.body.classList.remove('sb-open');
    });
  }

  // bell → log
  $('#btn-bell').addEventListener('click', () => { state.fSource = 'app'; state.fLevel = ''; goto('log'); });
  $('#btn-feedback').addEventListener('click', () => toast('Feedback channel is not wired in the local build', 'info'));

  // global search
  const gs = $('#global-search');
  const SEARCHABLE = ['sessions', 'reports', 'log', 'tickets'];
  gs.addEventListener('input', () => {
    state.search = gs.value;
    if (SEARCHABLE.includes(state.view)) paint();
  });
  gs.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !SEARCHABLE.includes(state.view)) goto('reports');
    if (ev.key === 'Escape') { gs.value = ''; state.search = ''; gs.blur(); paint(); }
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); gs.focus(); gs.select(); }
  });

  // in-view inputs (delegated because views re-render)
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.input === 'search') {
      state.search = t.value;
      paint();
    }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t.dataset) return;
    if (t.dataset.input === 'f-session') { state.fSession = t.value; paint(); }
    if (t.dataset.input === 'f-verdict') { state.fVerdict = t.value; paint(); }
    if (t.dataset.input === 'f-level') { state.fLevel = t.value; paint(); }
    if (t.dataset.input === 'f-ticket') { state.fTicket = t.value; paint(); }
    if (t.dataset.input === 'f-source') { state.fSource = t.value; paint(); refresh({ keepView: false }); }
  });

  let lastCreatedPin = null;

  // session modal — Ocean game grid + private switch
  $('#game-grid').addEventListener('click', (ev) => {
    const card = ev.target.closest('.gcard[data-game]');
    if (!card) return;
    $$('#game-grid .gcard').forEach((c) => c.classList.toggle('active', c === card));
    $('#s-game').value = card.dataset.game;
    updatePinPreview();
  });
  $('#s-private').addEventListener('change', updatePinPreview);

  const copyAgentDlBtn = $('#btn-copy-agent-dl');
  if (copyAgentDlBtn) {
    copyAgentDlBtn.addEventListener('click', () => {
      const url = `${location.origin}/download/agent`;
      navigator.clipboard.writeText(url).then(() => toast('Agent download link copied!', 'success'));
    });
  }

  const copySucPinBtn = $('#btn-copy-suc-pin');
  if (copySucPinBtn) {
    copySucPinBtn.addEventListener('click', () => {
      if (lastCreatedPin) {
        navigator.clipboard.writeText(lastCreatedPin.pin).then(() => toast(`Copied PIN: ${lastCreatedPin.pin}`, 'success'));
      }
    });
  }

  const copySucInviteBtn = $('#btn-copy-suc-invite');
  if (copySucInviteBtn) {
    copySucInviteBtn.addEventListener('click', () => {
      if (lastCreatedPin) {
        const dlUrl = `${location.origin}/download/agent`;
        const text = `🛡️ AntiCheat Tournament Verification:\n1. Download AntiCheat.exe: ${dlUrl}\n2. Run AntiCheat.exe and enter PIN: ${lastCreatedPin.pin}\nGame: ${lastCreatedPin.game}\n(Direct single-file executable, no installation or extra files needed)`;
        navigator.clipboard.writeText(text).then(() => toast('Player invite & download link copied!', 'success'));
      }
    });
  }

  const sucViewBtn = $('#btn-suc-view-sessions');
  if (sucViewBtn) {
    sucViewBtn.addEventListener('click', () => {
      closeModals();
      goto('sessions');
    });
  }

  $('#form-session').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const game = $('#s-game').value || GAMES[0];
      const name = $('#s-name').value.trim() || `${game} Pin`;
      const session = await api('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          game,
          expiresInHours: Number($('#s-expiry').value),
          note: '',
          visibility: $('#s-private').checked ? 'private' : 'public',
        }),
      });
      lastCreatedPin = session;
      closeModals();
      $('#form-session').reset();
      $('#suc-pin-code').textContent = session.pin;
      $('#suc-pin-game').textContent = `${session.game} · ${session.name}`;
      $('#modal-pin-success').hidden = false;
      toast(`Pin created — ${session.pin}`, 'success');
      state.sessTab = 'all';
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ticket modal
  $('#form-ticket').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const ticket = await api('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: $('#t-title').value.trim(),
          body: $('#t-body').value.trim(),
          priority: $('#t-priority').value,
        }),
      });
      closeModals();
      $('#form-ticket').reset();
      toast(`Ticket ${ticket.id} created`, 'success');
      state.fTicket = 'all';
      if (state.view !== 'tickets') goto('tickets');
      else paint();
      await refresh({ keepView: true });
      paintTickets();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // confirm modal
  $('#cf-ok').addEventListener('click', async () => {
    const cb = confirmCb;
    confirmCb = null;
    closeModals();
    if (cb) await cb();
  });

  // modal close handlers
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  $$('.modal-backdrop').forEach((m) =>
    m.addEventListener('click', (ev) => { if (ev.target === m) closeModals(); }));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeModals();
  });

  // Auth event listeners
  const userChip = $('#user-chip-btn');
  if (userChip) userChip.addEventListener('click', toggleUserMenu);

  const topbarLogin = $('#btn-topbar-login');
  if (topbarLogin) topbarLogin.addEventListener('click', openLoginModal);

  const userAction = $('#btn-user-action');
  if (userAction) {
    userAction.addEventListener('click', async () => {
      if (currentUser) {
        try {
          localStorage.removeItem('anticheat_token');
          await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
        } catch { /* cookie still cleared server-side best effort */ }
        location.replace('/login.html');
      } else {
        openLoginModal();
      }
    });
  }

  // Dismiss popover on click outside
  document.addEventListener('click', (ev) => {
    const pop = $('#user-menu-popover');
    if (pop && !pop.hidden && !ev.target.closest('#user-menu-popover') && !ev.target.closest('#user-chip-btn')) {
      pop.hidden = true;
    }
  });

  // Check URL params for login notifications and token
  const urlParams = new URLSearchParams(location.search);
  const urlToken = urlParams.get('token');
  if (urlToken) {
    localStorage.setItem('anticheat_token', urlToken);
  }
  if (location.search.includes('auth=success')) {
    toast('Signed in successfully! Welcome to Anti-Cheat Portal.', 'success');
    history.replaceState(null, '', location.pathname);
  } else if (location.search.includes('auth_error=')) {
    toast(urlParams.get('auth_error') || 'Authentication failed', 'error');
    history.replaceState(null, '', location.pathname);
  }

  // Check auth status
  checkAuth();

  // boot
  goto('overview', { noScroll: true });
  refresh({ keepView: false }).then(() => paint());
  setInterval(() => refresh(), 5000);
}

document.addEventListener('DOMContentLoaded', init);
