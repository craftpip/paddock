// Turn state for codex/claude JSONL transcripts (services/jsonl-turn.js). The
// fixtures copy the record SHAPES measured on real transcripts (codex-cli
// 0.121, claude 2.1.317-2.1.322); the content is made up.
const { it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jt = require('../services/jsonl-turn');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-jsonl-turn-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => jt._resetForTests());

const CODEX_ID = '019d9fc5-737c-7320-9bcc-1339c7e0dfc2';
const CLAUDE_ID = 'f508a768-88b6-471d-8d2e-9d3a79ddd868';
let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 12, 10, 0, n++)).toISOString();

function codexFile() {
  const dir = path.join(ROOT, 'codex', '2026', '11', '12');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-11-12T10-00-00-${CODEX_ID}.jsonl`);
}
function claudeFile() {
  const dir = path.join(ROOT, 'claude', '-www-proj');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${CLAUDE_ID}.jsonl`);
}
const write = (file, rows) => fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const append = (file, rows) => fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const ev = (payload) => ({ timestamp: ts(), type: 'event_msg', payload });
const codex = () => jt.readJsonlTurn(path.join(ROOT, 'codex'), 'codex', CODEX_ID);
const claude = () => jt.readJsonlTurn(path.join(ROOT, 'claude'), 'claude', CLAUDE_ID);

it('codex: an open turn is working, task_complete makes it idle, and the hash is the typed text', () => {
  const f = codexFile();
  write(f, [
    { timestamp: ts(), type: 'session_meta', payload: { id: CODEX_ID, cwd: '/w' } },
    ev({ type: 'task_started', turn_id: 't1' }),
    { timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } },
    ev({ type: 'user_message', message: 'do the plan  ' }),
  ]);
  const working = codex();
  assert.equal(working.state, 'working');
  assert.equal(working.inputHash, jt.hashText('do the plan'), 'the human event_msg, trailing space ignored — not the injected context item');
  append(f, [ev({ type: 'token_count' }), ev({ type: 'task_complete', turn_id: 't1', completed_at: 1794477600 })]);
  const idle = codex();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.userId, working.userId, 'the same input, read incrementally');
  assert.ok(idle.completedAt);
});

it('codex: a new input gets a new id, and turn_aborted is an interrupted turn needing recovery', () => {
  const f = codexFile();
  write(f, [ev({ type: 'task_started', turn_id: 't1' }), ev({ type: 'user_message', message: 'a' }), ev({ type: 'task_complete', turn_id: 't1' })]);
  const first = codex();
  append(f, [ev({ type: 'task_started', turn_id: 't2' }), ev({ type: 'user_message', message: 'b' })]);
  const second = codex();
  assert.notEqual(second.userId, first.userId);
  assert.equal(second.state, 'working');
  append(f, [ev({ type: 'turn_aborted', turn_id: 't2', reason: 'interrupted' })]);
  const aborted = codex();
  assert.equal(aborted.state, 'idle');
  assert.equal(aborted.outcome, 'error');
});

it('codex: a completion for a DIFFERENT turn does not close the newest input', () => {
  const f = codexFile();
  write(f, [ev({ type: 'task_started', turn_id: 't1' }), ev({ type: 'user_message', message: 'a' }), ev({ type: 'task_complete', turn_id: 'tOLD' })]);
  assert.equal(codex().state, 'working');
});

it('codex: no input yet is idle with no id; an unknown id is unknown, never another file', () => {
  write(codexFile(), [{ timestamp: ts(), type: 'session_meta', payload: { id: CODEX_ID } }]);
  const empty = codex();
  assert.equal(empty.state, 'idle');
  assert.equal(empty.userId, null);
  const other = jt.readJsonlTurn(path.join(ROOT, 'codex'), 'codex', '00000000-0000-0000-0000-000000000000');
  assert.equal(other.state, 'unknown');
  assert.equal(jt.readJsonlTurn(path.join(ROOT, 'codex'), 'codex', '../etc').state, 'unknown', 'a non-UUID id is refused');
});

const human = (text, extra = {}) => ({ type: 'user', uuid: `u-${n}`, timestamp: ts(), version: '2.1.322', message: { role: 'user', content: text }, ...extra });
const assistant = (stop) => ({ type: 'assistant', uuid: `a-${n}`, timestamp: ts(), version: '2.1.322', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } });
const toolResult = () => ({ type: 'user', uuid: `r-${n}`, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', timestamp: ts(), version: '2.1.322' });

it('claude: working until system/turn_duration; tool results, meta rows and subagents are not inputs', () => {
  const f = claudeFile();
  write(f, [human('run the queue'), assistant('tool_use'), toolResult(), human('caveat', { isMeta: true }), human('subagent ask', { isSidechain: true })]);
  const working = claude();
  assert.equal(working.state, 'working');
  assert.equal(working.inputHash, jt.hashText('run the queue'));
  append(f, [assistant('end_turn'), turnEnd()]);
  const idle = claude();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.userId, working.userId);
});

it('claude: an interruption ends the turn as an error; a slash command is not a new input', () => {
  const f = claudeFile();
  write(f, [human('long job'), assistant('tool_use'), human('[Request interrupted by user for tool use]'), human('<command-name>/model</command-name>')]);
  const r = claude();
  assert.equal(r.state, 'idle');
  assert.equal(r.outcome, 'error');
  assert.equal(r.inputHash, jt.hashText('long job'));
});

it('claude: a CLI older than 2.1.318 writes no turn-end row, so an open turn is UNKNOWN, not working', () => {
  const f = claudeFile();
  write(f, [{ ...human('hi'), version: '2.1.317' }, { ...assistant('end_turn'), version: '2.1.317' }]);
  const r = claude();
  assert.equal(r.state, 'unknown');
  assert.match(r.reason, /2\.1\.318/);
});

it('a half-written last line is held back, not parsed', () => {
  const f = claudeFile();
  write(f, [human('a')]);
  fs.appendFileSync(f, '{"type":"system","subtype":"turn_dur');
  assert.equal(claude().state, 'working');
  fs.appendFileSync(f, 'ation","timestamp":"2026-11-12T10:59:00.000Z"}\n');
  assert.equal(claude().state, 'idle', 'the completed line is read on the next poll');
});

it('hasTranscript: true for a file, false for none, null when the store is unreadable', () => {
  write(claudeFile(), [human('a')]);
  assert.equal(jt.hasTranscript(path.join(ROOT, 'claude'), 'claude', CLAUDE_ID), true);
  assert.equal(jt.hasTranscript(path.join(ROOT, 'claude'), 'claude', '11111111-1111-1111-1111-111111111111'), false);
  assert.equal(jt.hasTranscript(path.join(ROOT, 'nope'), 'claude', CLAUDE_ID), null);
});

// Plan 126: which rollout did a fresh, id-less codex Mission session become?
function rollout(id, { cwd = '/w/proj', at = '2026-11-13T10:00:10.000Z', mtime = null } = {}) {
  const dir = path.join(ROOT, 'fresh', '2026', '11', '13');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-2026-11-13T10-00-10-${id}.jsonl`);
  write(f, [{ timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd } }, ev({ type: 'task_started', turn_id: 't' })]);
  if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return f;
}
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const FRESH = path.join(ROOT, 'fresh');
const SINCE = '2026-11-13T10:00:00.000Z';
const freshOf = (exclude = []) => jt.findFreshCodexConversation(FRESH, '/w/proj', SINCE, exclude);

it('fresh codex: none until a rollout for this folder appears, then exactly one', () => {
  fs.rmSync(FRESH, { recursive: true, force: true });
  fs.mkdirSync(FRESH, { recursive: true });
  assert.equal(freshOf().state, 'none', 'nobody has typed yet');
  rollout(A, { cwd: '/w/other', mtime: Date.parse('2026-11-13T10:00:20Z') });
  rollout(B, { at: '2026-11-13T09:00:00.000Z', mtime: Date.parse('2026-11-13T09:30:00Z') });
  assert.equal(freshOf().state, 'none', 'another folder, and an older conversation, are not this one');
  rollout(C, { cwd: '/w/proj/', mtime: Date.parse('2026-11-13T10:00:20Z') });
  assert.deepEqual(freshOf(), { state: 'one', id: C });
  assert.equal(freshOf([C]).state, 'none', 'an id another row already owns is not a candidate');
});

it('fresh codex: two candidates are ambiguous, and a missing store is unreadable, never none', () => {
  rollout(A, { mtime: Date.parse('2026-11-13T10:00:30Z') });
  const r = freshOf();
  assert.equal(r.state, 'many');
  assert.deepEqual(r.ids.sort(), [A, C].sort());
  assert.equal(jt.findFreshCodexConversation(path.join(ROOT, 'absent'), '/w/proj', SINCE).state, 'unreadable');
});
