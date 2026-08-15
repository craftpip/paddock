const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('ownership module', () => {
  let tmp;
  const ownership = require('../services/ownership');
  const { USER_UID, USER_GID } = ownership;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ensureOwned chowns a root-owned file to PUID:PGID', (t) => {
    if (process.getuid() !== 0) return t.skip('requires root to chown');
    const p = path.join(tmp, 'f');
    fs.writeFileSync(p, 'x');
    fs.chownSync(p, 0, 0);
    assert.ok(ownership.ensureOwned(p));
    const st = fs.statSync(p);
    assert.strictEqual(st.uid, USER_UID);
    assert.strictEqual(st.gid, USER_GID);
  });

  it('ensureOwned is a no-op (returns false) when already owned', () => {
    const p = path.join(tmp, 'f');
    fs.writeFileSync(p, 'x');
    if (process.getuid() === 0) fs.chownSync(p, USER_UID, USER_GID);
    assert.strictEqual(ownership.ensureOwned(p), false);
  });

  it('ensureOwned never throws on a missing path', () => {
    assert.strictEqual(ownership.ensureOwned(path.join(tmp, 'nope')), false);
  });

  it('normalizeTree recurses and chowns nested dirs and files', (t) => {
    if (process.getuid() !== 0) return t.skip('requires root to chown');
    const d = path.join(tmp, 'a', 'b', 'c');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'x'), 'x');
    fs.chownSync(path.join(tmp, 'a'), 0, 0);
    fs.chownSync(path.join(tmp, 'a', 'b'), 0, 0);
    fs.chownSync(d, 0, 0);
    fs.chownSync(path.join(d, 'x'), 0, 0);
    ownership.normalizeTree(path.join(tmp, 'a'));
    for (const p of [path.join(tmp, 'a'), path.join(tmp, 'a', 'b'), d, path.join(d, 'x')]) {
      const st = fs.statSync(p);
      assert.strictEqual(st.uid, USER_UID, `uid of ${p}`);
      assert.strictEqual(st.gid, USER_GID, `gid of ${p}`);
    }
  });

  it('normalizeTree skipDir prunes a whole subtree', (t) => {
    if (process.getuid() !== 0) return t.skip('requires root to chown');
    const inst = path.join(tmp, 'instances');
    const hermesData = path.join(inst, 'pad-h', 'hermes');
    const otherData = path.join(inst, 'pad-o', 'opencode');
    fs.mkdirSync(hermesData, { recursive: true });
    fs.mkdirSync(otherData, { recursive: true });
    const skip = (dir) => ownership.isSelfManagedAgentData(dir, inst);
    // hermes and opencode dirs are both root-owned
    fs.chownSync(hermesData, 0, 0);
    fs.chownSync(otherData, 0, 0);
    ownership.normalizeTree(inst, skip);
    // hermes data stays root (self-managed), opencode data normalized
    assert.strictEqual(fs.statSync(hermesData).uid, 0);
    assert.strictEqual(fs.statSync(otherData).uid, USER_UID);
  });

  it('isSelfManagedAgentData only matches instances/<pad>/<agent> depth', () => {
    const inst = '/workspace/instances';
    assert.strictEqual(ownership.isSelfManagedAgentData(path.join(inst, 'pad-h', 'hermes'), inst), true);
    // a pad *named* hermes is not agent data
    assert.strictEqual(ownership.isSelfManagedAgentData(path.join(inst, 'hermes'), inst), false);
    // a workspace folder deeper inside is not agent data
    assert.strictEqual(ownership.isSelfManagedAgentData(path.join(inst, 'pad-h', 'hermes', 'workspace', 'hermes'), inst), false);
    // non-self-managed agent types are never excluded
    assert.strictEqual(ownership.isSelfManagedAgentData(path.join(inst, 'pad-o', 'opencode'), inst), false);
  });
});
