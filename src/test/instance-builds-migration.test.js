const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plan 115: the boot migration `ensureInstanceBuilds` must not invent a pad out
// of a dir that has no meta.env. Point WORKSPACE_ROOT at a throwaway tree BEFORE
// vm-manager loads (INSTANCES_DIR is computed at require time).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-builds-mig-'));
process.env.WORKSPACE_ROOT = WS;
process.env.CONTAINER_PREFIX = 'pad';
process.env.PAD_DB_PATH = path.join(WS, 'app.db');
const INST = path.join(WS, 'instances');

// Not a pad: only a stray agent data dir, exactly the fresh-clone shape.
fs.mkdirSync(path.join(INST, 'pad-ghost', 'opencode'), { recursive: true });
fs.writeFileSync(path.join(INST, 'pad-ghost', 'opencode', 'opencode.json'), '{}');
// A real (legacy, pre-build-dir) pad: has meta.env.
fs.mkdirSync(path.join(INST, 'pad-real', 'opencode'), { recursive: true });
fs.writeFileSync(path.join(INST, 'pad-real', 'meta.env'), 'AGENT=opencode\n');

const vm = require('../services/vm-manager');

after(() => fs.rmSync(WS, { recursive: true, force: true }));

describe('ensureInstanceBuilds', () => {
  it('skips a dir without meta.env and writes nothing into it', async () => {
    const r = await vm.ensureInstanceBuilds();
    assert.ok(r.skipped.includes('pad-ghost (no meta.env)'), JSON.stringify(r));
    assert.deepStrictEqual(fs.readdirSync(path.join(INST, 'pad-ghost')).sort(), ['opencode']);
  });

  it('positive twin: a dir WITH meta.env is still seeded', () => {
    // Same run as above — proves the fixture reaches the seeding code, so the
    // negative is not vacuous.
    assert.ok(fs.existsSync(path.join(INST, 'pad-real', 'build')), 'pad-real was not seeded');
  });
});
