const crypto = require('crypto');

const { getDb } = require('./db');

const PREFIX = 'pk_live_';
const KEY_PREFIX_RE = /^pk_live_[A-Za-z0-9_-]{20,}$/;

function generate() {
  return PREFIX + crypto.randomBytes(24).toString('base64url');
}

function hash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

function listForUser(userId) {
  const rows = getDb().prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(toPublic);
}

function getForUser(id, userId) {
  const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId);
  return row || null;
}

function create(userId, name, scopes) {
  const db = getDb();
  const id = 'key_' + crypto.randomBytes(8).toString('hex');
  const raw = generate();
  const dbKey = hash(raw);
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, name, dbKey, raw.slice(0, 16) + '…', scopes || 'default');
  return { key: raw, row: toPublic(getForUser(id, userId)) };
}

function remove(id, userId) {
  const db = getDb();
  const existing = getForUser(id, userId);
  if (!existing) return false;
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return true;
}

function authenticate(token) {
  if (!token || typeof token !== 'string' || !KEY_PREFIX_RE.test(token)) return null;
  const row = getDb().prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash(token));
  if (!row || row.revoked_at) return null;
  return {
    keyId: row.id,
    userId: row.user_id,
    name: row.name,
    scopes: (row.scopes || 'default').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function touchLastUsed(keyId) {
  getDb().prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))")
    .run(keyId);
}

module.exports = { generate, hash, listForUser, getForUser, create, remove, authenticate, touchLastUsed };
