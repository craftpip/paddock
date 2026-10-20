const { it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));
const URL = pathToFileURL(path.join(__dirname, '../client/src/lib/mission-popout.js')).href;

let popout;
let box;
beforeEach(async () => {
  box = {};
  global.localStorage = {
    getItem: (key) => box[key] || null,
    setItem: (key, value) => { box[key] = String(value); },
  };
  popout = await import(`${URL}?t=${process.hrtime.bigint()}`);
});

it('uses safe defaults for missing or corrupt geometry and scopes persisted bounds to the user', () => {
  assert.deepEqual(popout.readPopoutGeometry('u1'), { width: 980, height: 720, left: 80, top: 60 });
  box[popout.popoutStorageKey('u1')] = '{bad';
  assert.equal(popout.readPopoutGeometry('u1').width, 980);
  popout.writePopoutGeometry('u1', { outerWidth: 800, outerHeight: 600, screenX: -900, screenY: 40 });
  assert.deepEqual(popout.readPopoutGeometry('u1'), { width: 800, height: 600, left: -900, top: 40 });
  assert.equal(popout.readPopoutGeometry('u2').width, 980, 'one user cannot inherit another user\'s geometry');
});
