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

it('fits saved bounds onto the screen the popup opens on', () => {
  const screen = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 };
  popout.writePopoutGeometry('u1', { outerWidth: 800, outerHeight: 600, screenX: -900, screenY: 40 });
  assert.deepEqual(popout.readPopoutGeometry('u1', screen), { width: 800, height: 600, left: 0, top: 40 },
    'a window saved on an unplugged left monitor moves back onto this screen');
  popout.writePopoutGeometry('u1', { outerWidth: 1000, outerHeight: 700, screenX: 1700, screenY: 900 });
  assert.deepEqual(popout.readPopoutGeometry('u1', screen), { width: 1000, height: 700, left: 920, top: 340 },
    'a window hanging off the bottom-right is pulled in so all of it shows');
  popout.writePopoutGeometry('u1', { outerWidth: 4000, outerHeight: 3000, screenX: 10, screenY: 10 });
  assert.deepEqual(popout.readPopoutGeometry('u1', screen), { width: 1920, height: 1040, left: 0, top: 0 },
    'a window bigger than the screen shrinks to it');
  const leftDisplay = { availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1080 };
  popout.writePopoutGeometry('u1', { outerWidth: 800, outerHeight: 600, screenX: -900, screenY: 40 });
  assert.deepEqual(popout.readPopoutGeometry('u1', leftDisplay), { width: 800, height: 600, left: -900, top: 40 },
    'a negative position on a display that really is to the left stays put');
});
