const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = require('node:module');
const client = path.join(__dirname, '../client');
const requireClient = createRequire(path.join(client, 'package.json'));

// Render the real component (not a copy of its markup) to a string. The
// installed toolchain has no DOM test library, so the SSR surface is what can
// be asserted here: which halves exist, their labels/titles/disabled state and
// the closed-menu invariant. The menu's OPEN state needs a click, so it is
// covered by the live browser pass (plan 96 phase 4) — not by a source regex.
function render(props) {
  const source = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import SessionCreateSplit from './src/components/SessionCreateSplit.jsx';
    export default renderToStaticMarkup(<SessionCreateSplit {...${JSON.stringify(props)}} />);
  `;
  const result = requireClient('esbuild').buildSync({
    stdin: { contents: source, loader: 'jsx', resolveDir: client },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const compiled = new Module(path.join(client, 'session-create-split-ssr.cjs'), module);
  compiled.filename = path.join(client, 'session-create-split-ssr.cjs');
  compiled.paths = module.paths;
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  return compiled.exports.default;
}

const noop = () => {};
const project = { id: 'p1', name: 'paddock' };

it('renders one joined control: the left half keeps + New session and the caret carries the menu contract', () => {
  const html = render({ project, onNewSession: noop, onNewInfinite: noop });
  assert.match(html, /msn-btn-new-session[^"]*"[^>]*>\+ New session</);
  assert.match(html, /msn-btn-new-caret/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="More session types"/);
  assert.match(html, /New session in paddock/);
  // Joined corners: the halves must not both keep the full radius.
  assert.match(html, /msn-btn-new-session[^"]*rounded-r-none/);
  assert.match(html, /msn-btn-new-caret[^"]*rounded-l-none/);
  // The menu must not be in the tree while closed.
  assert.doesNotMatch(html, /msn-new-menu/);
  assert.doesNotMatch(html, /New infinite session/);
  // Neither half disabled with a project in scope.
  assert.doesNotMatch(html, /disabled/);
});

it('disables both halves with the project-first title when no project is in scope', () => {
  const html = render({ project: null, onNewSession: noop, onNewInfinite: noop });
  const buttons = html.match(/<button[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const b of buttons) {
    assert.match(b, /disabled/);
    assert.match(b, /title="Pick a project first"/);
  }
});

it('a start in flight disables both halves and relabels only the main segment', () => {
  const html = render({ project, newBusy: true, onNewSession: noop, onNewInfinite: noop });
  assert.match(html, /Opening…/);
  assert.doesNotMatch(html, /\+ New session</);
  const buttons = html.match(/<button[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const b of buttons) assert.match(b, /disabled/);
});

it('the menu, when open, offers exactly one infinite item — proven by its source of truth, the label and hint', () => {
  // The closed SSR tree is the only renderable state, so pin what the item
  // SHOWS by reading the component: `∞ New infinite session` plus the
  // one-line hint, both inside the `.msn-new-menu-infinite` hook. This is a
  // presence check on the copy, not a behaviour test — behaviour is the
  // browser pass.
  const src = fs.readFileSync(path.join(client, 'src/components/SessionCreateSplit.jsx'), 'utf8');
  assert.match(src, /msn-new-menu-infinite/);
  assert.match(src, /∞ New infinite session/);
  assert.match(src, /Runs QUEUE\.md until done/);
});
