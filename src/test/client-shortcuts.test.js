// Global keyboard shortcuts (client/src/lib/shortcuts.js), driven with a fake
// event and document — the Alt+Q queue toggle and the "never while typing" rule.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));

const URL_ = pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'lib', 'shortcuts.js')).href;
let handleShortcut, isTypingTarget;
before(async () => { ({ handleShortcut, isTypingTarget } = await import(URL_)); });

function fakeDoc({ toggle = true } = {}) {
  const clicks = { queue: 0 };
  return {
    clicks,
    querySelector: (sel) => (sel === '.msn-queue-toggle' && toggle ? { click: () => { clicks.queue++; } } : null),
    getElementById: () => null,
  };
}
function ev(over = {}) {
  const e = { key: 'q', code: 'KeyQ', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
    target: { tagName: 'DIV', closest: () => null }, prevented: 0, ...over };
  e.preventDefault = () => { e.prevented++; };
  return e;
}
const nav = () => {};

test('Alt+Q clicks the queue toggle and claims the key', () => {
  const doc = fakeDoc(); const e = ev();
  handleShortcut(e, nav, doc);
  assert.equal(doc.clicks.queue, 1);
  assert.equal(e.prevented, 1);
});

test('Alt+Q works by key code when the layout types another character (macOS "œ")', () => {
  const doc = fakeDoc();
  handleShortcut(ev({ key: 'œ' }), nav, doc);
  assert.equal(doc.clicks.queue, 1);
});

test('Alt+Q off the Mission page (no toggle) does nothing and leaves the key alone', () => {
  const doc = fakeDoc({ toggle: false }); const e = ev();
  handleShortcut(e, nav, doc);
  assert.equal(e.prevented, 0);
});

test('Alt+Q with another modifier, or plain Q, does not toggle', () => {
  for (const over of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: false }]) {
    const doc = fakeDoc();
    handleShortcut(ev(over), nav, doc);
    assert.equal(doc.clicks.queue, 0, JSON.stringify(over));
  }
});

test('no shortcut fires while typing: input, textarea, contenteditable, terminal', () => {
  const targets = [
    { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true },
    { tagName: 'CANVAS', closest: (s) => (s === '.xterm' ? {} : null) },
  ];
  for (const target of targets) {
    assert.equal(isTypingTarget(target), true, target.tagName);
    const doc = fakeDoc();
    handleShortcut(ev({ target }), nav, doc);
    assert.equal(doc.clicks.queue, 0, target.tagName);
  }
  assert.equal(isTypingTarget({ tagName: 'DIV', closest: () => null }), false);
});
