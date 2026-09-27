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

/* ============================== login sessions ============================== */

const crypto = require('crypto');

/* Local admin account. The login page accepts this username (or its email
   form) plus the password. ADMIN_PASSWORD is required for public deployments;
   a development default is used locally and a warning is printed. */
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('  ! ADMIN_PASSWORD not set — password login accepts "admin/admin123".');
  console.warn('    Set ADMIN_PASSWORD before exposing the portal.');
}

// Load optional local auth config (ignored by git for secret protection)
const AUTH_CONFIG_FILE = path.join(__dirname, 'auth.json');
if (fs.existsSync(AUTH_CONFIG_FILE)) {
  try {
    const raw = fs.readFileSync(AUTH_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    const authCfg = JSON.parse(raw);
    for (const [k, v] of Object.entries(authCfg)) {
      if (!process.env[k] && v) process.env[k] = v;
    }
  } catch (e) {
    console.error('Failed to load auth.json:', e.message);
  }
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';

const oauthStates = new Map();   // state -> { provider, to, createdAt }
const loginAttempts = new Map(); // ip -> { n, resetAt }

function pruneOauthStates() {
  const now = Date.now();
  for (const [st, v] of oauthStates) if (now - v.createdAt > 15 * 60 * 1000) oauthStates.delete(st);
}
setInterval(pruneOauthStates, 10 * 60 * 1000).unref();

/* Sessions are DB-backed (users + user_sessions tables, 30-day expiry).
   parseCookies / getBaseUrl live with the original OAuth block further down. */
function sessionUser(req) {
  return store.getUserBySessionToken(parseCookies(req).anticheat_session);
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `anticheat_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}

function pwOk(given) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rateLimited(req) {
  const now = Date.now();
  const rec = loginAttempts.get(req.ip);
  if (!rec || now > rec.resetAt) { loginAttempts.set(req.ip, { n: 1, resetAt: now + 60_000 }); return false; }
  rec.n += 1;
  return rec.n > 10;
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

/* Session gate: everything requires a login except the agent API (PIN-gated),
   the auth endpoints, the login page and static assets (no data in them).
   Unauthenticated API calls get 401; page loads bounce to the login page
   with a redirectTo so the user lands where they were headed. */
const OPEN_PREFIXES = ['/api/agent', '/api/login', '/auth/', '/login.html', '/css/', '/js/', '/icons/', '/favicon'];
app.use((req, res, next) => {
  const p = req.path;
  if (OPEN_PREFIXES.some((x) => p === x || p.startsWith(x))) return next();
  const user = sessionUser(req);
  if (user) { req.user = user; return next(); }
  if (p.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  return res.redirect('/login.html?redirectTo=' + encodeURIComponent(req.originalUrl));
});

app.use('/api/agent', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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

/* ======================================================= OAuth & Auth ==== */


function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
  }
  return list;
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Only same-site relative paths may be used as a post-login destination.
function safeTo(to) {
  return typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : '/';
}

function successDest(rec) {
  const to = (rec && rec.to) || '/';
  return to + (to.includes('?') ? '&' : '?') + 'auth=success';
}

// User info endpoint
app.get('/api/me', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.anticheat_session;
  const user = store.getUserBySessionToken(token);
  if (!user) return res.json({ authenticated: false, user: null });
  return res.json({ authenticated: true, user });
});

// Logout endpoint
app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.anticheat_session;
  if (token) store.deleteSessionToken(token);
  res.setHeader('Set-Cookie', 'anticheat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.anticheat_session;
  if (token) store.deleteSessionToken(token);
  res.setHeader('Set-Cookie', 'anticheat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/');
});

// Discord OAuth
app.get('/auth/discord', (req, res) => {
  const base = getBaseUrl(req);
  const redirectUri = `${base}/auth/discord/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider: 'discord', to: safeTo(req.query.to), createdAt: Date.now() });
  const url = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20email&state=${state}`;
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const rec = state && oauthStates.get(state);
  if (state) oauthStates.delete(state);
  if (error || !code) return res.redirect('/login.html?error=' + encodeURIComponent(error || 'cancelled'));
  if (!rec || rec.provider !== 'discord') return res.redirect('/login.html?error=invalid_state');

  const base = getBaseUrl(req);
  const redirectUri = `${base}/auth/discord/callback`;

  try {
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text();
      store.logEvent('error', 'auth.discord', 'Discord token exchange failed', { error: errTxt });
      return res.redirect('/login.html?error=' + encodeURIComponent('Discord token exchange failed'));
    }

    const tokenData = await tokenRes.json();
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      return res.redirect('/login.html?error=' + encodeURIComponent('Failed to fetch Discord user'));
    }

    const discordUser = await userRes.json();
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';

    const user = store.upsertUser({
      provider: 'discord',
      providerId: discordUser.id,
      name: discordUser.global_name || discordUser.username,
      email: discordUser.email || '',
      avatarUrl,
    });

    const sessionToken = store.createSessionToken(user.id);
    setSessionCookie(res, sessionToken);
    res.redirect(successDest(rec));
  } catch (err) {
    console.error('Discord OAuth error:', err);
    res.redirect('/login.html?error=' + encodeURIComponent(err.message));
  }
});

// Google OAuth
app.get('/auth/google', (req, res) => {
  const base = getBaseUrl(req);
  const redirectUri = `${base}/auth/google/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider: 'google', to: safeTo(req.query.to), createdAt: Date.now() });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20profile%20email&prompt=select_account&state=${state}`;
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const rec = state && oauthStates.get(state);
  if (state) oauthStates.delete(state);
  if (error || !code) return res.redirect('/login.html?error=' + encodeURIComponent(error || 'cancelled'));
  if (!rec || rec.provider !== 'google') return res.redirect('/login.html?error=invalid_state');

  const base = getBaseUrl(req);
  const redirectUri = `${base}/auth/google/callback`;

  try {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text();
      store.logEvent('error', 'auth.google', 'Google token exchange failed', { error: errTxt });
      return res.redirect('/login.html?error=' + encodeURIComponent('Google token exchange failed'));
    }

    const tokenData = await tokenRes.json();
    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      return res.redirect('/login.html?error=' + encodeURIComponent('Failed to fetch Google user profile'));
    }

    const googleUser = await userRes.json();
    const user = store.upsertUser({
      provider: 'google',
      providerId: googleUser.sub,
      name: googleUser.name || 'Google User',
      email: googleUser.email || '',
      avatarUrl: googleUser.picture || '',
    });

    const sessionToken = store.createSessionToken(user.id);
    setSessionCookie(res, sessionToken);
    res.redirect(successDest(rec));
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.redirect('/login.html?error=' + encodeURIComponent(err.message));
  }
});

/* =========================================================== auth/login ==== */

// Password login (local admin account). Issues the same DB-backed session
// cookie as the OAuth flows so the dashboard treats all providers alike.
app.post('/api/login', (req, res) => {
  if (rateLimited(req)) {
    return res.status(429).json({ error: 'Too many attempts — wait a minute and try again.' });
  }
  const { email, password } = req.body || {};
  const raw = String(email || '').trim().toLowerCase();
  const name = raw.includes('@') ? raw.split('@')[0] : raw;
  if (!raw || !password) return res.status(400).json({ error: 'Enter your username and password.' });
  if (name !== ADMIN_USER || !pwOk(password)) {
    store.logEvent('warn', 'auth.failed', `Failed password sign-in for "${raw.slice(0, 30)}"`, { ip: req.ip });
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const row = store.upsertUser({
    provider: 'local',
    providerId: ADMIN_USER,
    name: ADMIN_USER,
    email: `${ADMIN_USER}@portal.local`,
  });
  const user = {
    id: row.id, provider: 'local', name: row.name, email: row.email, avatarUrl: row.avatar_url || '',
  };
  setSessionCookie(res, store.createSessionToken(user.id));
  res.json({ authenticated: true, user });
});

// Lets the login page show a local-dev hint only when the default
// development password is still active (never on a configured server).
app.get('/api/login-config', (_req, res) => {
  res.json({ pwHint: !process.env.ADMIN_PASSWORD, user: ADMIN_USER });
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
