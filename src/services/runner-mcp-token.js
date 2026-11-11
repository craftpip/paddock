/** Plan 117: per-pad tokens for the runner MCP surface (`/mcp/runner`).
 *  A token identifies a PAD, not a user: it can only reach runners whose project
 *  lives on that pad, and only the worker queue tools. Stored as sha256; the raw
 *  value exists only in the mint result and in the pad's own MCP config. */
const crypto = require('crypto');
const { getDb } = require('./db');

const hash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** Mint a fresh token for `agentName`, replacing any previous one. */
function mint(agentName) {
  if (!agentName) throw new Error('agent name required');
  const raw = `prk_${crypto.randomBytes(24).toString('hex')}`;
  getDb().prepare(`INSERT INTO runner_mcp_tokens (agent_name, token_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT(agent_name) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL`)
    .run(agentName, hash(raw), new Date().toISOString());
  return raw;
}

/** The pad a raw token belongs to, or null. Only `prk_` tokens are considered,
 *  so a user API key presented here is refused rather than looked up. */
function authenticate(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('prk_')) return null;
  const row = getDb().prepare('SELECT agent_name FROM runner_mcp_tokens WHERE token_hash = ?').get(hash(raw));
  if (!row) return null;
  try { getDb().prepare('UPDATE runner_mcp_tokens SET last_used_at = ? WHERE agent_name = ?').run(new Date().toISOString(), row.agent_name); } catch {}
  return row.agent_name;
}

function revoke(agentName) {
  getDb().prepare('DELETE FROM runner_mcp_tokens WHERE agent_name = ?').run(agentName);
}

module.exports = { mint, authenticate, revoke };
