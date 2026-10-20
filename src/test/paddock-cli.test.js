const { it } = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../cli');

function harness(extra = {}) {
  const stdout = [], stderr = [], actions = [];
  const rows = [
    { name: 'pad-project', display_name: 'Project', status: 'running', agent_type: 'opencode' },
    { name: 'pad-project2', display_name: 'Shared', status: 'stopped', agent_type: 'opencode' },
    { name: 'pad-project3', display_name: 'Shared', status: 'running', agent_type: 'codex' },
  ];
  const vm = { PREFIX: 'pad', containerInfo: async (name) => ({ state: { status: 'running', running: true } }) };
  for (const method of ['startAgent', 'stopAgent', 'restartAgent', 'recreateAgent']) vm[method] = async (name, options) => { actions.push([method, name]); options.onLog?.('progress'); };
  const deps = { vm, registry: { discoverAgents: () => rows }, stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), ...extra };
  return { stdout, stderr, actions, deps };
}

it('help works without loading services or opening the database', async () => {
  const h = harness({ vm: new Proxy({}, { get: () => assert.fail('help must not load services') }) });
  assert.equal(await main(['--help'], h.deps), 0);
  assert.match(h.stdout.join(''), /paddock pad recreate/);
});

it('invalid commands, missing targets, surplus args and unknown flags fail before acting', async () => {
  for (const args of [['pad', 'recreate'], ['pad', 'delete', 'project'], ['pad', 'recreate', 'project', '--reset'], ['pad', 'list', 'project'], ['runner', 'resume']]) {
    const h = harness();
    assert.equal(await main(args, h.deps), 2, args.join(' '));
    assert.equal(h.actions.length, 0);
  }
});

it('all lifecycle actions resolve canonical names and delegate to managed services', async () => {
  for (const [action, method] of [['start', 'startAgent'], ['stop', 'stopAgent'], ['restart', 'restartAgent'], ['recreate', 'recreateAgent']]) {
    const h = harness();
    assert.equal(await main(['pad', action, 'Project', '--json'], h.deps), 0);
    assert.deepEqual(h.actions, [[method, 'pad-project']]);
    assert.deepEqual(JSON.parse(h.stdout[0]), { name: 'pad-project', action, ok: true });
    assert.deepEqual(h.stderr, ['progress']);
  }
});

it('status emits the actual state and refuses missing or ambiguous PADs', async () => {
  const h = harness();
  assert.equal(await main(['pad', 'status', 'project', '--json'], h.deps), 0);
  assert.deepEqual(JSON.parse(h.stdout[0]), { name: 'pad-project', status: 'running', running: true });
  for (const target of ['external-container', 'Shared']) {
    const bad = harness();
    assert.equal(await main(['pad', 'recreate', target], bad.deps), 1);
    assert.equal(bad.actions.length, 0);
  }
});

it('operation failures return exit 1 without a success result', async () => {
  const h = harness();
  h.deps.vm.recreateAgent = async () => { throw new Error('Compose failed'); };
  assert.equal(await main(['pad', 'recreate', 'project', '--json'], h.deps), 1);
  assert.equal(h.stdout.length, 0);
  assert.match(h.stderr[0], /Compose failed/);
});

it('Compose progress does not print its stderr transport label as an error prefix', async () => {
  const h = harness();
  h.deps.vm.recreateAgent = async (_name, { onLog }) => onLog('stderr', 'Container pad-project Recreated\n');
  assert.equal(await main(['pad', 'recreate', 'project'], h.deps), 0);
  assert.deepEqual(h.stderr, ['Container pad-project Recreated']);
});

it('runner commands use the shared mission lifecycle and require exact runner identity', async () => {
  const runner = { id: 'run-one', name: 'One', enabled: 0, control_state: 'paused', last_reason: null };
  const calls = [];
  const h = harness({ mission: {
    getRunner: (id) => id === runner.id ? runner : null,
    pauseRunner: async (id) => { calls.push(['pause', id]); },
    startRunner: async (id) => { calls.push(['resume', id]); return { started: true }; },
  } });
  for (const action of ['status', 'pause', 'resume']) assert.equal(await main(['runner', action, runner.id, '--json'], h.deps), 0);
  assert.deepEqual(calls, [['pause', runner.id], ['resume', runner.id]]);
  assert.equal(await main(['runner', 'resume', 'missing'], h.deps), 1);
});
