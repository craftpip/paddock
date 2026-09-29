const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Plan 65 1c — the three activity clocks on a SINGLE agent. `buildAgent`
// hardcoded all three to `null` and only the fleet listing copied two of them
// back from SQLite afterwards, so `get_agent` on a perfectly running pad
// answered `created_at: null, updated_at: null, last_activity_at: null` — a row
// that reads as "this pad has never existed and has never done anything". That
// is a lie on the surface an LLM reads one pad at a time, and it was invisible
// in the listing because the listing patched it after the fact.
describe('Agent Registry - plan 65: the three activity clocks (1c)', () => {
  // A throwaway DB and a throwaway instance dir, so this never reads the real
  // fleet. BOTH env vars must be set BEFORE the module loads: the paths are
  // read at module load, so setting them later does nothing.
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-registry-'));
  process.env.PAD_DB_PATH = path.join(dir, 'registry.test.db');
  process.env.WORKSPACE_ROOT = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

  const { getDb } = require('../services/db');
  const registry = require('../services/agent-registry');
  const NAME = `${process.env.CONTAINER_PREFIX || 'vm'}-clocked`;

  function seedPad(overrides = {}) {
    const vmDir = path.join(dir, 'instances', NAME);
    fs.mkdirSync(vmDir, { recursive: true });
    fs.writeFileSync(path.join(vmDir, 'meta.env'), 'AGENT_TYPE=opencode\n');
    getDb().prepare(
      `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, created_at, updated_at, last_activity_at)
       VALUES (?, ?, 'opencode', 'docker', ?, 'running', ?, ?, ?)`
    ).run(
      NAME, NAME, NAME,
      overrides.created_at || '2026-01-02T03:04:05.000Z',
      overrides.updated_at || '2026-01-03T03:04:05.000Z',
      overrides.last_activity_at === undefined ? '2026-01-04T03:04:05.000Z' : overrides.last_activity_at
    );
  }

  it('a single-agent read carries all three clocks, not three nulls', () => {
    seedPad();
    const a = registry.getAgent(NAME);
    assert.ok(a, 'the pad resolves');
    assert.strictEqual(a.created_at, '2026-01-02T03:04:05.000Z', 'created_at is real');
    assert.strictEqual(a.updated_at, '2026-01-03T03:04:05.000Z', 'updated_at is real — it was ALWAYS null here');
    assert.strictEqual(a.last_activity_at, '2026-01-04T03:04:05.000Z', 'last_activity_at is real');
  });

  it('the detail read and the listing agree, because both read the same place', () => {
    // The old code had the listing copy two clocks back from a second query
    // after `buildAgent` had already answered. Two places reading one fact is
    // how they came to disagree; the control is that they now cannot.
    seedPad();
    const single = registry.getAgent(NAME);
    const listed = registry.discoverAgents().find((x) => x.name === NAME);
    assert.ok(listed, 'the pad is in the listing');
    assert.strictEqual(single.created_at, listed.created_at, 'created_at agrees');
    assert.strictEqual(single.updated_at, listed.updated_at, 'updated_at agrees — the listing used to LOSE this one');
    assert.strictEqual(single.last_activity_at, listed.last_activity_at, 'last_activity_at agrees');
  });

  it('a pad with NO recorded activity OMITS last_activity_at rather than printing a null', () => {
    // `last_activity_at` is written only by `recordActivity`, so a pad that has
    // never recorded an event genuinely has no answer — and a null reads as a
    // timestamp of zero ("the epoch"), which is a fact nobody recorded. An
    // absent key is the honest shape; the other two ARE known, so they stay.
    seedPad({ last_activity_at: null });
    const a = registry.getAgent(NAME);
    assert.ok(!('last_activity_at' in a), 'the unknown clock is absent, not null');
    assert.strictEqual(a.created_at, '2026-01-02T03:04:05.000Z', 'the known clocks still answer');
  });

  it('a pad with no DB row at all still resolves, and invents nothing', () => {
    // The control on the test above: if `dbStamps` returned `undefined` values
    // rather than `null`, "omit the unknown" could be passing because nothing
    // was ever there. This pad has a dir but no row.
    const vmDir = path.join(dir, 'instances', `${process.env.CONTAINER_PREFIX || 'vm'}-ghostpad`);
    fs.mkdirSync(vmDir, { recursive: true });
    fs.writeFileSync(path.join(vmDir, 'meta.env'), 'AGENT_TYPE=opencode\n');
    const ghost = registry.getAgent(`${process.env.CONTAINER_PREFIX || 'vm'}-ghostpad`);
    assert.ok(ghost, 'it resolves from the filesystem alone');
    for (const k of ['created_at', 'updated_at', 'last_activity_at']) {
      assert.ok(!(k in ghost), `${k} is absent — no row, no claim`);
    }
  });
});
