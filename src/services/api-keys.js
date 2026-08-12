const crypto = require('crypto');

const { getDb } = require('./db');

const PREFIX = 'pk_live_';
const KEY_PREFIX_RE = /^pk_live_[A-Za-z0-9_-]{20,}$/;

const VM_PREFIX = process.env.CONTAINER_PREFIX || 'vm';
const VM_NAME_RE = new RegExp('^' + VM_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');

// ─── API-key scopes / grants (plan 35b) ─────────────────────────
// Scopes live in the `scopes` column as a comma-joined list. Two families:
//
//   * Broad (mutually exclusive with everything else):
//       `default` / `control` — full access to everything the owner can reach.
//       `read`               — read/inspect only (no exec, no workspace writes,
//                              no lifecycle). May be combined with `target:*`.
//   * Fine-grained grants (default base = read + workspace + exec):
//       `target:owned`              — target = every agent the owner owns.
//       `target:agent:<pad-name>`   — target = a single PAD only.
//       `tools:lifecycle`           — + start / stop / restart.
//       `tools:recreate`            — + recreate / update.
//       `tools:create`              — + create_agent.
//       `tools:delete`              — + delete_agent.
//       `tools:reset`               — + recreate with reset:true (wipes data).
// The MCP server enforces these before the owner/admin checks (see mcp.js). */
const TOOL_GRANTS = ['lifecycle', 'recreate', 'create', 'delete', 'reset'];

/** Validate a scope list (array or comma-string). Throws Error on the first
 *  problem; returns the normalized, de-duplicated comma-joined string. */
function validateScopes(scopes) {
  const list = Array.isArray(scopes)
    ? scopes.map((s) => String(s).trim())
    : String(scopes || 'default').split(',').map((s) => s.trim());
  const clean = list.filter(Boolean);
  if (!clean.length) throw new Error('At least one scope required');
  const full = clean.some((s) => s === 'default' || s === 'control');
  if (full && clean.some((s) => s !== 'default' && s !== 'control')) {
    throw new Error('default/control cannot be combined with restricted scopes');
  }
  if (clean.includes('read') && clean.some((s) => s.startsWith('tools:'))) {
    throw new Error('read cannot be combined with tools:* grants');
  }
  for (const s of clean) {
    if (s === 'default' || s === 'control' || s === 'read' || s === 'target:owned') continue;
    if (s.startsWith('tools:')) {
      if (TOOL_GRANTS.includes(s.slice('tools:'.length))) continue;
      throw new Error(`Unknown tool grant: ${s}`);
    }
    if (s.startsWith('target:agent:')) {
      const name = s.slice('target:agent:'.length);
      if (!VM_NAME_RE.test(name)) throw new Error(`Invalid target PAD name: ${name}`);
      continue;
    }
    throw new Error(`Unknown scope: ${s}`);
  }
  return [...new Set(clean)].join(',');
}

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
    .run(id, userId, name, dbKey, raw.slice(0, 16) + '…', validateScopes(scopes || 'default'));
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

module.exports = { generate, hash, listForUser, getForUser, create, remove, authenticate, touchLastUsed, validateScopes, TOOL_GRANTS };
