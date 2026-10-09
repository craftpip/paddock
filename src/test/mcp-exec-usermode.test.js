const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the instance lookup at a throwaway workspace BEFORE anything reads
// WORKSPACE_ROOT (pad-tmux computes INSTANCES_DIR at require time). Two fake
// pads let us exercise the user-mode drop and its root-mode negative without a
// container: the drop is the whole contract, and it is invisible in a live
// test once a pad is already user-owned.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-exec-um-'));
process.env.WORKSPACE_ROOT = WS;
fs.mkdirSync(path.join(WS, 'instances', 'pad-um'), { recursive: true });
fs.writeFileSync(path.join(WS, 'instances', 'pad-um', 'meta.env'), 'AGENT=opencode\nUSER_MODE=user\n');
fs.mkdirSync(path.join(WS, 'instances', 'pad-rm'), { recursive: true });
fs.writeFileSync(path.join(WS, 'instances', 'pad-rm', 'meta.env'), 'AGENT=opencode\n');

const padTmux = require('../services/pad-tmux');
const { execDockerArgs } = require('../mcp');
const { USER_UID, USER_GID } = require('../services/ownership');

after(() => fs.rmSync(WS, { recursive: true, force: true }));

const DROP = ['-u', `${USER_UID}:${USER_GID}`, '-e', 'HOME=/root'];

describe('exec runs as the pad user in a user-mode pad', () => {
  it('termUserArgs drops a user-mode pad to PUID:PGID with HOME=/root', () => {
    assert.deepStrictEqual(padTmux.termUserArgs('pad-um'), DROP);
  });

  it('termUserArgs leaves a root-mode pad as root (negative twin)', () => {
    assert.deepStrictEqual(padTmux.termUserArgs('pad-rm'), []);
  });

  it('the MCP exec argv carries the drop before the container name', () => {
    assert.deepStrictEqual(
      execDockerArgs('pad-um', 'id -u'),
      ['exec', '-i', ...DROP, 'pad-um', 'sh', '-lc', 'id -u']
    );
  });

  it('the MCP exec argv has no drop for a root-mode pad', () => {
    assert.deepStrictEqual(
      execDockerArgs('pad-rm', 'id -u'),
      ['exec', '-i', 'pad-rm', 'sh', '-lc', 'id -u']
    );
  });

  it('padExec runs the command as the pad user through the same drop', async () => {
    let captured = null;
    padTmux._setForTests({
      runCmd: (cmd, args, options) => {
        captured = { cmd, args, options };
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    await padTmux.padExec('pad-um', 'id -u');
    padTmux._setForTests({ resetReady: true });
    assert.deepStrictEqual(captured.args, ['exec', '-i', ...DROP, 'pad-um', 'sh', '-lc', 'id -u']);
    // The runner seam must not have been handed a bare number where the argv
    // shape expects an options object (execFile throws on a bad timeout).
    assert.ok(!captured.options || typeof captured.options === 'object');
  });
});
