// Deleting a PAD may delete its workspace source folder only when that is safe
// (plan 122 #2). The old rule deleted any source under the project root, which
// reached the repository itself, docs/, and folders other PADs still used.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.PAD_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pad-delete-')), 'x.db');
const { workspaceSourceRemoval } = require('../services/vm-manager/lifecycle');

const base = { workspaceRoot: '/workspace', instancesDir: '/workspace/instances', sharedWith: [] };
const decide = (extra) => workspaceSourceRemoval({ ...base, ...extra });

it('removes a folder the create itself made and nobody shares', () => {
  assert.deepEqual(decide({ createdByPaddock: true, view: '/workspace/wstest-a' }), { remove: true, why: '' });
});

it('keeps a folder that existed before the PAD', () => {
  for (const view of ['/workspace/docs', '/workspace/.git', '/workspace/backups', '/workspace/src']) {
    const v = decide({ createdByPaddock: false, view });
    assert.equal(v.remove, false, view);
    assert.match(v.why, /existed before/);
  }
});

it('never removes the project root or anything that contains instances/', () => {
  // Even if the flag says we created it: the flag is one line in a text file.
  assert.equal(decide({ createdByPaddock: true, view: '/workspace' }).remove, false);
  assert.equal(decide({ createdByPaddock: true, view: '/workspace/instances' }).remove, false);
  assert.equal(decide({ createdByPaddock: true, view: '/' }).remove, false);
  assert.equal(decide({ createdByPaddock: true, view: '/workspace/../etc' }).remove, false);
  assert.equal(decide({ createdByPaddock: true, view: '/elsewhere/ws' }).remove, false);
});

it('keeps a folder another PAD still mounts, and says which', () => {
  const v = decide({ createdByPaddock: true, view: '/workspace/shared', sharedWith: ['pad-b'] });
  assert.equal(v.remove, false);
  assert.match(v.why, /pad-b still uses it/);
});

it('keeps a source the control plane cannot see', () => {
  assert.equal(decide({ createdByPaddock: true, view: null }).remove, false);
});
