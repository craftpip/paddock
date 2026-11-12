/**
 * Turn state for the two drivers whose transcript is a JSONL file per
 * conversation: codex (`rollout-*-<uuid>.jsonl`) and claude (`<uuid>.jsonl`).
 *
 * The runner withholds every automatic send until it can read three things
 * about the ONE conversation it drives: is the newest input still being worked
 * on, which input is newest (an id that changes when a new input lands), and
 * the hash of that input's text (the exact-receipt match). `agent-store.js`
 * answers those from opencode's sqlite; this module answers them from a JSONL
 * transcript, with the same result shape and the same rule: a signal that is
 * missing or unrecognised is `unknown`, never idle.
 *
 * What each store records, measured on this host's own transcripts
 * (2026-11-12, codex-cli 0.101 / 0.121, claude 2.1.317-2.1.322):
 *
 *  - codex brackets every turn: `event_msg/task_started {turn_id}` …
 *    `event_msg/task_complete {turn_id}` or `event_msg/turn_aborted {turn_id,
 *    reason}`. 47 starts, 38 completes + 9 aborts across 17 rollouts — every
 *    turn closed. The human's input is `event_msg/user_message {message}`
 *    (NOT a `response_item` with role user: those carry injected context).
 *  - claude closes a turn with `system/turn_duration`, but only from 2.1.318;
 *    2.1.317 never writes it. So a claude turn with no closing row is
 *    `working` on 2.1.318+ and `unknown` below it. A human input is a
 *    `type: user` row that is not `isMeta`, not `isSidechain` and not a
 *    `tool_result` carrier; `[Request interrupted by user…]` ends a turn as an
 *    interruption.
 *
 * Reads are incremental: a transcript is append-only, so each file keeps its
 * folded state and byte offset, and a poll parses only what was appended
 * since the last one. The receipt wait polls every 300 ms; re-parsing a
 * multi-megabyte claude transcript each time is the cost this avoids.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLAUDE_TURN_MARKER_SINCE = [2, 1, 318];

const hashText = (text) => crypto.createHash('sha256').update(String(text || '').trimEnd()).digest('hex');

function rowAt(row) {
  const t = row.timestamp || (row.payload && row.payload.timestamp);
  if (typeof t !== 'string') return null;
  const n = Date.parse(t);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

function versionAtLeast(v, min) {
  const parts = String(v || '').split('.').map((x) => parseInt(x, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  for (let i = 0; i < 3; i++) {
    if (parts[i] > min[i]) return true;
    if (parts[i] < min[i]) return false;
  }
  return true;
}

// ── folds: (state, row, lineNo) -> state. State is plain data so it caches. ──

function codexInitial() {
  return { input: null, turnId: null, turnOpen: false, lastAt: null };
}

/** `input` is the newest human input: { id, hash, at, turnId, ended, completedAt, reason }. */
function codexFold(s, row, lineNo) {
  const at = rowAt(row);
  if (at) s.lastAt = at;
  if (row.type !== 'event_msg' || !row.payload) return s;
  const p = row.payload;
  if (p.type === 'task_started') {
    s.turnId = p.turn_id || null;
    s.turnOpen = true;
  } else if (p.type === 'user_message' && typeof p.message === 'string') {
    // The line number is the input's id: the file is append-only, so it is
    // stable, and it changes for every new input — including a second input
    // typed into a turn that is still running.
    s.input = { id: `codex:${lineNo}`, hash: hashText(p.message), at, turnId: s.turnOpen ? s.turnId : null, ended: null, completedAt: null, reason: null };
  } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
    if (s.input && !s.input.ended && s.input.turnId && p.turn_id === s.input.turnId) {
      s.input.ended = p.type === 'task_complete' ? 'complete' : 'aborted';
      s.input.completedAt = (p.completed_at && Number.isFinite(p.completed_at) ? new Date(p.completed_at * 1000).toISOString() : null) || at;
      s.input.reason = p.reason || null;
    }
    if (p.turn_id === s.turnId) s.turnOpen = false;
  }
  return s;
}

function claudeInitial() {
  return { input: null, version: null, sawTurnMarker: false, lastAt: null };
}

function claudeHumanText(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || !row.message) return null;
  const c = row.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return null;
  return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

function claudeFold(s, row) {
  if (row.isSidechain) return s; // a subagent's turns are not the conversation's
  const at = rowAt(row);
  if (at) s.lastAt = at;
  if (row.version) s.version = row.version;
  if (row.type === 'system' && row.subtype === 'turn_duration') {
    s.sawTurnMarker = true;
    if (s.input && !s.input.ended) { s.input.ended = 'complete'; s.input.completedAt = at; }
    return s;
  }
  const text = claudeHumanText(row);
  if (text == null) return s;
  if (/^\[Request interrupted by user/.test(text.trim())) {
    if (s.input && !s.input.ended) { s.input.ended = 'aborted'; s.input.completedAt = at; s.input.reason = 'interrupted'; }
    return s;
  }
  // A slash command's wrapper rows are the CLI talking, not a turn.
  if (/^<(command-name|command-message|local-command-|bash-)/.test(text.trim())) return s;
  s.input = { id: row.uuid ? `claude:${row.uuid}` : null, hash: hashText(text), at, ended: null, completedAt: null, reason: null };
  return s;
}

const DRIVERS = {
  codex: { initial: codexInitial, fold: codexFold },
  claude: { initial: claudeInitial, fold: claudeFold },
};

// ── incremental file cache ──────────────────────────────────────────────────

const cache = new Map(); // file -> { ino, offset, lines, rest, state, driver }

function foldFile(file, driver) {
  const spec = DRIVERS[driver];
  const st = fs.statSync(file);
  let entry = cache.get(file);
  if (!entry || entry.driver !== driver || entry.ino !== st.ino || st.size < entry.offset) {
    entry = { ino: st.ino, offset: 0, lines: 0, rest: '', state: spec.initial(), driver };
  }
  if (st.size > entry.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - entry.offset);
      fs.readSync(fd, buf, 0, buf.length, entry.offset);
      entry.offset = st.size;
      const text = entry.rest + buf.toString('utf8');
      const parts = text.split('\n');
      // The last piece has no newline yet: a row being written. Keep it for
      // the next read instead of parsing half a JSON object.
      entry.rest = parts.pop();
      for (const line of parts) {
        entry.lines++;
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        entry.state = spec.fold(entry.state, row, entry.lines);
      }
    } finally { fs.closeSync(fd); }
  }
  cache.set(file, entry);
  return entry.state;
}

// ── locating the ONE file for a conversation ────────────────────────────────

const fileOf = new Map(); // `${base}\0${sessionId}` -> file

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'subagents') walk(abs, out, depth + 1); }
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(abs);
  }
  return out;
}

/** The transcript file whose NAME carries the conversation id — an exact
 *  match only. A conversation with no file yet is `null`, never "the newest
 *  file", which would be a different conversation answered with confidence. */
function locateConversation(base, driver, sessionId) {
  const key = `${base}\0${sessionId}`;
  const known = fileOf.get(key);
  if (known && fs.existsSync(known)) return known;
  const want = driver === 'claude' ? `${sessionId}.jsonl` : `-${sessionId}.jsonl`;
  const hit = walk(base).find((f) => (driver === 'claude' ? path.basename(f) === want : path.basename(f).endsWith(want)));
  if (hit) fileOf.set(key, hit);
  return hit || null;
}

const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** readTurn for codex/claude. Same shape as the opencode reader:
 *  { state: idle|working|unknown, reason, userId, inputHash, progressAt, completedAt, outcome? } */
function readJsonlTurn(base, driver, sessionId) {
  const unknown = (reason) => ({ state: 'unknown', reason, userId: null, progressAt: null });
  if (!DRIVERS[driver]) return unknown(`Turn-completion observation unavailable for ${driver}`);
  if (!SAFE_ID.test(String(sessionId || ''))) return unknown('Worker conversation id is not a transcript id');
  if (!fs.existsSync(base)) return unknown('Worker store unavailable');
  const file = locateConversation(base, driver, sessionId);
  if (!file) return unknown('Exact worker conversation not found');
  let s;
  try { s = foldFile(file, driver); } catch { return unknown('Worker turn state unreadable'); }
  const input = s.input;
  if (!input) return { state: 'idle', reason: 'New conversation has no input', userId: null, progressAt: s.lastAt, completedAt: null };
  if (!input.id) return unknown('Newest input carries no id');
  const base2 = { userId: input.id, inputHash: input.hash, progressAt: s.lastAt, completedAt: input.completedAt };
  if (input.ended === 'complete') return { ...base2, state: 'idle', reason: 'Current turn completed' };
  if (input.ended === 'aborted') return { ...base2, state: 'idle', outcome: 'error', reason: 'Worker turn interrupted or failed — explicit recovery required' };
  if (driver === 'codex') {
    if (!input.turnId) return { ...base2, state: 'unknown', reason: 'Input is outside a recorded codex turn' };
    return { ...base2, state: 'working', reason: 'Waiting for current turn' };
  }
  // claude: an open turn is only "working" on a CLI that writes the closing row.
  const marks = s.sawTurnMarker || versionAtLeast(s.version, CLAUDE_TURN_MARKER_SINCE) === true;
  if (!marks) return { ...base2, state: 'unknown', reason: `claude ${s.version || '(unknown version)'} writes no turn-end marker (needs 2.1.318 or newer)` };
  return { ...base2, state: 'working', reason: 'Waiting for current turn' };
}

/** Does a transcript file exist for this id? true / false, or null when the
 *  store itself cannot be read (unknown is not absent). */
function hasTranscript(base, driver, sessionId) {
  if (!DRIVERS[driver] || !SAFE_ID.test(String(sessionId || ''))) return null;
  if (!fs.existsSync(base)) return null;
  return !!locateConversation(base, driver, sessionId);
}

function _resetForTests() { cache.clear(); fileOf.clear(); }

module.exports = { readJsonlTurn, hasTranscript, hashText, versionAtLeast, _resetForTests };
