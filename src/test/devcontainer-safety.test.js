// A workspace's devcontainer.json is written by the agent, and its plan is
// applied at the operator's next settings change. So nothing in it may reach
// outside the workspace or grant an escape (plan 122 #3).
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-safety-')));
process.env.WORKSPACE_ROOT = TMP;
process.env.HOST_WORKSPACE_ROOT = TMP;
process.env.PAD_DB_PATH = path.join(TMP, 'x.db');
const ws = path.join(TMP, 'ws');

let dc;
before(() => {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(TMP, '.env'), 'VAULT_KEY=secret\n');          // the control plane's own
  fs.writeFileSync(path.join(ws, 'app.env'), 'FOO=bar\n');                  // a legitimate env file
  fs.symlinkSync(path.join(TMP, '.env'), path.join(ws, 'sneaky.env'));     // a link out, made "by the agent"
  dc = require('../services/vm-manager/devcontainer');
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

it('accepts an env file inside the workspace, relative or absolute', () => {
  assert.equal(dc.resolveDevContainerEnvFile(ws, 'app.env'), path.join(ws, 'app.env'));
  assert.equal(dc.resolveDevContainerEnvFile(ws, path.join(ws, 'app.env')), path.join(ws, 'app.env'));
  assert.equal(dc.resolveDevContainerEnvFile(ws, 'not-there-yet.env'), path.join(ws, 'not-there-yet.env'));
});

it('refuses an env file outside the workspace, however it is spelled', () => {
  for (const value of [path.join(TMP, '.env'), '../.env', 'sub/../../.env', '/etc/passwd', ws]) {
    assert.throws(() => dc.resolveDevContainerEnvFile(ws, value), /outside the workspace/, value);
  }
});

it('refuses an env file that is a symlink leaving the workspace', () => {
  assert.throws(() => dc.resolveDevContainerEnvFile(ws, 'sneaky.env'), /through a symlink/);
});
