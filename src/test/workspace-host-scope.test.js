// Host-scope file browsing runs as root in the control plane, on a folder
// whose contents the PAD controls. A symlink the PAD makes must not let its
// owner read, list, delete or move anything outside that folder, and a missing
// or outside path must never make a destructive operation act on the folder
// itself (plans 121 #5, 122 #1 and #5).
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveHostPath } = require('../services/workspace');

let tmp; let root; let outside;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-host-')));
  root = path.join(tmp, 'pad-data');
  outside = path.join(tmp, 'control-plane');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'mine');
  fs.writeFileSync(path.join(outside, 'secret.env'), 'VAULT_KEY=x');
  fs.symlinkSync(outside, path.join(root, 'x'));                       // dir link out
  fs.symlinkSync(path.join(outside, 'secret.env'), path.join(root, 'leak')); // file link out
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inside-link'));    // link that stays inside
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const refuses = (fn, what) => assert.throws(fn, /outside|symlink|required|folder itself|traversal|Invalid/i, what);

it('resolves ordinary paths inside the folder, in every mode', () => {
  for (const mode of ['list', 'read', 'write', 'destroy']) {
    assert.equal(resolveHostPath(root, 'ok.txt', { mode }), path.join(root, 'ok.txt'), mode);
    assert.equal(resolveHostPath(root, path.join(root, 'sub'), { mode }), path.join(root, 'sub'), mode);
  }
  assert.equal(resolveHostPath(root, 'sub/new.txt', { mode: 'write' }), path.join(root, 'sub', 'new.txt'), 'a file that does not exist yet');
});

it('refuses to read or list through a symlink that leaves the folder', () => {
  refuses(() => resolveHostPath(root, 'x/secret.env', { mode: 'read' }), 'file under a linked directory');
  refuses(() => resolveHostPath(root, 'leak', { mode: 'read' }), 'a linked file');
  refuses(() => resolveHostPath(root, 'x', { mode: 'list' }), 'listing the linked directory');
  refuses(() => resolveHostPath(root, 'x/new.txt', { mode: 'write' }), 'writing under the link');
});

it('follows a symlink that stays inside the folder', () => {
  assert.equal(resolveHostPath(root, 'inside-link', { mode: 'list' }), path.join(root, 'inside-link'));
});

it('refuses a destructive operation on anything reached through an outside link', () => {
  refuses(() => resolveHostPath(root, 'x/secret.env', { mode: 'destroy' }));
});

it('lets the link ITSELF be removed, since that touches nothing outside', () => {
  assert.equal(resolveHostPath(root, 'x', { mode: 'destroy' }), path.join(root, 'x'));
  assert.equal(resolveHostPath(root, 'leak', { mode: 'destroy' }), path.join(root, 'leak'));
});

it('never turns a missing or outside path into the folder itself for a destructive operation', () => {
  refuses(() => resolveHostPath(root, undefined, { mode: 'destroy' }), 'no path');
  refuses(() => resolveHostPath(root, '', { mode: 'destroy' }), 'empty path');
  refuses(() => resolveHostPath(root, '/', { mode: 'destroy' }), 'the root by /');
  refuses(() => resolveHostPath(root, root, { mode: 'destroy' }), 'the root by name');
  refuses(() => resolveHostPath(root, '/etc/passwd', { mode: 'destroy' }), 'an outside absolute path');
  refuses(() => resolveHostPath(root, '/etc/passwd', { mode: 'read' }), 'reading an outside absolute path');
  refuses(() => resolveHostPath(root, '/etc/passwd', { mode: 'write' }), 'writing an outside absolute path');
});

it('still clamps an outside path to the folder for a plain listing', () => {
  // The file browser sends whatever the address bar holds; landing on the
  // folder is the friendly answer for a READ-ONLY listing and only for that.
  assert.equal(resolveHostPath(root, '/somewhere/else', { mode: 'list' }), root);
  assert.equal(resolveHostPath(root, '', { mode: 'list' }), root);
});
