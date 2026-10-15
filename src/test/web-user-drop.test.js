const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Plan 89. The published web server used to launch as ROOT even in a user-mode
// PAD, so its first `opencode` init created `/root/.local/state/opencode/locks`
// root:0755 and the pad user could never write a lock again (`opencode mcp list`
// → PermissionDenied). The hook is on disk, not baked into the image, so an
// already-published PAD has to be migrated. Point INSTANCES_DIR at a throwaway
// tree BEFORE requiring vm-manager (it computes the path at load time).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-webdrop-'));
process.env.WORKSPACE_ROOT = WS;
process.env.HOST_WORKSPACE_ROOT = WS;
// task-runner (below) loads db.js, which reads the path at module load — give
// it a throwaway file so this suite never touches the dev database.
process.env.PAD_DB_PATH = path.join(WS, 'webdrop.test.db');

const vm = require('../services/vm-manager');
const { USER_UID, USER_GID } = require('../services/ownership');
const tasks = require('../services/task-runner');
const orchestrator = require('../services/orchestrator');

after(() => fs.rmSync(WS, { recursive: true, force: true }));

const DROP = ['-u', `${USER_UID}:${USER_GID}`, '-e', 'HOME=/root'];

const OLD_HOOK = `#!/bin/bash
# Paddock web publishing — start the published web server on boot.
if ( exec 3<>/dev/tcp/127.0.0.1/8080 ) 2>/dev/null; then
  exec 3>&- 2>/dev/null
  exit 0
fi
OPENCODE_SERVER_PASSWORD='pw' opencode web --hostname 0.0.0.0 --port 8080 2>&1 | tee -a /root/.opencode/web.log >/proc/1/fd/1 &
echo $! > "/root/.opencode/web.pid"
`;

/** Reverse of the hook's `sh -lc '<cmd>'` single-quoting, so a test can prove
 *  the quoting is the reversible POSIX escape (`'\''`) rather than something
 *  that merely looks escaped. */
function shUnquote(token) {
  assert.ok(token.startsWith("'") && token.endsWith("'"), 'token is single-quoted');
  return token.slice(1, -1).replace(/'\\''/g, "'");
}

describe('plan 89 — web hook drops to the pad user in a user-mode PAD', () => {
  it('bakes a runtime-gated setpriv drop and keeps the root-mode line', () => {
    const hook = vm.buildWebHook(
      { dataDir: '/root/.opencode', webApp: { startCommand: () => 'opencode web --port 8080' } },
      'opencode', { containerPort: 8080 }, ''
    );
    assert.ok(hook.includes('PAD WEB USER DROP (plan 89)'), 'carries the migration marker');
    assert.ok(hook.includes('[ "$USER_MODE" = "user" ]'), 'gate is on runtime USER_MODE, not generation');
    assert.ok(
      hook.includes(`setpriv --reuid ${USER_UID} --regid ${USER_GID} --clear-groups -- sh -lc "$1"`),
      'drops the server to PUID:PGID (no HOME pin needed: the hook runs as the container root)'
    );
    // The root-mode branch keeps the exact pre-plan-89 line, so a root-mode PAD
    // does not silently change behaviour.
    assert.ok(hook.includes('opencode web --port 8080 2>&1 | tee -a /root/.opencode/web.log >/proc/1/fd/1 &'));
  });

  it('escapes a start command carrying quotes so sh -lc receives it intact', () => {
    const cmd = `echo 'a' "b" $HOME && opencode web --port 8080`;
    const hook = vm.buildWebHook(
      { dataDir: '/root/.opencode', webApp: { startCommand: () => cmd } },
      'opencode', { containerPort: 8080 }, ''
    );
    const m = hook.match(/\n  pad_run (.+?) 2>&1 \| tee/);
    assert.ok(m, 'the pad_run line carries one single-quoted token');
    assert.strictEqual(shUnquote(m[1]), cmd, 'unquoting the token returns the exact command');
  });

  it('regenerates an already-published PAD hook that predates the drop', () => {
    const instDir = path.join(WS, 'instances', 'pad-legacy');
    fs.mkdirSync(path.join(instDir, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nUSER_MODE=user\n');
    fs.writeFileSync(path.join(instDir, 'web.json'), JSON.stringify({ containerPort: 8080, hostPort: '43818' }));
    const hookPath = path.join(instDir, 'opencode', 'start-web.sh');
    fs.writeFileSync(hookPath, OLD_HOOK, { mode: 0o755 });

    assert.strictEqual(vm.ensureWebHookUserDrop('pad-legacy', 'opencode'), true, 'rewrote the old hook');
    const now = fs.readFileSync(hookPath, 'utf8');
    assert.ok(now.includes('PAD WEB USER DROP (plan 89)'));
    assert.ok(now.includes("OPENCODE_SERVER_PASSWORD='pw'"), 'the web password is preserved');
    assert.strictEqual(vm.ensureWebHookUserDrop('pad-legacy', 'opencode'), false, 'idempotent on the second pass');
  });

  it('preserves the password of a hook already in the nested `pad_run` form', () => {
    // The regression that shipped once: `readWebAuth` parsed the ORIGINAL plain
    // `KEY='pw'`, so a hook already in the plan-89 form — where the whole command
    // is shell-quoted and the password reads `KEY='\''pw'\''` — was re-read as the
    // escape backslash `\`, and a regeneration DESTROYED the credential.
    const instDir = path.join(WS, 'instances', 'pad-nested');
    fs.mkdirSync(path.join(instDir, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nUSER_MODE=user\n');
    fs.writeFileSync(path.join(instDir, 'web.json'), JSON.stringify({ containerPort: 8080, hostPort: '43818' }));
    const hookPath = path.join(instDir, 'opencode', 'start-web.sh');
    const nested = [
      '#!/bin/bash',
      'if [ "$USER_MODE" = "user" ] && [ "$(id -u)" = "0" ]; then',
      "  pad_run 'OPENCODE_SERVER_PASSWORD='\\''sekret-token'\\'' opencode web --port 8080' 2>&1 | tee -a /root/.opencode/web.log >/proc/1/fd/1 &",
      'else',
      "  OPENCODE_SERVER_PASSWORD='sekret-token' opencode web --port 8080 2>&1 | tee -a /root/.opencode/web.log >/proc/1/fd/1 &",
      'fi',
      '',
    ].join('\n');
    fs.writeFileSync(hookPath, nested, { mode: 0o755 });

    assert.strictEqual(vm.ensureWebHookUserDrop('pad-nested', 'opencode'), true);
    const now = fs.readFileSync(hookPath, 'utf8');
    assert.ok(
      now.includes("OPENCODE_SERVER_PASSWORD='\\''sekret-token'\\''"),
      `the token survives the rewrite: ${now.split('\n').find((l) => l.includes('pad_run'))}`
    );
  });

  it('is a no-op when there is nothing to fix (no hook, or marker already present)', () => {
    // No hook at all (never published): nothing to migrate, not a failure.
    const bare = path.join(WS, 'instances', 'pad-bare');
    fs.mkdirSync(path.join(bare, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'meta.env'), 'AGENT=opencode\nUSER_MODE=user\n');
    assert.strictEqual(vm.ensureWebHookUserDrop('pad-bare', 'opencode'), false);

    // Hook present + web binding, but the marker is already there.
    const done = path.join(WS, 'instances', 'pad-done');
    fs.mkdirSync(path.join(done, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(done, 'meta.env'), 'AGENT=opencode\nUSER_MODE=user\n');
    fs.writeFileSync(path.join(done, 'web.json'), JSON.stringify({ containerPort: 8080, hostPort: '43818' }));
    fs.writeFileSync(path.join(done, 'opencode', 'start-web.sh'), '#!/bin/bash\n# PAD WEB USER DROP (plan 89)\n');
    assert.strictEqual(vm.ensureWebHookUserDrop('pad-done', 'opencode'), false);
  });

  it('boot sweep migrates only the pads that need it', () => {
    const instDir = path.join(WS, 'instances', 'pad-sweep');
    fs.mkdirSync(path.join(instDir, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nUSER_MODE=user\n');
    fs.writeFileSync(path.join(instDir, 'web.json'), JSON.stringify({ containerPort: 8080, hostPort: '43818' }));
    fs.writeFileSync(path.join(instDir, 'opencode', 'start-web.sh'), OLD_HOOK, { mode: 0o755 });

    const changed = vm.migrateWebHooks();
    assert.deepStrictEqual(changed, ['pad-sweep'], 'found the one pad still on the old hook');
    assert.ok(
      fs.readFileSync(path.join(instDir, 'opencode', 'start-web.sh'), 'utf8').includes('PAD WEB USER DROP (plan 89)')
    );
  });
});

// The web hook is only one of the ways a managed agent process reaches a PAD.
// The task runner (`opencode run`) and the orchestrator (`opencode mcp add`) run
// their own `docker exec`, and each must drop too — otherwise the very same
// root-owned `/root/.local/state/opencode/locks` is recreated by a path the hook
// never touches. These drive the REAL `termUserArgs` resolver (WORKSPACE_ROOT
// points at this fixture), not an injected stub.
describe('plan 89 — managed agent processes run as the pad user', () => {
  for (const [name, mode] of [['pad-um', 'user'], ['pad-rm', 'root']]) {
    fs.mkdirSync(path.join(WS, 'instances', name, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'instances', name, 'meta.env'), `AGENT=opencode\nUSER_MODE=${mode}\n`);
  }

  function makeChild() {
    const child = new EventEmitter();
    child.pid = 5500;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { end() { return this; } };
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    return child;
  }

  it('task-runner spawns `opencode run` as the pad user, and not in a root-mode PAD', async () => {
    const calls = [];
    tasks._setForTests({
      resetSeams: true,
      getAgent: (n) => ({ name: n, agent_type: 'opencode', runtime_ref: n, status: 'running' }),
      isRunning: () => true,
      folderExists: async () => true,
      spawn: (cmd, args) => { calls.push({ cmd, args }); return makeChild(); },
    });
    try {
      await tasks.submitTask({ name: 'pad-um', prompt: 'x' });
      await tasks.submitTask({ name: 'pad-rm', prompt: 'x' });
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(calls[0].args.slice(0, 7), ['exec', '-i', ...DROP, 'pad-um']);
      assert.strictEqual(calls[0].args[7], 'sh');
      assert.deepStrictEqual(calls[1].args.slice(0, 4), ['exec', '-i', 'pad-rm', 'sh'], 'root-mode PAD unchanged');
    } finally {
      tasks._setForTests({ resetRunning: true, resetSeams: true });
    }
  });

  it('orchestrator exec argv drops for a user-mode PAD and not for a root-mode one', () => {
    assert.deepStrictEqual(
      orchestrator.execDockerArgs('pad-um', 'opencode mcp add'),
      ['exec', '-i', ...DROP, 'pad-um', 'sh', '-lc', 'opencode mcp add']
    );
    assert.deepStrictEqual(
      orchestrator.execDockerArgs('pad-rm', 'opencode mcp add'),
      ['exec', '-i', 'pad-rm', 'sh', '-lc', 'opencode mcp add']
    );
  });
});
