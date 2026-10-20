const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { readTurn, readUsageEvidence } = require('../services/agent-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-turn-'));
const file = path.join(root, 'data/opencode/opencode.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.exec('CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE part(id TEXT,message_id TEXT,data TEXT,time_updated INTEGER);');
const agent = { agent_type: 'opencode', workspace_root: root };
const at = Date.now() - 10000;
function message(id, role, extra = {}, created = at, updated = created) {
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, 's', JSON.stringify({ role, ...extra }), created, updated);
}
function part(id, messageId, data, updated = at) {
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(id, messageId, JSON.stringify(data), updated);
}
beforeEach(() => {
  db.exec('DELETE FROM session; DELETE FROM message; DELETE FROM part;');
  db.prepare('INSERT INTO session VALUES (?)').run('s');
});
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('runner exact turn observation', () => {
  it('matches pasted instructions despite OpenCode trailing separator whitespace', () => {
    message('u', 'user');
    part('input', 'u', { type: 'text', text: 'Continue α  \n' });
    const hash = require('crypto').createHash('sha256').update('Continue α').digest('hex');
    assert.equal(readTurn(agent, 's').inputHash, hash);
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify({ type: 'text', text: 'Continue β ' }), 'input');
    assert.notEqual(readTurn(agent, 's').inputHash, hash);
  });
  it('a genuinely empty exact conversation is idle; an absent identity is unknown', () => {
    assert.equal(readTurn(agent, 's').state, 'idle');
    assert.equal(readTurn(agent, 'other').state, 'unknown');
    assert.equal(readTurn(agent, null).state, 'unknown');
  });
  it('a user input waiting for its assistant is working', () => {
    message('u', 'user');
    assert.equal(readTurn(agent, 's').state, 'working');
  });
  it('reasoning/streaming without a running tool remains working', () => {
    message('u', 'user');
    message('a', 'assistant', { parentID: 'u', time: { created: at + 1 } }, at + 1);
    part('p', 'a', { type: 'reasoning', time: { start: at + 1 } });
    assert.equal(readTurn(agent, 's').state, 'working');
  });
  it('a completed tool-calls step is NOT an ended turn', () => {
    message('u', 'user');
    message('a', 'assistant', { parentID: 'u', finish: 'tool-calls', time: { completed: at + 2 } }, at + 1);
    part('p', 'a', { type: 'tool', state: { status: 'completed' } });
    assert.equal(readTurn(agent, 's').state, 'working');
  });
  it('a pending parallel tool prevents a stop message from claiming idle', () => {
    message('u', 'user');
    message('a', 'assistant', { parentID: 'u', finish: 'stop', time: { completed: at + 2 } }, at + 1);
    part('p', 'a', { type: 'tool', state: { status: 'pending' } });
    assert.equal(readTurn(agent, 's').state, 'working');
  });
  it('a completed stop for the current input establishes idle and an exact receipt hash', () => {
    message('u', 'user');
    part('input', 'u', { type: 'text', text: 'Continue α' });
    message('a', 'assistant', { parentID: 'u', finish: 'stop', time: { completed: at + 2 } }, at + 1, at + 2);
    const turn = readTurn(agent, 's');
    assert.equal(turn.state, 'idle');
    assert.equal(turn.inputHash, require('crypto').createHash('sha256').update('Continue α').digest('hex'));
    assert.equal(turn.completedAt, new Date(at + 2).toISOString());
    assert.equal(readTurn(agent, 's').progressAt, turn.progressAt, 'polling does not advance progress');
  });
  it('a human input after the last finished turn makes the conversation working again', () => {
    message('u', 'user');
    message('a', 'assistant', { parentID: 'u', finish: 'stop', time: { completed: at + 2 } }, at + 1);
    message('u2', 'user', {}, at + 3);
    assert.equal(readTurn(agent, 's').state, 'working');
  });
  it('a mismatched parent or compaction summary cannot establish idle', () => {
    message('u', 'user');
    message('a', 'assistant', { parentID: 'other', finish: 'stop', time: { completed: at + 2 } }, at + 1);
    assert.equal(readTurn(agent, 's').state, 'unknown');
    db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify({ role: 'assistant', parentID: 'u', summary: true, finish: 'stop', time: { completed: at + 2 } }), 'a');
    assert.equal(readTurn(agent, 's').state, 'unknown');
  });
  it('an aborted turn is a terminal error, not permission for automatic continuation', () => {
    message('u', 'user');
    message('a', 'assistant', { parentID: 'u', error: { name: 'MessageAbortedError' }, time: { completed: at + 2 } }, at + 1);
    assert.equal(readTurn(agent, 's').outcome, 'error');
  });
  it('unsupported drivers or unreadable stores are unknown, never guessed idle', () => {
    assert.equal(readTurn({ ...agent, agent_type: 'codex' }, 's').state, 'unknown');
    assert.equal(readTurn({ ...agent, workspace_root: root + '/missing' }, 's').state, 'unknown');
  });
});

// Plan 92 §Phase 3 / plan 75 row 8: the measured usage-exhaustion signature.
// The captured failure was [user, assistant(out=0), user] (newest is user, last
// assistant produced nothing); the healthy control ended in user too but its
// last assistant produced tokens. The reader is a TRI-STATE and must WITHHOLD
// (unknown) when it cannot tell — never fold "could not read" into "exhausted".
describe('runner usage-exhaustion evidence (plan 75 row 8)', () => {
  it('the captured failing shape (newest user, last assistant output 0) is exhausted', () => {
    message('u1', 'user');
    message('a1', 'assistant', { tokens: { output: 0 } }, at + 1);
    message('u2', 'user', {}, at + 2);
    const r = readUsageEvidence(agent, 's');
    assert.equal(r.state, 'exhausted');
    assert.equal(r.evidence.newestRole, 'user');
    assert.equal(r.evidence.assistantOutputTokens, 0);
  });
  it('the healthy control (newest user, last assistant produced tokens) is ok', () => {
    message('u1', 'user');
    message('a1', 'assistant', { tokens: { output: 669 } }, at + 1);
    message('u2', 'user', {}, at + 2);
    assert.equal(readUsageEvidence(agent, 's').state, 'ok');
  });
  it('an empty newest assistant step cannot re-arm the quota episode', () => {
    message('u1', 'user');
    message('a1', 'assistant', { tokens: { output: 0 } }, at + 1);
    assert.equal(readUsageEvidence(agent, 's').state, 'unknown');
  });
  it('a newest assistant with real output can establish recovery', () => {
    message('u1', 'user');
    message('a1', 'assistant', { tokens: { output: 123 } }, at + 1);
    assert.equal(readUsageEvidence(agent, 's').state, 'ok');
  });
  it('a user with an unreadable token field is unknown, not exhausted', () => {
    message('u1', 'user');
    message('a1', 'assistant', {}, at + 1); // assistant with no tokens object
    message('u2', 'user', {}, at + 2);
    const r = readUsageEvidence(agent, 's');
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /token count/);
  });
  it('a conversation with no user input is ok (nothing to answer)', () => {
    assert.equal(readUsageEvidence(agent, 's').state, 'ok');
    message('a1', 'assistant', { tokens: { output: 0 } }, at + 1);
    assert.equal(readUsageEvidence(agent, 's').state, 'ok');
  });
  it('a missing conversation, unsupported driver or unreadable store is unknown', () => {
    assert.equal(readUsageEvidence(agent, 'other').state, 'unknown');
    assert.equal(readUsageEvidence({ ...agent, agent_type: 'codex' }, 's').state, 'unknown');
    assert.equal(readUsageEvidence({ ...agent, workspace_root: root + '/missing' }, 's').state, 'unknown');
    assert.equal(readUsageEvidence(agent, null).state, 'unknown');
  });
});
