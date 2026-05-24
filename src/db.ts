'use strict';

// Uses Node.js 22+ built-in SQLite (node:sqlite) — no native build tools needed.
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      hostname TEXT,
      platform TEXT,
      shells TEXT,
      secret_hash TEXT NOT NULL,
      enrolled_at INTEGER NOT NULL,
      last_seen INTEGER,
      status TEXT NOT NULL DEFAULT 'offline'
    );

    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      token TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      used_at INTEGER,
      used_by_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT,
      shell TEXT NOT NULL,
      cwd TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      owner TEXT
    );

    CREATE TABLE IF NOT EXISTS session_output (
      session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT,
      type TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user, agent_id, path, type)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      user TEXT,
      details TEXT,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_requests (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      agent_id TEXT,
      agent_secret TEXT
    );
  `);

  ensureColumn(db, 'agents', 'shells', 'shells TEXT');
  ensureColumn(db, 'sessions', 'cwd', 'cwd TEXT');

  return db;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

// ── Audit ──────────────────────────────────────────────────────────────────

function insertAudit(db, event, user, details) {
  const d = details == null ? null : typeof details === 'string' ? details : JSON.stringify(details);
  db.prepare('INSERT INTO audit_events (event, user, details, ts) VALUES (?, ?, ?, ?)').run(event, user ?? null, d, Date.now());
}

// ── Users ──────────────────────────────────────────────────────────────────

function getUser(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser(db, { id, username, passwordHash, role }) {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, passwordHash, role || 'admin', Date.now());
}

// ── Agents ─────────────────────────────────────────────────────────────────

function getAgent(db, agentId) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
}

function upsertAgent(db, { id, name, hostname, platform, shells, secretHash, enrolledAt }) {
  db.prepare(
    `INSERT OR REPLACE INTO agents (id, name, hostname, platform, shells, secret_hash, enrolled_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'offline')`
  ).run(id, name ?? hostname, hostname, platform, serializeShells(shells), secretHash, enrolledAt);
}

function markAgentOnline(db, agentId) {
  db.prepare("UPDATE agents SET status = 'online', last_seen = ? WHERE id = ?").run(Date.now(), agentId);
}

function markAgentOffline(db, agentId) {
  db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run(agentId);
}

function listAgents(db) {
  return db.prepare(
    `SELECT id, name, hostname, platform, shells, enrolled_at, last_seen, status
     FROM agents
     ORDER BY enrolled_at DESC`
  ).all().map((agent) => ({
    ...agent,
    shells: parseShells(agent.shells),
  }));
}

// ── Enrollment tokens ───────────────────────────────────────────────────────

function hashEnrollmentToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function fingerprintEnrollmentToken(token) {
  return hashEnrollmentToken(token).slice(0, 12);
}

function getEnrollmentToken(db, token) {
  return db.prepare('SELECT * FROM enrollment_tokens WHERE token = ?').get(hashEnrollmentToken(token));
}

function createEnrollmentToken(db, { token, createdBy }) {
  db.prepare(
    'INSERT INTO enrollment_tokens (token, created_by, created_at) VALUES (?, ?, ?)'
  ).run(hashEnrollmentToken(token), createdBy, Date.now());
}

function useEnrollmentToken(db, token, agentId) {
  const tokenHash = hashEnrollmentToken(token);
  const result = db.prepare(
    'UPDATE enrollment_tokens SET used = 1, used_at = ?, used_by_agent = ? WHERE token = ? AND used = 0'
  ).run(Date.now(), agentId, tokenHash);

  if (result.changes === 1) return;

  const row = db.prepare('SELECT used FROM enrollment_tokens WHERE token = ?').get(tokenHash);
  if (!row) throw new Error('Token not found');
  throw new Error('Token already used');
}

// ── Sessions ───────────────────────────────────────────────────────────────

function createSession(db, { id, agentId, name, shell, cwd, owner }) {
  db.prepare(
    `INSERT INTO sessions (id, agent_id, name, shell, cwd, status, created_at, owner)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, agentId, name ?? shell, shell, cwd ?? null, Date.now(), owner ?? null);
}

function endSession(db, sessionId) {
  db.prepare(
    "UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?"
  ).run(Date.now(), sessionId);
}

function listSessions(db) {
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all();
}

function deleteEndedSessions(db) {
  return db.prepare("DELETE FROM sessions WHERE status != 'active'").run();
}

function pruneOldSessions(db, maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return db.prepare("DELETE FROM sessions WHERE status != 'active' AND created_at < ?").run(cutoff);
}

// â”€â”€ User locations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function listUserLocations(db, { user, agentId, type }) {
  return db.prepare(
    `SELECT agent_id, path, label, type, updated_at
     FROM user_locations
     WHERE user = ? AND agent_id = ? AND type = ?
     ORDER BY updated_at DESC
     LIMIT 25`
  ).all(user, agentId, type);
}

function upsertUserLocation(db, { user, agentId, path, label, type }) {
  db.prepare(
    `INSERT INTO user_locations (user, agent_id, path, label, type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user, agent_id, path, type)
     DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`
  ).run(user, agentId, path, label ?? null, type, Date.now());

  if (type === 'recent') {
    db.prepare(
      `DELETE FROM user_locations
       WHERE id IN (
         SELECT id FROM user_locations
         WHERE user = ? AND agent_id = ? AND type = 'recent'
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET 20
       )`
    ).run(user, agentId);
  }
}

function deleteUserLocation(db, { user, agentId, path, type }) {
  db.prepare(
    'DELETE FROM user_locations WHERE user = ? AND agent_id = ? AND path = ? AND type = ?'
  ).run(user, agentId, path, type);
}

// ── Device requests ────────────────────────────────────────────────────────

function createDeviceRequest(db, { id, hostname, platform, expiresAt }) {
  db.prepare(
    'INSERT INTO device_requests (id, hostname, platform, status, created_at, expires_at) VALUES (?, ?, ?, \'pending\', ?, ?)'
  ).run(id, hostname, platform, Date.now(), expiresAt);
}

function getDeviceRequest(db, id) {
  return db.prepare('SELECT * FROM device_requests WHERE id = ?').get(id);
}

function listPendingDeviceRequests(db) {
  return db.prepare(
    'SELECT id, hostname, platform, created_at, expires_at FROM device_requests WHERE status = \'pending\' ORDER BY created_at DESC'
  ).all();
}

function approveDeviceRequest(db, id, agentId, agentSecret) {
  db.prepare(
    'UPDATE device_requests SET status = \'approved\', agent_id = ?, agent_secret = ? WHERE id = ? AND status = \'pending\''
  ).run(agentId, agentSecret, id);
}

function rejectDeviceRequest(db, id) {
  db.prepare(
    'UPDATE device_requests SET status = \'rejected\' WHERE id = ? AND status = \'pending\''
  ).run(id);
}

function cleanupExpiredDeviceRequests(db) {
  db.prepare('DELETE FROM device_requests WHERE expires_at < ? AND status = \'pending\'').run(Date.now());
}

function serializeShells(shells) {
  if (!Array.isArray(shells)) return null;
  return JSON.stringify(shells.filter((shell) => typeof shell === 'string'));
}

function parseShells(shells) {
  if (!shells) return [];
  try {
    const parsed = JSON.parse(shells);
    return Array.isArray(parsed) ? parsed.filter((shell) => typeof shell === 'string') : [];
  } catch {
    return [];
  }
}

module.exports = {
  openDb,
  insertAudit,
  getUser, createUser,
  getAgent, upsertAgent, markAgentOnline, markAgentOffline, listAgents,
  getEnrollmentToken, createEnrollmentToken, useEnrollmentToken, fingerprintEnrollmentToken,
  createSession, endSession, listSessions, deleteEndedSessions, pruneOldSessions,
  listUserLocations, upsertUserLocation, deleteUserLocation,
  createDeviceRequest, getDeviceRequest, listPendingDeviceRequests,
  approveDeviceRequest, rejectDeviceRequest, cleanupExpiredDeviceRequests,
  parseShells,
};
