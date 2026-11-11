// services/vm-manager was split into services/vm-manager/*.js (plan 118
// follow-up). Callers still `require('services/vm-manager')`; this pins that
// the public surface is what it was as one file and that the pieces, which
// reference each other in cycles, load in any order.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-manager-exports-'));
process.env.PAD_DB_PATH = path.join(root, 'exports.db');
const dir = path.join(__dirname, '..', 'services', 'vm-manager');

const SURFACE = [
  'createVm',
  'removeVm',
  'resetVm',
  'readMeta',
  'generateInstanceCompose',
  'buildInstanceCompose',
  'writeInstanceCompose',
  'usesProjectDefaultNetwork',
  'ensurePadSubnet',
  'releasePadSubnet',
  'pickFreePadSubnet',
  'padPoolOctet',
  'usedPadSubnetOctets',
  'reservedPadSubnetOctets',
  'claimedPadSubnetOctets',
  'cleanStaleDoorDirs',
  'staleDoorDirActions',
  'isSocatDoorContainer',
  'STALE_DOOR_DIR',
  'applySettings',
  'updateAgent',
  'recreateAgent',
  'setMetaFlag',
  'instanceComposePath',
  'getComposePath',
  'getNetworkHealth',
  'inspectPeer',
  'isContainerRunning',
  'driverConfigPath',
  'existingServices',
  'startAgent',
  'stopAgent',
  'restartAgent',
  'readAgentConfig',
  'redactSecrets',
  'listDoors',
  'startDoors',
  'stopDoors',
  'readWebService',
  'applyWebServices',
  'webHookPath',
  'buildWebHook',
  'writeWebStartHook',
  'removeWebStartHook',
  'doorName',
  'doorPorts',
  'desiredDoors',
  'recreateServices',
  'isManagedDoorContainer',
  'readWebAuth',
  'applyWebAuth',
  'removeWebAuth',
  'validateWorkspaceMount',
  'workspaceMountInfo',
  'readWorkspaceMount',
  'containerViewOf',
  'webuiMountViewOf',
  'validateExtraVolume',
  'validateExtraVolumes',
  'validateExtraPorts',
  'readExtraVolumes',
  'readExtraPorts',
  'readSshCport',
  'ensureSshStartBlock',
  'autoSshPort',
  'readDevContainerPlan',
  'resolveDevContainerPlan',
  'collectPublishedHostPorts',
  'readWorkspaceDevContainer',
  'padsOnSameWorkspace',
  'effectiveUserMode',
  'syncDevContainer',
  'generateWorkspaceDevContainer',
  'devContainerStatus',
  'regenerateDevContainer',
  '_setPadWriteRunner',
  '_testDefaultPadWriteRunner',
  'imageHasDockerCli',
  'imageHasSshPortSupport',
  'imageHasWebStartSupport',
  'imageHasPostStartHook',
  'ensureUserModeBuildFiles',
  'imageHasPadUser',
  'ensureHomeOwnership',
  'imageHomeOwnershipBaked',
  'ensureWebHookUserDrop',
  'migrateWebHooks',
  'imageFor',
  'seedBuildDir',
  'buildDir',
  'buildEnvPath',
  'readBuildEnv',
  'setBuildEnv',
  'argsFromDockerfile',
  'readCustomBuild',
  'writeCustomBuild',
  'postCreateScriptPath',
  'readPostCreate',
  'writePostCreateScript',
  'postStartScriptPath',
  'readPostStart',
  'writePostStartScript',
  'postAttachScriptPath',
  'readPostAttach',
  'writePostAttachScript',
  'hasLifecycleScripts',
  'ensurePostStartBlock',
  'projectImageTag',
  'buildProjectImage',
  'workspaceHasProjectImage',
  'composeCommand',
  'runCompose',
  'validateInstanceCompose',
  'ensureInstanceBuilds',
  'readSettings',
  'readWebState',
  'readDrafts',
  'containerInfo',
  'listContainers',
  'listNetworkPeers',
  'selectNetworkPeers',
  'isManagedDoorName',
  'prepareAgentChanges',
  'applyAgentChanges',
  'claimPadChange', // added on purpose: routes take the change lock at the door
  'releasePadChange',
  'validateAgentCreate',
  'createAgent',
  'hostPortInUse',
  'resolveWebRequest',
  'INSTANCES_DIR',
  'PREFIX',
  'PREFIX_RE',
  'VM_NAME_RE',
  'HOST_WORKSPACE',
  'WORKSPACE',
  'findWebCollision'
];

it('exports exactly the surface it had as one file, with nothing undefined', () => {
  const vm = require('../services/vm-manager');
  assert.deepEqual(Object.keys(vm), SURFACE);
  for (const name of SURFACE) assert.notEqual(vm[name], undefined, name);
});

it('every module loads first without leaving a sibling half-built', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10, 'the split modules are present');
  for (const file of files) {
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

it('no module has grown past the size the split was for', () => {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').length;
    assert.ok(lines <= 900, `${file} is ${lines} lines; split it before adding more`);
  }
});

it('still finds the build templates one directory further down', () => {
  const { BUILD_TEMPLATES_DIR } = require('../services/vm-manager/internal');
  assert.equal(BUILD_TEMPLATES_DIR, path.join(__dirname, '..', 'vm-builds'));
  assert.ok(fs.existsSync(path.join(BUILD_TEMPLATES_DIR, 'opencode', 'Dockerfile')), 'the opencode template is where the constant points');
});
