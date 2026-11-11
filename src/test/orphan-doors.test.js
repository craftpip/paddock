// The boot sweep force-removes leftover door containers, so it may only ever
// name this project's own doors (plan 122 #4).
const { it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.PAD_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-doors-')), 'x.db');
process.env.CONTAINER_PREFIX = 'pad';
const { orphanDoorNames } = require('../services/vm-manager/doors-network');

const SOCAT = 'alpine/socat:latest';
const noInstances = () => false;

it('names a leftover door of a PAD that no longer exists', () => {
  assert.deepEqual(orphanDoorNames([{ name: 'pad-gone-door', image: SOCAT }, { name: 'pad-old-web', image: SOCAT }], noInstances),
    ['pad-gone-door', 'pad-old-web']);
});

it('never names another project\'s container, whatever it is called', () => {
  const others = [
    { name: 'shop-web', image: 'nginx:1' },
    { name: 'niyu-web', image: 'node:20' },
    { name: 'niyu-door', image: SOCAT },          // socat, but not a PAD name
    { name: 'pad-blog-web', image: 'wordpress' }, // a PAD-shaped name, but not a door
    { name: 'web', image: SOCAT },
    { name: '-door', image: SOCAT },
  ];
  assert.deepEqual(orphanDoorNames(others, noInstances), []);
});

it('leaves a door whose PAD still exists, and a real PAD named like a door', () => {
  const exists = (name) => ['pad-live', 'pad-my-web'].includes(name);
  assert.deepEqual(orphanDoorNames([
    { name: 'pad-live-door', image: SOCAT },  // its PAD exists
    { name: 'pad-my-web', image: SOCAT },     // is itself an instance
  ], exists), []);
});

it('tolerates an empty or odd listing', () => {
  assert.deepEqual(orphanDoorNames([], noInstances), []);
  assert.deepEqual(orphanDoorNames(undefined, noInstances), []);
  assert.deepEqual(orphanDoorNames([{}, { name: null }], noInstances), []);
});
