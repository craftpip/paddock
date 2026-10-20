/** Plan 83 Phase 6 — the QUEUE.md contract, verified against its spec.
 *
 *  Phase 5 shipped the queue parser (`parseQueue`), the aggregate-state machine
 *  (`queueAggregateState`), and the CAS writer (`writeQueue`) with NO tests. This
 *  suite is the verification half of plan 83: it encodes §"Parser and aggregate
 *  status" (plans/83-infinite-runner.md lines 206-230) as executable assertions,
 *  one per clause, so a future edit that quietly changes a refusal code or folds
 *  "cannot read" into "nothing to do" goes red.
 *
 *  The parser and the aggregate are pure, so most of this runs with no
 *  filesystem. `readQueue`/`writeQueue` need a real project layout, so a throwaway
 *  workspace on disk is used exactly like plan-mcp.test.js — the file format is
 *  only proven by what is actually written and read back.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-queue-'));
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-queue-db-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'queue.test.db');
process.on('exit', () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
});

const plans = require('../services/plans');
const {
  PlansError, QUEUE_MARKERS, QUEUE_VERSION, QUEUE_ITEM_STATUSES,
  parseQueue, queueAggregateState, queueTemplate, queuePath, queueHash, QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES,
  readQueue, writeQueue, ensureQueue, queueSummary,
} = plans;

const PAD = 'pad-queue-a';
const agent = () => ({
  id: PAD, name: PAD, display_name: 'Queue A', agent_type: 'opencode',
  runtime_type: 'docker', runtime_ref: PAD, status: 'running',
  workspace_root: path.join(WS, 'a-data'),
  workspace_mount: null,
  workspace_dir: '/root/.opencode/workspace',
});
const project = (over = {}) => ({
  id: 'prj_q1', name: 'qproj', agent_name: PAD, agent_type: 'opencode',
  folder: '/root/.opencode/workspace', plans_folder: 'plans', ...over,
});
const QUEUE = path.join(WS, 'a-data', 'workspace', 'plans', 'QUEUE.md');

/** Build a raw QUEUE.md body around a JSON block, the way the app writes it. */
function rawQueue(items, { version = QUEUE_VERSION, customInstructions = undefined } = {}) {
  const value = { version, items };
  if (customInstructions !== undefined) value.customInstructions = customInstructions;
  return [
    QUEUE_MARKERS.start,
    '```json',
    JSON.stringify(value, null, 2),
    '```',
    QUEUE_MARKERS.end,
    '',
  ].join('\n');
}
const mk = (id, status = 'new', reason = '', plan) => ({
  id, plan: plan || `${id}.md`, status, reason,
});

/** Assert a PlansError with the given machine code. */
function assertCode(fn, code, label) {
  assert.throws(fn, (e) => e instanceof PlansError && e.code === code, label || `expected ${code}`);
}

describe('plan 83 — queue parser structure', () => {
  it('the generated template is itself a valid, empty queue', () => {
    const raw = queueTemplate(agent(), project());
    const parsed = parseQueue(raw);
    assert.equal(parsed.version, QUEUE_VERSION);
    assert.deepEqual(parsed.items, [], 'a new queue starts empty, not with an example task');
    assert.match(parsed.hash, /^[0-9a-f]{64}$/, 'hash is a sha-256 hex digest');
  });

  it('parses a valid multi-item queue preserving order', () => {
    const parsed = parseQueue(rawQueue([
      mk('q-001', 'done'),
      mk('q-002', 'in progress'),
      mk('q-003', 'new'),
    ]));
    assert.deepEqual(parsed.items.map((i) => i.id), ['q-001', 'q-002', 'q-003']);
    assert.equal(parsed.items[1].status, 'in progress');
  });

  it('the content hash is deterministic and changes with content', () => {
    const a = rawQueue([mk('q-001')]);
    const b = rawQueue([mk('q-001')]);
    const c = rawQueue([mk('q-002')]);
    assert.equal(queueHash(a), queueHash(b), 'same bytes → same hash');
    assert.notEqual(queueHash(a), queueHash(c), 'different items → different hash');
  });

  it('rejects missing markers', () => {
    assertCode(() => parseQueue('no markers here'), 'queue_markers_missing');
    assertCode(() => parseQueue(`${QUEUE_MARKERS.start}\n\`\`\`json\n{}\n\`\`\`\n`), 'queue_markers_missing');
  });

  it('rejects an unfenced JSON block', () => {
    const raw = `${QUEUE_MARKERS.start}\n{"version":1,"items":[]}\n${QUEUE_MARKERS.end}\n`;
    assertCode(() => parseQueue(raw), 'queue_json_fence_missing');
  });

  it('rejects invalid JSON', () => {
    const raw = `${QUEUE_MARKERS.start}\n\`\`\`json\n{ not json }\n\`\`\`\n${QUEUE_MARKERS.end}\n`;
    assertCode(() => parseQueue(raw), 'queue_json_invalid');
  });

  it('rejects an unsupported version', () => {
    assertCode(() => parseQueue(rawQueue([], { version: 2 })), 'queue_version_unsupported');
  });

  it('rejects a missing items array', () => {
    const raw = `${QUEUE_MARKERS.start}\n\`\`\`json\n${JSON.stringify({ version: 1 })}\n\`\`\`\n${QUEUE_MARKERS.end}\n`;
    assertCode(() => parseQueue(raw), 'queue_items_missing');
  });

  it('rejects a non-object item', () => {
    // Build the array by hand because `mk` cannot produce a scalar.
    const raw = `${QUEUE_MARKERS.start}\n\`\`\`json\n${JSON.stringify({ version: 1, items: ['nope'] })}\n\`\`\`\n${QUEUE_MARKERS.end}\n`;
    assertCode(() => parseQueue(raw), 'queue_item_invalid');
  });

  it('rejects a missing or empty id', () => {
    assertCode(() => parseQueue(rawQueue([{ plan: 'a.md', status: 'new', reason: '' }])), 'queue_item_invalid');
    assertCode(() => parseQueue(rawQueue([mk('', 'new')])), 'queue_item_invalid');
  });

  it('rejects a duplicate id', () => {
    assertCode(() => parseQueue(rawQueue([mk('q-1'), mk('q-1')])), 'queue_duplicate_id');
  });

  it('rejects a missing plan path', () => {
    assertCode(() => parseQueue(rawQueue([{ id: 'q-1', status: 'new', reason: '' }])), 'queue_item_invalid');
  });

  it('rejects an absolute or escaping plan path', () => {
    assertCode(() => parseQueue(rawQueue([mk('q-1', 'new', '', '/etc/passwd')])), 'queue_plan_path_invalid');
    assertCode(() => parseQueue(rawQueue([mk('q-1', 'new', '', '../secret.md')])), 'queue_plan_path_invalid');
  });

  it('rejects an unknown status', () => {
    assertCode(() => parseQueue(rawQueue([mk('q-1', 'finished')])), 'queue_item_invalid');
  });

  it('rejects a missing or non-string reason', () => {
    assertCode(() => parseQueue(rawQueue([{ id: 'q-1', plan: 'a.md', status: 'new' }])), 'queue_item_invalid');
    assertCode(() => parseQueue(rawQueue([{ id: 'q-1', plan: 'a.md', status: 'new', reason: 5 }])), 'queue_item_invalid');
  });

  it('requires a nonempty reason exactly for need input', () => {
    assertCode(() => parseQueue(rawQueue([mk('q-1', 'need input', '')])), 'queue_item_invalid');
    // and refuses a stale reason left on a non-blocked item
    assertCode(() => parseQueue(rawQueue([mk('q-1', 'new', 'why am I here')])), 'queue_item_invalid');
    // the valid shapes on both sides
    assert.equal(parseQueue(rawQueue([mk('q-1', 'need input', 'waiting on a human')])).items[0].status, 'need input');
    assert.equal(parseQueue(rawQueue([mk('q-1', 'new', '')])).items[0].status, 'new');
  });

  it('rejects an unexpected extra field', () => {
    assertCode(
      () => parseQueue(rawQueue([{ id: 'q-1', plan: 'a.md', status: 'new', reason: '', extra: 1 }])),
      'queue_item_invalid'
    );
  });

  it('accepts multiple in-progress items and returns both', () => {
    const parsed = parseQueue(rawQueue([mk('q-1', 'in progress'), mk('q-2', 'in progress')]));
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0].status, 'in progress');
    assert.equal(parsed.items[1].status, 'in progress');
  });

  it('round-trips optional multiline Unicode and Markdown custom instructions', () => {
    const customInstructions = 'Use \u00e9moji literals: \u5b89\u5168\n```md\n{{not a template}}\n```';
    const raw = rawQueue([], { customInstructions });
    const parsed = parseQueue(raw);
    assert.equal(parsed.customInstructions, customInstructions);
  });

  it('rejects malformed or oversized custom instructions', () => {
    assertCode(() => parseQueue(rawQueue([], { customInstructions: 3 })), 'queue_custom_instructions_invalid');
    assertCode(() => parseQueue(rawQueue([], { customInstructions: 'x'.repeat(QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES + 1) })), 'queue_custom_instructions_too_large');
  });

  it('exposes the four allowed statuses it enforces', () => {
    assert.deepEqual([...QUEUE_ITEM_STATUSES], ['new', 'in progress', 'need input', 'done']);
  });
});

describe('plan 83 — queue aggregate state', () => {
  const state = (items) => queueAggregateState(parseQueue(rawQueue(items)));

  it('a valid EMPTY queue is done, and an untouched NONEMPTY queue is new', () => {
    // Spec §"Parser and aggregate status": "Valid empty queue, or all items done
    // → done" and "An untouched nonempty queue → new". These are different
    // questions and the empty case is the one a fresh QUEUE.md hits.
    assert.equal(state([]).state, 'done', 'empty queue has nothing left to do');
    assert.equal(state([mk('q-1', 'new')]).state, 'new', 'work exists but has not started');
  });

  it('all items done → done', () => {
    assert.equal(state([mk('q-1', 'done'), mk('q-2', 'done')]).state, 'done');
  });

  it('an in-progress item → in progress', () => {
    assert.equal(state([mk('q-1', 'done'), mk('q-2', 'in progress')]).state, 'in progress');
  });

  it('done plus remaining new work (no in-progress) → in progress', () => {
    assert.equal(state([mk('q-1', 'done'), mk('q-2', 'new')]).state, 'in progress');
  });

  it('any need input wins, regardless of position', () => {
    assert.equal(state([mk('q-1', 'done'), mk('q-2', 'need input', 'blocked'), mk('q-3', 'new')]).state, 'need input');
    const s = queueAggregateState(parseQueue(rawQueue([mk('q-1', 'need input', 'blocked')])));
    assert.equal(s.needInputItem.id, 'q-1', 'and it names the blocking item');
  });

  it('need input outranks in progress', () => {
    assert.equal(state([mk('q-1', 'in progress'), mk('q-2', 'need input', 'blocked')]).state, 'need input');
  });
});

describe('plan 83 — queue file read/write (CAS)', () => {
  before(() => {
    fs.rmSync(QUEUE, { recursive: true, force: true });
  });
  after(() => {
    fs.rmSync(QUEUE, { recursive: true, force: true });
  });

  it('readQueue reports a MISSING queue as invalid/unavailable, never done', async () => {
    fs.rmSync(QUEUE, { force: true });
    const r = await readQueue(agent(), project());
    // Spec: "Missing, unreadable, malformed, or unsupported queue →
    // invalid/unavailable, never done."
    assert.equal(r.aggregate.state, 'invalid');
    assert.equal(r.hash, null);
    assert.ok(r.aggregate.reason, 'the state carries a reason, not a bare shrug');
  });

  it('readQueue reports a MALFORMED queue as invalid instead of throwing', async () => {
    fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
    fs.writeFileSync(QUEUE, 'not a queue at all\n');
    // The supervisor's own code branches on `aggregate.state === 'invalid'`, so a
    // throw here is that branch never running — the runner silently stops
    // progressing with only a log line.
    const r = await readQueue(agent(), project());
    assert.equal(r.aggregate.state, 'invalid');
    assert.equal(r.hash, null);
  });

  it('keeps a read-only repair preview when duplicate IDs make valid JSON malformed', async () => {
    fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
    fs.writeFileSync(QUEUE, rawQueue([mk('duplicated'), mk('duplicated', 'done')]));
    const r = await readQueue(agent(), project());
    assert.equal(r.condition, 'malformed');
    assert.deepEqual(r.repairItems.map((item) => item.id), ['duplicated', 'duplicated']);
    assert.deepEqual(r.repairDuplicateIds, ['duplicated']);
    assert.deepEqual(r.parsed.items, [], 'repair preview is never a valid scheduling input');
  });

  it('writeQueue then readQueue round-trips, and the file uses the markers', async () => {
    fs.rmSync(QUEUE, { force: true });
    const written = await writeQueue(agent(), project(), [mk('q-1', 'new')], null);
    assert.match(written.hash, /^[0-9a-f]{64}$/);
    const onDisk = fs.readFileSync(QUEUE, 'utf8');
    assert.ok(onDisk.includes(QUEUE_MARKERS.start) && onDisk.includes(QUEUE_MARKERS.end), 'the markers fence the JSON');
    const r = await readQueue(agent(), project());
    assert.equal(r.hash, written.hash, 'the read hash matches what was written');
    assert.equal(r.parsed.items.length, 1);
    assert.equal(r.aggregate.state, 'new');
  });

  it('writeQueue refuses a stale revision rather than overwriting', async () => {
    fs.rmSync(QUEUE, { force: true });
    const first = await writeQueue(agent(), project(), [mk('q-1', 'new')], null);
    // A second writer with the OLD hash (as if it read before `first`) is refused.
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-2', 'new')], 'stalehash000'),
      (e) => e instanceof PlansError && e.code === 'queue_revision_conflict'
    );
    // And the file still holds the first write, not the loser's.
    const r = await readQueue(agent(), project());
    assert.equal(r.hash, first.hash);
  });

  it('writeQueue validates items before writing (same rules as parseQueue)', async () => {
    fs.rmSync(QUEUE, { force: true });
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1', 'finished')], null),
      (e) => e instanceof PlansError && e.code === 'queue_item_invalid'
    );
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1'), mk('q-1')], null),
      (e) => e instanceof PlansError && e.code === 'queue_duplicate_id'
    );
    assert.ok(!fs.existsSync(QUEUE), 'a refused write leaves no file behind');
  });

  it('queuePath resolves inside the project plans folder', () => {
    assert.equal(queuePath(agent(), project()), QUEUE);
    assert.equal(queuePath(agent(), project({ plans_folder: 'qplans' })), path.join(WS, 'a-data', 'workspace', 'qplans', 'QUEUE.md'));
  });
});

describe('plan 86 — queue setup, prose preservation and fail-closed CAS (§Phase 1)', () => {
  const writeFile = (body) => {
    fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
    fs.writeFileSync(QUEUE, body, 'utf8');
  };

  it('queueSummary projects current/next/blocked/counts — one source of truth', () => {
    const s = queueSummary(parseQueue(rawQueue([
      mk('q-done', 'done'),
      mk('q-cur', 'in progress'),
      mk('q-blocked', 'need input', 'waiting on a human'),
      mk('q-next', 'new'),
    ])));
    assert.equal(s.total, 4);
    assert.deepEqual(s.counts, { total: 4, new: 1, inProgress: 1, needInput: 1, done: 1 });
    assert.equal(s.current.id, 'q-cur');
    assert.equal(s.blocked.id, 'q-blocked');
    assert.equal(s.blocked.reason, 'waiting on a human');
    assert.equal(s.next.id, 'q-next', 'next is the first new item in ARRAY order, not "after current"');
    assert.equal(s.allDone, false);
  });

  it('queueSummary: empty is not allDone, a full done list is', () => {
    const empty = queueSummary(parseQueue(rawQueue([])));
    assert.equal(empty.total, 0);
    assert.equal(empty.current, null);
    assert.equal(empty.next, null);
    assert.equal(empty.blocked, null);
    assert.equal(empty.allDone, false, '"nothing in the list" and "everything done" are different states');
    const done = queueSummary(parseQueue(rawQueue([mk('a', 'done'), mk('b', 'done')])));
    assert.equal(done.total, 2);
    assert.equal(done.allDone, true);
  });

  it('queueSummary warns on multiple in-progress, no warning for zero or one', () => {
    const zero = queueSummary(parseQueue(rawQueue([mk('q-1', 'new'), mk('q-2', 'done')])));
    assert.deepEqual(zero.warnings, [], 'zero in-progress → no warning');
    const one = queueSummary(parseQueue(rawQueue([mk('q-1', 'in progress'), mk('q-2', 'new')])));
    assert.deepEqual(one.warnings, [], 'one in-progress → no warning');
    const two = queueSummary(parseQueue(rawQueue([mk('q-1', 'in progress'), mk('q-2', 'in progress')])));
    assert.equal(two.warnings.length, 1, 'two in-progress → one warning');
    assert.equal(two.warnings[0].code, 'queue_multiple_in_progress');
    assert.deepEqual(two.warnings[0].itemIds, ['q-1', 'q-2'], 'itemIds in array order');
    assert.equal(two.current.id, 'q-1', 'current is the FIRST in-progress item');
    const three = queueSummary(parseQueue(rawQueue([mk('q-1', 'in progress'), mk('q-2', 'in progress'), mk('q-3', 'in progress')])));
    assert.equal(three.warnings.length, 1);
    assert.deepEqual(three.warnings[0].itemIds, ['q-1', 'q-2', 'q-3']);
  });

  it('aggregate state for two in-progress is in progress (not invalid)', () => {
    const s = queueAggregateState(parseQueue(rawQueue([mk('q-1', 'in progress'), mk('q-2', 'in progress')])));
    assert.equal(s.state, 'in progress', 'two in-progress → aggregate is in progress');
    assert.equal(s.inProgressItem.id, 'q-1', 'first in-progress item is current');
  });

  it('writeQueue validates items (same rules) but accepts multiple in-progress', async () => {
    fs.rmSync(QUEUE, { force: true });
    const written = await writeQueue(agent(), project(), [mk('q-1', 'in progress'), mk('q-2', 'in progress')], null);
    assert.match(written.hash, /^[0-9a-f]{64}$/);
    const r = await readQueue(agent(), project());
    assert.equal(r.condition, 'ok');
    assert.equal(r.parsed.items.length, 2);
    assert.equal(r.parsed.items[0].status, 'in progress');
    assert.equal(r.parsed.items[1].status, 'in progress');
    assert.equal(r.summary.warnings.length, 1);
    assert.equal(r.summary.warnings[0].code, 'queue_multiple_in_progress');
  });

  it('writeQueue still rejects genuinely malformed items (unknown status)', async () => {
    fs.rmSync(QUEUE, { force: true });
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1', 'finished')], null),
      (e) => e instanceof PlansError && e.code === 'queue_item_invalid'
    );
    assert.ok(!fs.existsSync(QUEUE), 'a refused write leaves no file behind');
  });

  it('writeQueue PRESERVES prose outside the markers (plan 86 §1)', async () => {
    fs.rmSync(QUEUE, { force: true });
    writeFile([
      '# Queue',
      'The worker reads the FIRST in-progress item, then walks new items in order.',
      QUEUE_MARKERS.start, '```json',
      JSON.stringify({ version: QUEUE_VERSION, items: [mk('q-1', 'new')] }, null, 2),
      '```', QUEUE_MARKERS.end,
      '',
      '## Notes for the human',
      'This is MY personal note, added by hand.',
      '',
    ].join('\n'));
    const r = await readQueue(agent(), project());
    assert.equal(r.condition, 'ok');
    const after = await writeQueue(agent(), project(), [mk('q-1', 'new'), mk('q-2', 'new')], r.hash);
    assert.match(after.hash, /^[0-9a-f]{64}$/);
    const onDisk = fs.readFileSync(QUEUE, 'utf8');
    assert.ok(onDisk.includes('# Queue'), 'manual heading survives');
    assert.ok(onDisk.includes('The worker reads the FIRST in-progress item'), 'manual instruction prose survives');
    assert.ok(onDisk.includes('## Notes for the human'), 'a human-added section survives');
    assert.ok(onDisk.includes('This is MY personal note, added by hand.'), 'the human note text survives');
    const reparsed = parseQueue(onDisk);
    assert.deepEqual(reparsed.items.map((i) => i.id), ['q-1', 'q-2'], 'the new item is really in the block');
  });

  it('CAS fails CLOSED on a malformed current file even with a passed revision', async () => {
    fs.rmSync(QUEUE, { force: true });
    writeFile('no queue markers at all\n### Instructions\n');
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1', 'new')], 'sometext'),
      (e) => e instanceof PlansError && e.code === 'queue_revision_conflict',
      'a queue we cannot parse is one whose content we cannot promise to preserve'
    );
    assert.ok(fs.readFileSync(QUEUE, 'utf8').includes('no queue markers at all'), 'the broken file is untouched');
  });

  it('CAS refuses an explicit update when NO file exists', async () => {
    fs.rmSync(QUEUE, { force: true });
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1', 'new')], 'stalehash000'),
      (e) => e instanceof PlansError && e.code === 'queue_revision_conflict',
      'an absent queue cannot be updated; set it up first'
    );
    assert.ok(!fs.existsSync(QUEUE), 'nothing written');
  });

  it('a revision-less write refuses to overwrite a file it cannot read', async () => {
    fs.rmSync(QUEUE, { force: true });
    writeFile('garbage that is not a queue\n');
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1', 'new')], null),
      (e) => e instanceof PlansError && e.code === 'queue_revision_conflict'
    );
  });

  it('a revision-less write refuses to overwrite a READABLE existing queue (queue_revision_required)', async () => {
    fs.rmSync(QUEUE, { force: true });
    await writeQueue(agent(), project(), [mk('q-1', 'new')], null); // create path only
    const before = fs.readFileSync(QUEUE, 'utf8');
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-1', 'new'), mk('q-2', 'new')], null),
      (e) => e instanceof PlansError && e.code === 'queue_revision_required',
      'updating an existing queue must carry its current revision — a revision-less overwrite is not revision-safe'
    );
    assert.equal(fs.readFileSync(QUEUE, 'utf8'), before, 'the existing queue is untouched');
  });

  it('a revision-less write still works as the true CREATE path (file absent)', async () => {
    fs.rmSync(QUEUE, { force: true });
    const created = await writeQueue(agent(), project(), [mk('q-1', 'new')], null);
    assert.match(created.hash, /^[0-9a-f]{64}$/, 'missing file -> seed from template');
  });

  it('an equal-hash edit is accepted; a genuinely STALE one is refused', async () => {
    fs.rmSync(QUEUE, { force: true });
    await writeQueue(agent(), project(), [mk('q-1', 'new')], null);
    const read1 = await readQueue(agent(), project());
    const ok = await writeQueue(agent(), project(), [mk('q-1', 'new'), mk('q-2', 'new')], read1.hash);
    assert.match(ok.hash, /^[0-9a-f]{64}$/);
    const read2 = await readQueue(agent(), project());
    await assert.rejects(
      () => writeQueue(agent(), project(), [mk('q-9', 'new')], read1.hash),
      (e) => e instanceof PlansError && e.code === 'queue_revision_conflict',
      'reusing the PREVIOUS hash after a later write is stale'
    );
    const after = await readQueue(agent(), project());
    assert.equal(after.hash, read2.hash, 'the winner content survives the loser');
  });

  it('ensureQueue creates ONCE and preserves later human edits', async () => {
    fs.rmSync(QUEUE, { force: true });
    const first = await ensureQueue(agent(), project());
    assert.equal(first.created, true);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    const second = await ensureQueue(agent(), project());
    assert.equal(second.created, false);
    assert.equal(second.hash, first.hash, 'an existing queue is not recreated');
    const before = fs.readFileSync(QUEUE, 'utf8');
    fs.writeFileSync(QUEUE, before.replace('## Worker rules', '## Worker rules\nNobody edits here except via the UI.\n'), 'utf8');
    const third = await ensureQueue(agent(), project());
    assert.equal(third.created, false);
    assert.ok(fs.readFileSync(QUEUE, 'utf8').includes('Nobody edits here except via the UI.'), 'human edit survives a setup pass');
  });

  it('readQueue reports condition for missing / malformed / ok', async () => {
    fs.rmSync(QUEUE, { force: true });
    assert.equal((await readQueue(agent(), project())).condition, 'missing');
    writeFile('severed\n');
    assert.equal((await readQueue(agent(), project())).condition, 'malformed');
    fs.writeFileSync(QUEUE, rawQueue([mk('q-1', 'new')]), 'utf8');
    const ok = await readQueue(agent(), project());
    assert.equal(ok.condition, 'ok');
    assert.equal(ok.summary.total, 1);
    assert.equal(ok.summary.next.id, 'q-1');
  });
});
