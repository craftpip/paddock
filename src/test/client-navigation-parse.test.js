const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const client = path.join(__dirname, '../client');
const requireClient = createRequire(path.join(client, 'package.json'));

it('navigation client bundle parses and resolves every import without touching the served bundle', () => {
  requireClient('esbuild').buildSync({ entryPoints: [path.join(client, 'src/App.jsx')], bundle: true,
    write: false, platform: 'browser', loader: { '.css': 'empty' }, logLevel: 'silent' });
});

it('navigation components have no unbound references that would crash only when rendered or clicked', () => {
  const parser = requireClient('@babel/parser');
  const traverse = requireClient('@babel/traverse').default;
  const globals = new Set([...Object.getOwnPropertyNames(globalThis), 'window', 'document', 'localStorage', 'sessionStorage',
    'navigator', 'EventSource', 'XMLHttpRequest', 'FormData', 'HTMLElement', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']);
  const files = ['App.jsx', 'lib/url-state.js', 'lib/navigation.jsx', 'lib/mission-navigation.jsx', 'stores/mission.js',
    'pages/Mission.jsx', 'pages/AgentDetail.jsx', 'pages/Dashboard.jsx', 'pages/Profile.jsx', 'pages/Vault.jsx', 'pages/Login.jsx',
    'pages/agent/SettingsTab.jsx', 'pages/agent/WebTab.jsx', 'pages/Configs.jsx', 'components/MissionPopups.jsx', 'components/RunnerDialog.jsx', 'components/ProjectDialog.jsx',
    'components/SessionList.jsx', 'components/SessionCreateSplit.jsx', 'components/PlanPicker.jsx', 'components/QueuePanel.jsx', 'components/ui/Modal.jsx'];
  const unbound = [];
  for (const file of files) {
    const ast = parser.parse(fs.readFileSync(path.join(client, 'src', file), 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    traverse(ast, { ReferencedIdentifier(p) {
      if (!p.scope.hasBinding(p.node.name) && !globals.has(p.node.name)) unbound.push(`${file}:${p.node.loc.start.line}: ${p.node.name}`);
    } });
  }
  assert.deepEqual(unbound, []);
});

it('the shared navigation hooks render under the installed data router', () => {
  const source = `
    import React from 'react';
    import { renderToString } from 'react-dom/server';
    import { createMemoryRouter, RouterProvider } from 'react-router-dom';
    import { NavigationProvider, useNavigation, useDraftState, useDirtyNavigation } from './src/lib/navigation.jsx';
    function Probe() {
      const { location } = useNavigation();
      const [draft] = useDraftState('probe', 'local draft');
      useDirtyNavigation(false, l => l.pathname);
      return <span>{location.search}:{draft}</span>;
    }
    const router = createMemoryRouter([{ path: '/probe', element: <NavigationProvider><Probe /></NavigationProvider> }],
      { initialEntries: ['/probe?external=keep'] });
    export default renderToString(<RouterProvider router={router} />);
  `;
  const result = requireClient('esbuild').buildSync({ stdin: { contents: source, loader: 'jsx', resolveDir: client },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent' });
  const Module = require('node:module');
  const compiled = new Module(path.join(client, 'navigation-ssr-test.cjs'), module);
  compiled.filename = path.join(client, 'navigation-ssr-test.cjs');
  compiled.paths = module.paths;
  compiled._compile(result.outputFiles[0].text, compiled.filename);
  assert.match(compiled.exports.default, /external=keep/);
  assert.match(compiled.exports.default, /local draft/);
});
