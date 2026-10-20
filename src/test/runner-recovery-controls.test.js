const { it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const client = path.join(__dirname, '..', 'client');
const requireClient = createRequire(path.join(client, 'package.json'));

function recoveryVerdict(runner, queue) {
  const source = `
    import { requiresExplicitRecovery, runnerIsRunning } from './src/components/RunnerControls.jsx';
    const runner = ${JSON.stringify(runner)};
    const queue = ${JSON.stringify(queue)};
    export default { recovery: requiresExplicitRecovery(runner, queue, 'run_a'), running: runnerIsRunning(runner, queue, 'run_a') };
  `;
  const result = requireClient('esbuild').buildSync({
    stdin: { contents: source, loader: 'jsx', resolveDir: client },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const Module = require('node:module');
  const compiled = new Module(path.join(client, 'runner-recovery-controls-test.cjs'), module);
  compiled.filename = path.join(client, 'runner-recovery-controls-test.cjs');
  compiled.paths = module.paths;
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  return compiled.exports.default;
}

it('RunnerControls switches to Run only for the server-confirmed interrupted-turn verdict', () => {
  const runner = { id: 'run_a', control_state: 'enabled' };
  const recovery = recoveryVerdict(runner, { scheduler: { recoveryRequired: true, reason: 'Worker turn interrupted or failed — explicit recovery required' } });
  assert.deepEqual(recovery, { recovery: true, running: false });

  const ordinaryIdle = recoveryVerdict(runner, { scheduler: { recoveryRequired: false, schedulerDecision: 'wait_idle_grace' } });
  assert.deepEqual(ordinaryIdle, { recovery: false, running: true });

  const unknown = recoveryVerdict(runner, { scheduler: { recoveryRequired: false, schedulerDecision: 'observation_unavailable' } });
  assert.deepEqual(unknown, { recovery: false, running: true });
});
