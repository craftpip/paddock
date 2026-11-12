// The Mission list's missing-folder badge: `withFolderState` stamps
// `folderExists` true/false when the PAD answered, and leaves it OFF when the
// PAD could not be asked — a stopped PAD is unknown, never "folder missing".
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const padTmux = require('../services/pad-tmux');
const liveness = require('../services/mission/liveness');

const real = padTmux.foldersExist;
afterEach(() => { padTmux.foldersExist = real; });

it('stamps true/false per folder with one probe per PAD', async () => {
  const asked = [];
  padTmux.foldersExist = async (vm, folders) => {
    asked.push([vm, [...folders].sort()]);
    return new Map(folders.map((f) => [f, f !== '/gone']));
  };
  const projects = [
    { agent_name: 'pad-fs-a', folder: '/here' },
    { agent_name: 'pad-fs-a', folder: '/gone' },
    { agent_name: 'pad-fs-b', folder: '/here' },
  ];
  await liveness.withFolderState(projects);
  assert.deepEqual(projects.map((p) => p.folderExists), [true, false, true]);
  assert.deepEqual(asked.sort(), [['pad-fs-a', ['/gone', '/here']], ['pad-fs-b', ['/here']]]);
});

it('leaves folderExists off when the PAD cannot be asked', async () => {
  padTmux.foldersExist = async () => { throw new Error('container is not running'); };
  const projects = [{ agent_name: 'pad-fs-stopped', folder: '/x', folderExists: true }];
  await liveness.withFolderState(projects);
  assert.equal('folderExists' in projects[0], false, 'unknown must not read as present or missing');
});
