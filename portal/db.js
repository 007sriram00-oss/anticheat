'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    game        TEXT NOT NULL,
    pin         TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    note        TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS reports (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    device_id     TEXT NOT NULL,
    hostname      TEXT NOT NULL,
    player_name   TEXT DEFAULT '',
    game          TEXT NOT NULL,
    verdict       TEXT NOT NULL,
    score         INTEGER NOT NULL DEFAULT 0,
    agent_version TEXT DEFAULT '',
    os            TEXT DEFAULT '',
    started_at    TEXT NOT NULL,
    finished_at   TEXT NOT NULL,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    consent_at    TEXT,
    system_json   TEXT DEFAULT '{}',
    summary_json  TEXT DEFAULT '{}',
    findings_json TEXT DEFAULT '[]',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    level     TEXT NOT NULL,
    type      TEXT NOT NULL,
    message   TEXT NOT NULL,
    meta_json TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS detections (
    id          TEXT PRIMARY KEY,
    mode        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size_kb     INTEGER NOT NULL DEFAULT 0,
    verdict     TEXT DEFAULT 'clean',
    summary     TEXT DEFAULT '',
    matches_json TEXT DEFAULT '[]',
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT DEFAULT '',
    priority    TEXT DEFAULT 'normal',
    status      TEXT DEFAULT 'active',
    created_by  TEXT DEFAULT 'Administrator',
    assigned    TEXT DEFAULT '',
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL,
    role    TEXT NOT NULL,
    text    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT DEFAULT '',
    avatar_url  TEXT DEFAULT '',
    created_at  TEXT NOT NULL,
    last_login  TEXT NOT NULL,
    UNIQUE(provider, provider_id)
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
  CREATE INDEX IF NOT EXISTS idx_reports_verdict  ON reports(verdict);
  CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_user_sessions    ON user_sessions(token);
`);

/* ---------------------------------------------------- schema migrations */

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logEvent('info', 'db.migrated', `Added column ${table}.${column}`);
  }
}

ensureColumn('reports', 'files_json', "TEXT DEFAULT '[]'");
ensureColumn('reports', 'av_json', "TEXT DEFAULT '{}'");
ensureColumn('sessions', 'visibility', "TEXT DEFAULT 'private'");

/* ---------------------------------------------------------------- helpers */

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

/** Human friendly session PIN, e.g. "K7F2-9QXA" */
function generatePin() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/* ------------------------------------------------------------------ events */

function logEvent(level, type, message, meta = {}) {
  db.prepare(
    'INSERT INTO events (ts, level, type, message, meta_json) VALUES (?, ?, ?, ?, ?)'
  ).run(nowIso(), level, type, message, JSON.stringify(meta));
}

function getEvents({ limit = 200, level = null, type = null, excludeType = null } = {}) {
  let sql = 'SELECT * FROM events';
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  if (type)  { where.push('type = ?');  params.push(type); }
  if (excludeType) { where.push('type != ?'); params.push(excludeType); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    meta: safeJson(r.meta_json, {}),
  }));
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/* ---------------------------------------------------------------- sessions */

function createSession({ name, game, expiresInHours = 0, note = '', visibility = 'private' }) {
  const pin = generatePin();
  const createdAt = nowIso();
  const expiresAt = expiresInHours > 0
    ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString()
    : null;
  const sessionId = id();
  db.prepare(
    `INSERT INTO sessions (id, name, game, pin, created_at, expires_at, active, note, visibility)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(sessionId, name, game, pin, createdAt, expiresAt, note, visibility === 'public' ? 'public' : 'private');
  logEvent('success', 'session.created', `Session "${name}" created for ${game}`, { sessionId, game, visibility });
  return getSessionById(sessionId);
}

function rowToSession(r) {
  if (!r) return null;
  const reportCount = db
    .prepare('SELECT COUNT(*) AS c FROM reports WHERE session_id = ?')
    .get(r.id).c;
  const flaggedCount = db
    .prepare("SELECT COUNT(*) AS c FROM reports WHERE session_id = ? AND verdict != 'clean'")
    .get(r.id).c;
  const expired = r.expires_at ? new Date(r.expires_at).getTime() < Date.now() : false;
  const players = db
    .prepare(`SELECT DISTINCT player_name AS p FROM reports WHERE session_id = ? AND player_name != ''`)
    .all(r.id).map((x) => x.p);
  return {
    id: r.id,
    name: r.name,
    game: r.game,
    pin: r.pin,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    active: !!r.active && !expired,
    note: r.note,
    visibility: r.visibility === 'public' ? 'public' : 'private',
    players,
    reportCount,
    flaggedCount,
  };
}

function getSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all().map(rowToSession);
}

function getSessionById(sessionId) {
  return rowToSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId));
}

function getSessionByPin(pin) {
  const clean = String(pin || '').trim().toUpperCase();
  return rowToSession(db.prepare('SELECT * FROM sessions WHERE pin = ?').get(clean));
}

function deleteSession(sessionId) {
  const s = getSessionById(sessionId);
  if (!s) return false;
  db.prepare('DELETE FROM reports WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  logEvent('warn', 'session.deleted', `Session "${s.name}" (${s.game}) deleted`, { sessionId });
  return true;
}

function setSessionActive(sessionId, active) {
  const s = getSessionById(sessionId);
  if (!s) return null;
  db.prepare('UPDATE sessions SET active = ? WHERE id = ?').run(active ? 1 : 0, sessionId);
  logEvent('info', 'session.updated', `Session "${s.name}" ${active ? 'activated' : 'paused'}`, { sessionId });
  return getSessionById(sessionId);
}

function setSessionVisibility(sessionId, visibility) {
  const s = getSessionById(sessionId);
  if (!s) return null;
  const v = visibility === 'public' ? 'public' : 'private';
  db.prepare('UPDATE sessions SET visibility = ? WHERE id = ?').run(v, sessionId);
  logEvent('info', 'session.updated', `Session "${s.name}" set to ${v === 'private' ? 'Private' : 'Public'}`, { sessionId });
  return getSessionById(sessionId);
}

/* -------------------------------------------------------------- detections */

function saveDetection({ mode, filename, sizeKb = 0, verdict = 'clean', summary = '', matches = [] }) {
  const detId = id();
  db.prepare(
    `INSERT INTO detections (id, mode, filename, size_kb, verdict, summary, matches_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(detId, String(mode || 'string'), String(filename || 'file'), Number(sizeKb) || 0,
    String(verdict || 'clean'), String(summary || ''), JSON.stringify(matches), nowIso());
  logEvent(verdict === 'suspicious' || verdict === 'detected' ? 'warn' : 'info',
    'detection.analyzed',
    `Detections: ${filename} analyzed in ${mode} mode — ${verdict}`,
    { detId, mode, verdict });
  return getDetectionById(detId);
}

function rowToDetection(r) {
  if (!r) return null;
  return {
    id: r.id,
    mode: r.mode,
    filename: r.filename,
    sizeKb: r.size_kb,
    verdict: r.verdict,
    summary: r.summary,
    matches: safeJson(r.matches_json, []),
    createdAt: r.created_at,
  };
}

function getDetectionById(detId) {
  return rowToDetection(db.prepare('SELECT * FROM detections WHERE id = ?').get(detId));
}

function getDetections({ limit = 100 } = {}) {
  return db.prepare('SELECT * FROM detections ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Number(limit) || 100, 500)).map(rowToDetection);
}

function deleteDetection(detId) {
  const before = getDetectionById(detId);
  if (!before) return false;
  db.prepare('DELETE FROM detections WHERE id = ?').run(detId);
  logEvent('info', 'detection.deleted', `Detection result ${before.filename} deleted`, { detId });
  return true;
}

/* ----------------------------------------------------------------- tickets */

function createTicket({ title, body = '', priority = 'normal', createdBy = 'Administrator' }) {
  const ticketId = `TCK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  db.prepare(
    `INSERT INTO tickets (id, title, body, priority, status, created_by, assigned, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, '', ?)`
  ).run(ticketId, title, body, priority, createdBy, nowIso());
  logEvent('info', 'ticket.created', `Support ticket ${ticketId} opened: ${title}`, { ticketId });
  return getTicket(ticketId);
}

function getTicket(ticketId) {
  const r = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!r) return null;
  return { ...r, createdAt: r.created_at };
}

function getTickets({ status = null, limit = 200 } = {}) {
  let sql = 'SELECT * FROM tickets';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 500));
  return db.prepare(sql).all(...params).map((r) => ({ ...r, createdAt: r.created_at }));
}

function updateTicketStatus(ticketId, status) {
  const allowed = ['active', 'awaiting', 'closed'];
  const s = allowed.includes(status) ? status : 'active';
  const before = getTicket(ticketId);
  if (!before) return null;
  db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(s, ticketId);
  logEvent('info', 'ticket.updated', `Ticket ${ticketId} → ${s}`, { ticketId });
  return getTicket(ticketId);
}

/* -------------------------------------------------------------------- chat */

function addChat(role, text) {
  db.prepare('INSERT INTO chat_messages (ts, role, text) VALUES (?, ?, ?)')
    .run(nowIso(), role === 'assistant' ? 'assistant' : 'user', String(text).slice(0, 4000));
}

function getChat({ limit = 200 } = {}) {
  return db.prepare('SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?')
    .all(Math.min(Number(limit) || 200, 500))
    .reverse()
    .map((r) => ({ id: r.id, ts: r.ts, role: r.role, text: r.text }));
}

function clearChat() {
  db.prepare('DELETE FROM chat_messages').run();
}

/* ----------------------------------------------------------------- reports */

function saveReport(session, data) {
  const reportId = id();
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const files = Array.isArray(data.files) ? data.files : [];
  const av = data.av && typeof data.av === 'object' ? data.av : {};
  db.prepare(
    `INSERT INTO reports (
      id, session_id, device_id, hostname, player_name, game, verdict, score,
      agent_version, os, started_at, finished_at, duration_ms, consent_at,
      system_json, summary_json, findings_json, created_at, files_json, av_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    reportId,
    session.id,
    String(data.deviceId || 'unknown'),
    String(data.hostname || 'unknown'),
    String(data.playerName || ''),
    session.game,
    String(data.verdict || 'clean'),
    Number(data.score) || 0,
    String(data.agentVersion || ''),
    String(data.os || ''),
    String(data.startedAt || nowIso()),
    String(data.finishedAt || nowIso()),
    Number(data.durationMs) || 0,
    data.consentAt || null,
    JSON.stringify(data.system || {}),
    JSON.stringify(data.summary || {}),
    JSON.stringify(findings),
    nowIso(),
    JSON.stringify(files),
    JSON.stringify(av)
  );

  const flagged = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
  const flaggedFiles = files.filter((f) => f.status && f.status !== 'ok').length;
  const level = data.verdict === 'detected' ? 'error' : data.verdict === 'suspicious' ? 'warn' : 'success';
  logEvent(
    level,
    'report.received',
    `Scan report from ${data.hostname || 'unknown'} [${session.game}] — ${String(data.verdict || 'clean').toUpperCase()}` +
      (flagged ? ` (${flagged} serious finding${flagged > 1 ? 's' : ''})` : '') +
      (flaggedFiles ? ` · ${flaggedFiles} flagged file${flaggedFiles > 1 ? 's' : ''}` : ''),
    { reportId, sessionId: session.id, verdict: data.verdict, score: data.score, flaggedFiles }
  );
  return { id: reportId, verdict: data.verdict };
}

function getReports({ sessionId = null, verdict = null, limit = 200 } = {}) {
  let sql = `
    SELECT r.*, s.name AS session_name, s.pin AS session_pin
    FROM reports r JOIN sessions s ON s.id = r.session_id`;
  const where = [];
  const params = [];
  if (sessionId) { where.push('r.session_id = ?'); params.push(sessionId); }
  if (verdict)   { where.push('r.verdict = ?');   params.push(verdict); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY r.created_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...params).map(rowToReport);
}

function rowToReport(r) {
  if (!r) return null;
  const findings = safeJson(r.findings_json, []);
  const files = safeJson(r.files_json, []);
  const av = safeJson(r.av_json, {});
  const serious = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const flaggedFiles = files.filter((f) => f.status && f.status !== 'ok');
  return {
    id: r.id,
    sessionId: r.session_id,
    sessionName: r.session_name,
    sessionPin: r.session_pin,
    deviceId: r.device_id,
    hostname: r.hostname,
    playerName: r.player_name,
    game: r.game,
    verdict: r.verdict,
    score: r.score,
    agentVersion: r.agent_version,
    os: r.os,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    consentAt: r.consent_at,
    createdAt: r.created_at,
    system: safeJson(r.system_json, {}),
    summary: safeJson(r.summary_json, {}),
    findings,
    files,
    av,
    seriousCount: serious.length,
    flaggedFileCount: flaggedFiles.length,
  };
}

function getReportById(reportId) {
  const r = db
    .prepare(
      `SELECT r.*, s.name AS session_name, s.pin AS session_pin
       FROM reports r JOIN sessions s ON s.id = r.session_id WHERE r.id = ?`
    )
    .get(reportId);
  return rowToReport(r);
}

function deleteReport(reportId) {
  const before = getReportById(reportId);
  if (!before) return false;
  db.prepare('DELETE FROM reports WHERE id = ?').run(reportId);
  logEvent('warn', 'report.deleted', `Report ${reportId} from ${before.hostname} deleted`, { reportId });
  return true;
}

/* ------------------------------------------------------------------- stats */

function getStats() {
  const sessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  const activeSessions = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE active = 1').get().c;
  const reports = db.prepare('SELECT COUNT(*) AS c FROM reports').get().c;
  const byVerdict = db.prepare(`
    SELECT
      SUM(CASE WHEN verdict = 'clean'     THEN 1 ELSE 0 END) AS clean,
      SUM(CASE WHEN verdict = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
      SUM(CASE WHEN verdict = 'detected'   THEN 1 ELSE 0 END) AS detected
    FROM reports
  `).get();
  const devices = db.prepare('SELECT COUNT(DISTINCT device_id) AS c FROM reports').get().c;
  const last24h = db.prepare(
    "SELECT COUNT(*) AS c FROM reports WHERE created_at >= datetime('now', '-1 day')"
  ).get().c;

  const topFindings = db.prepare(`
    SELECT json_extract(value, '$.title') AS title,
           json_extract(value, '$.severity') AS severity,
           COUNT(*) AS count
    FROM reports, json_each(findings_json)
    WHERE json_extract(value, '$.severity') IN ('critical', 'high', 'medium')
    GROUP BY title, severity
    ORDER BY count DESC LIMIT 8
  `).all();

  const byGame = db.prepare(`
    SELECT game, COUNT(*) AS count FROM reports GROUP BY game ORDER BY count DESC
  `).all();

  const flaggedFiles = db.prepare(`
    SELECT COUNT(*) AS c
    FROM reports, json_each(reports.files_json)
    WHERE json_extract(value, '$.status') IS NOT NULL
      AND json_extract(value, '$.status') != 'ok'
  `).get().c;

  const filesScanned = db.prepare(`
    SELECT COALESCE(SUM(json_extract(summary_json, '$.filesScanned')), 0) AS c FROM reports
  `).get().c;

  const sessionsActive = activeSessions;

  return {
    sessions,
    sessionsActive,
    activeSessions,
    reports,
    devices,
    last24h,
    clean: byVerdict.clean || 0,
    suspicious: byVerdict.suspicious || 0,
    detected: byVerdict.detected || 0,
    flaggedFiles,
    filesScanned,
    topFindings,
    byGame,
  };
}

/* -------------------------------------------------------------------- users */

function upsertUser({ provider, providerId, name, email = '', avatarUrl = '' }) {
  const existing = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').get(provider, providerId);
  const now = nowIso();
  if (existing) {
    db.prepare('UPDATE users SET name = ?, email = ?, avatar_url = ?, last_login = ? WHERE id = ?')
      .run(name, email, avatarUrl, now, existing.id);
    logEvent('info', 'auth.login', `User ${name} logged in via ${provider}`, { userId: existing.id, provider });
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const userId = id();
  db.prepare('INSERT INTO users (id, provider, provider_id, name, email, avatar_url, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, provider, providerId, name, email, avatarUrl, now, now);
  logEvent('success', 'auth.signup', `New user ${name} registered via ${provider}`, { userId, provider });
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function createSessionToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, expiresAt);
  return token;
}

function getUserBySessionToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.provider, u.name, u.email, u.avatar_url AS avatarUrl, s.expires_at
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
    return null;
  }
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
  };
}

function deleteSessionToken(token) {
  if (!token) return;
  db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
}

function getSetting(key, def = null) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : def;
  } catch {
    return def;
  }
}

function setSetting(key, value) {
  try {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  } catch (e) {
    console.error('setSetting error:', e.message);
  }
}

module.exports = {
  upsertUser,
  createSessionToken,
  getUserBySessionToken,
  deleteSessionToken,
  db,
  nowIso,
  id,
  logEvent,
  getEvents,
  createSession,
  getSessions,
  getSessionById,
  getSessionByPin,
  deleteSession,
  setSessionActive,
  setSessionVisibility,
  saveDetection,
  getDetections,
  getDetectionById,
  deleteDetection,
  createTicket,
  getTicket,
  getTickets,
  updateTicketStatus,
  addChat,
  getChat,
  clearChat,
  saveReport,
  getReports,
  getReportById,
  deleteReport,
  getStats,
  getSetting,
  setSetting,
};
