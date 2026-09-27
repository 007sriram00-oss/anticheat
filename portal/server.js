'use strict';

/**
 * Anti-cheat telemetry portal — localhost dashboard + agent API.
 * Stack: Node.js + Express + node:sqlite (zero native dependencies).
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const store = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

/* Optional admin password for public deployments.
   Set ADMIN_PASSWORD=... in the environment and every route (dashboard + API)
   requires HTTP Basic auth. The agent API (/api/agent/*) stays open — it is
   already gated by session PINs, and the agent cannot answer a browser prompt.
   Leave ADMIN_PASSWORD unset for local use (no login). */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (ADMIN_PASSWORD) {
  const { timingSafeEqual } = require('crypto');
  const matches = (given) => {
    const a = Buffer.from(String(given), 'utf8');
    const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/agent/')) return next();
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0 && matches(decoded.slice(colon + 1))) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Anti-Cheat Portal", charset="UTF-8"');
    res.status(401).send('Admin password required');
  });
}

/* Request logger for the system log.
   Only non-GET requests and failed responses are recorded — routine dashboard
   polling (GET /api/stats every 5s) would otherwise drown out real events. */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.on('finish', () => {
      if (req.path === '/api/agent/validate' || req.path === '/api/agent/report') return; // logged separately
      const interesting = req.method !== 'GET' || res.statusCode >= 400;
      if (!interesting) return;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      store.logEvent(level, 'http', `${req.method} ${req.path} → ${res.statusCode}`, {
        ip: req.ip,
      });
    });
  }
  next();
});

/* =========================================================== agent API ==== */

// Agent checks a session PIN before scanning.
app.post('/api/agent/validate', (req, res) => {
  const { pin } = req.body || {};
  const session = store.getSessionByPin(pin);
  if (!session) {
    store.logEvent('warn', 'agent.rejected', `Rejected unknown session PIN`, { hint: String(pin || '').slice(0, 4) + '****' });
    return res.status(404).json({ ok: false, error: 'Invalid session PIN' });
  }
  if (!session.active) {
    store.logEvent('warn', 'agent.rejected', `PIN used for paused session ${session.name}`, { sessionId: session.id });
    return res.status(403).json({ ok: false, error: 'This session is paused' });
  }
  store.logEvent('info', 'agent.validate', `Agent validated for "${session.name}" (${session.game})`, {
    sessionId: session.id,
  });
  return res.json({
    ok: true,
    session: {
      id: session.id,
      name: session.name,
      game: session.game,
      expiresAt: session.expiresAt,
    },
  });
});

// Agent uploads a finished scan report.
app.post('/api/agent/report', (req, res) => {
  try {
    const body = req.body || {};
    const session = store.getSessionByPin(body.pin);
    if (!session) {
      store.logEvent('error', 'report.rejected', `Report rejected: unknown PIN`, {});
      return res.status(404).json({ ok: false, error: 'Invalid session PIN' });
    }
    if (!session.active) {
      return res.status(403).json({ ok: false, error: 'This session is paused' });
    }
    const saved = store.saveReport(session, body);
    return res.json({ ok: true, ...saved });
  } catch (err) {
    console.error('report save failed:', err);
    store.logEvent('error', 'report.failed', `Failed to store report: ${err.message}`, {});
    return res.status(500).json({ ok: false, error: 'Storage failure' });
  }
});

app.get('/api/agent/health', (_req, res) => {
  res.json({ ok: true, service: 'anticheat-portal', time: store.nowIso() });
});

/* ========================================================= dashboard API === */

app.get('/api/stats', (_req, res) => res.json(store.getStats()));

app.get('/api/sessions', (_req, res) => res.json(store.getSessions()));

app.post('/api/sessions', (req, res) => {
  const { name, game, expiresInHours, note, visibility } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Session name is required' });
  if (!game || !game.trim()) return res.status(400).json({ error: 'Game is required' });
  const session = store.createSession({
    name: name.trim().slice(0, 80),
    game: game.trim().slice(0, 60),
    expiresInHours: Number(expiresInHours) || 0,
    note: String(note || '').slice(0, 300),
    visibility: visibility === 'public' ? 'public' : 'private',
  });
  res.status(201).json(session);
});

app.post('/api/sessions/:id/visibility', (req, res) => {
  const session = store.setSessionVisibility(req.params.id, req.body?.visibility);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.post('/api/sessions/:id/active', (req, res) => {
  const session = store.setSessionActive(req.params.id, !!req.body?.active);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.delete('/api/sessions/:id', (req, res) => {
  if (!store.deleteSession(req.params.id)) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

app.get('/api/reports', (req, res) => {
  res.json(store.getReports({
    sessionId: req.query.sessionId || null,
    verdict: req.query.verdict || null,
    limit: req.query.limit || 200,
  }));
});

app.get('/api/reports/:id', (req, res) => {
  const report = store.getReportById(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

app.delete('/api/reports/:id', (req, res) => {
  if (!store.deleteReport(req.params.id)) return res.status(404).json({ error: 'Report not found' });
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  res.json(store.getEvents({
    limit: req.query.limit || 200,
    level: req.query.level || null,
    type: req.query.type || null,
    excludeType: req.query.excludeType || null,
  }));
});

/* ========================================================== detections ==== */

app.get('/api/detections', (req, res) => {
  res.json(store.getDetections({ limit: req.query.limit || 100 }));
});

app.post('/api/detections', (req, res) => {
  const { mode, filename, sizeKb, verdict, summary, matches } = req.body || {};
  if (!filename || !filename.trim()) return res.status(400).json({ error: 'Filename is required' });
  const det = store.saveDetection({
    mode: String(mode || 'string').slice(0, 40),
    filename: filename.trim().slice(0, 200),
    sizeKb: Number(sizeKb) || 0,
    verdict: ['clean', 'suspicious', 'detected'].includes(verdict) ? verdict : 'clean',
    summary: String(summary || '').slice(0, 2000),
    matches: Array.isArray(matches) ? matches.slice(0, 400) : [],
  });
  res.status(201).json(det);
});

app.delete('/api/detections/:id', (req, res) => {
  if (!store.deleteDetection(req.params.id)) return res.status(404).json({ error: 'Result not found' });
  res.json({ ok: true });
});

/* ============================================================= tickets ==== */

app.get('/api/tickets', (req, res) => {
  res.json(store.getTickets({ status: req.query.status || null }));
});

app.post('/api/tickets', (req, res) => {
  const { title, body, priority } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  const ticket = store.createTicket({
    title: title.trim().slice(0, 160),
    body: String(body || '').slice(0, 4000),
    priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
  });
  res.status(201).json(ticket);
});

app.post('/api/tickets/:id/status', (req, res) => {
  const ticket = store.updateTicketStatus(req.params.id, req.body?.status);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
});

/* ================================================================ chat ==== */

/** Local rule-based assistant — answers from portal data only (no external AI). */
function assistantReply(text) {
  const t = String(text || '').toLowerCase();
  const stats = store.getStats();
  const sessions = store.getSessions();
  const reports = store.getReports({ limit: 200 });
  const has = (...words) => words.some((w) => t.includes(w));

  if (has('hello', 'hi ', 'hey', 'yo ') || t.trim() === 'hi') {
    return `Hi — I'm the portal assistant. Ask me about sessions, scans, detections, flagged files or verdicts. Right now there are ${stats.sessions} pins and ${stats.reports} reports.`;
  }
  if (has('verdict', 'result', 'summary', 'status', 'overview')) {
    return `Current results: ${stats.clean} clean, ${stats.suspicious} suspicious, ${stats.detected} detected across ${stats.reports} reports from ${stats.devices} device(s). ${stats.flaggedFiles} file(s) flagged in total.`;
  }
  if (has('detect', 'cheater', 'caught', 'banned')) {
    const bad = reports.filter((r) => r.verdict === 'detected');
    if (!bad.length) return 'No DETECTED verdicts yet. Suspicious reports: ' + reports.filter((r) => r.verdict === 'suspicious').length + '.';
    return `${bad.length} DETECTED report(s): ` + bad.slice(0, 5).map((r) => `${r.playerName || r.hostname} (${r.score} pts, ${r.sessionPin})`).join('; ');
  }
  if (has('pin', 'session')) {
    const active = sessions.filter((s) => s.active).length;
    return `${sessions.length} pin(s) total, ${active} active. ` + sessions.slice(0, 4).map((s) => `${s.pin} ${s.name} [${s.game}] — ${s.reportCount} report(s)`).join('; ');
  }
  if (has('file', 'flag', 'unsigned')) {
    return `${stats.flaggedFiles} flagged file(s) across all reports; ${(stats.filesScanned || 0).toLocaleString()} file(s) scanned in total.`;
  }
  if (has('game')) {
    const g = stats.byGame || [];
    return g.length ? 'Scans by game: ' + g.map((x) => `${x.game} (${x.count})`).join(', ') : 'No game data yet.';
  }
  if (has('help', 'what can you', 'capabilit')) {
    return 'I can summarize: sessions/pins, scan reports and verdicts, flagged files, detections analysis results, tickets and system events. Try "how many reports?" or "any detected players?".';
  }
  if (has('download', 'agent', 'exe')) {
    return 'The agent EXE is on the Download page (Resources → Download). Generate a PIN first, then enter it in the agent to start a consent-based scan.';
  }
  if (has('thank', 'thanks')) return 'Any time. Stay clean out there. 🛡️';
  return `Got it. Quick snapshot: ${stats.sessions} pins · ${stats.reports} reports · ${stats.clean}/${stats.suspicious}/${stats.detected} clean/suspicious/detected. Ask me to break any of those down.`;
}

app.get('/api/chat', (_req, res) => res.json(store.getChat()));

app.post('/api/chat', (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Message text is required' });
  store.addChat('user', text);
  const reply = assistantReply(text);
  store.addChat('assistant', reply);
  res.json({ user: text, reply });
});

app.delete('/api/chat', (_req, res) => {
  store.clearChat();
  res.json({ ok: true });
});

/* ============================================================ download ==== */

/* Agent distributable served by the Download page.
   Resolution order: AGENT_FILE env → zip/exe placed next to the portal
   (portal/agent/, as uploaded to a server) → the local build tree. The ZIP
   build is self-contained (.NET runtime included) so players just extract
   and run AntiCheatAgent.exe. */
const AGENT_CANDIDATES = [
  process.env.AGENT_FILE,
  path.join(__dirname, 'agent', 'TournamentAntiCheat-Agent.zip'),
  path.join(__dirname, 'agent', 'AntiCheatAgent.exe'),
  path.join(__dirname, '..', 'agent', 'AntiCheatAgent', 'bin', 'Release',
    'net8.0-windows', 'AntiCheatAgent.exe'),
].filter(Boolean);
const AGENT_FILE = AGENT_CANDIDATES.find((p) => fs.existsSync(p))
  || AGENT_CANDIDATES[AGENT_CANDIDATES.length - 1];

app.get('/download/agent', (_req, res) => {
  if (!fs.existsSync(AGENT_FILE)) {
    store.logEvent('warn', 'download.miss', 'Agent build not found on disk (publish missing)', {});
    return res.status(404).send('Agent build not found — publish the agent first.');
  }
  store.logEvent('info', 'download.agent', 'Agent package downloaded from the Download page', {});
  const name = AGENT_FILE.toLowerCase().endsWith('.zip')
    ? 'TournamentAntiCheat-Agent.zip'
    : 'TournamentAntiCheat-Setup.exe';
  res.download(AGENT_FILE, name);
});

/* ============================================================ static UI ==== */

app.use(express.static(path.join(__dirname, 'public')));

/* SPA fallback for non-API GETs */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* eslint-disable no-unused-vars */
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  store.logEvent('success', 'portal.started', `Anti-cheat portal running at http://${HOST}:${PORT}`, {
    port: PORT,
  });
  console.log(`\n  ✦ Anti-cheat Portal`);
  console.log(`  → http://${HOST}:${PORT}\n`);
});
