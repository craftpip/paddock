// Plan 118 Phase 2: services/mission was split into services/mission/*.js.
// Callers still `require('services/mission')`; this pins that the public
// surface is exactly what it was before the move, and that the pieces load in
// any order (the modules reference each other in cycles).
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-exports-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'exports.db');

const SURFACE = [
  'resumeQuotaRecovery',
  'MissionError',
  'supportedTypes',
  'assertMissionAgent',
  'newTmuxId',
  'normalizeFolder',
  'normalizePlansFolder',
  'createProject',
  'getProject',
  'listProjects',
  'updateProject',
  'deleteProject',
  'createSession',
  'getSession',
  'getSessionByIdempotencyKey',
  'endSessions',
  'endSessionsForPad',
  'listSessions',
  'listSessionsForAgent',
  'listAllSessions',
  'updateSession',
  'assertNotLocked',
  'deleteSession',
  'getSessionByTmux',
  'touchSession',
  'noteOutput',
  'startSession',
  'projectFolders',
  'agentHistory',
  'allAgentHistory',
  'relaunchTui',
  'restartSession',
  'sendText',
  'assertStepSession',
  'answerPermission',
  'detectPermission',
  'screen',
  'state',
  'statesFor',
  'stampTruth',
  'canDispatch',
  '_setReceiptPollBudget',
  '_setTuiReadyBudget',
  'ensureRunnerMcp',
  'computeSchedulerState',
  'observeRunnerTurn',
  'withLive',
  'withLiveSessions',
  'withLiveSessionsByAgent',
  'busyForSessions',
  'withAgentBusy',
  'withAgentBusyProjects',
  'closeSession',
  'disableRunnerForSession',
  'endSession',
  'newRunnerId',
  'createRunner',
  'getRunner',
  'publicRunner',
  'getActiveRunnerForProject',
  'listRunnersForProject',
  'listAllRunners',
  'updateRunner',
  'ensureRunnerSession',
  'setRunnerControlState',
  'setRunnerEnabled',
  'setRunnerReason',
  'runnerContainerPaths',
  'pauseConfirmation',
  'getRunnerForSupervision',
  'startRunner',
  'pauseRunner',
  'resumeRunner',
  'removeRunner',
  'resolveRunnerQueue',
  'reconcileRunnerOperation',
  'reconcileRunners',
  'reconcileQueuePublications',
  'runnerWatchTick',
  'runnerWatchOnce',
  'kickRunnerWatch',
  '_setFastWatch',
  'readRunnerQueue',
  'setupRunnerQueue',
  'updateRunnerQueue',
  'updateRunnerQueueItem',
  'addRunnerQueueItems',
  'reorderRunnerQueue',
  'removeRunnerQueueItem',
  'updateRunnerQueueCustomInstructions',
  'listRunnerPlans',
  'effectivePromptTemplates',
  'withPromptTemplates',
  'runnerPromptConfig',
  'previewRunnerPrompts',
  'previewProjectPrompts',
  'renderRunnerPrompt',
  'promptCatalogue',
  'getRunnerCallbacks',
  'saveRunnerCallbacks',
  'runnerCallbackHistory',
  'callbackCatalogue',
  'baselineRunnerCallbacks',
  'pumpCallbackOutbox',
  'reconcileCallbackOutbox',
  'observeRunnerQueues',
  'observeRunnerUsage',
  'RUNNER_CONTROL_STATES',
  'RUNNER_HEALTH_STATES'
];

it('exports exactly the surface it had as one file, with nothing undefined', () => {
  const mission = require('../services/mission');
  assert.deepEqual(Object.keys(mission), SURFACE);
  for (const name of SURFACE) assert.notEqual(mission[name], undefined, name);
});

it('every module loads first without leaving a sibling half-built', () => {
  const dir = path.join(__dirname, '..', 'services', 'mission');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10, 'the split modules are present');
  for (const file of files) {
    // A fresh process per entry point: requiring this module FIRST is the
    // order that exposes a value read across a require cycle.
    const script = `
      const first = require(${JSON.stringify(path.join(dir, file))});
      const all = require(${JSON.stringify(dir)});
      const bad = Object.entries(all).filter(([, v]) => v === undefined).map(([k]) => k);
      const own = Object.entries(first).filter(([, v]) => v === undefined).map(([k]) => k);
      if (bad.length || own.length) { console.error(JSON.stringify({ bad, own })); process.exit(1); }
    `;
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, PAD_DB_PATH: path.join(root, `load-${file}.db`) }, stdio: 'pipe' });
  }
});

it('no split module has grown past the size the split was for', () => {
  const dir = path.join(__dirname, '..', 'services', 'mission');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').length;
    assert.ok(lines <= 900, `${file} is ${lines} lines; split it before adding more`);
  }
});

// A name used but never declared or imported parses, passes `node --check`,
// and throws ReferenceError only when that line runs. After a move between
// files that is the likeliest defect, so resolve every identifier's binding.
it('no split module refers to a name it neither declares nor imports', () => {
  const { createRequire } = require('node:module');
  const requireClient = createRequire(path.join(__dirname, '..', 'client', 'package.json'));
  const parser = requireClient('@babel/parser');
  const traverse = requireClient('@babel/traverse').default;
  const known = new Set([...Object.getOwnPropertyNames(globalThis), 'require', 'module', 'exports', '__dirname', '__filename']);
  const dir = path.join(__dirname, '..', 'services', 'mission');
  const unbound = [];
  let references = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const ast = parser.parse(fs.readFileSync(path.join(dir, file), 'utf8'), { sourceType: 'script' });
    traverse(ast, {
      Identifier(p) {
        if (!p.isReferencedIdentifier()) return;
        references += 1;
        const name = p.node.name;
        if (!p.scope.hasBinding(name) && !known.has(name)) unbound.push(`${file}:${p.node.loc.start.line} ${name}`);
      },
    });
  }
  assert.ok(references > 5000, 'the scan actually walked the modules');
  assert.deepEqual(unbound, []);
});
