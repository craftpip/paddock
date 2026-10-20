const { it, before } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
let codec;
before(async () => { codec = await import(pathToFileURL(path.join(__dirname, '../client/src/lib/url-state.js'))); });

it('runner History is a reloadable view, never an executable URL action', () => {
  const search = '?session=msn-one&queue=open&runnerTab=history';
  assert.equal(codec.canonicalMissionSearch(search), search);
  assert.equal(new URLSearchParams(codec.canonicalMissionSearch('?session=msn-one&runnerTab=recreate')).has('runnerTab'), false);
});

it('round trips Unicode file context without treating colons as descriptor separators', () => {
  const value = codec.popupValue('file', '/root/a:b/日本語 notes.md');
  const search = codec.patchSearch('?scope=container&path=%2Froot&external=keep', { popup: value });
  assert.deepEqual(codec.parsePopups(search, '/agents/pad-test/workspace')[0].args, ['/root/a:b/日本語 notes.md']);
  assert.equal(new URLSearchParams(search).get('external'), 'keep');
  assert.equal(new URLSearchParams(search).get('scope'), 'container');
});
it('rejects unregistered/action popups, traversal, missing IDs and cross-page overlays', () => {
  for (const value of ['runner-settings:', 'runner-settings:a:b', 'run:r1', 'file:%2Froot%2F..%2Fsecret', 'runner-settings:%E0%A4%A']) {
    assert.deepEqual(codec.parsePopups(codec.patchSearch('', { popup: value }), '/mission'), []);
  }
  assert.deepEqual(codec.parsePopups('?popup=runner-settings:r1', '/vault'), []);
  assert.throws(() => codec.popupValue('file', '/root/../file'));
});
it('allowlists nested stacks and caps their depth without overlaying unrelated contexts', () => {
  const file = codec.popupValue('file', '/root/a.md');
  const move = codec.popupValue('file-move', '/root/a.md');
  assert.equal(codec.parsePopups(codec.patchSearch('', { popup: [file, move] }), '/agents/pad-test/workspace').length, 2);
  assert.equal(codec.parsePopups('?popup=project-new&popup=runner-new:p1', '/mission').length, 1);
  assert.equal(codec.parsePopups(codec.patchSearch('', { popup: [file, move, move, move] }), '/agents/pad-test/workspace').length, 2);
});
it('keeps listing and terminal owners independent and excludes unsupported filters', () => {
  assert.deepEqual(codec.missionView('?project=p2&view=project&session=s1&conversation=c1&terminalProject=p1&subfolders=1'), {
    project: 'p2', session: 's1', conversation: '', terminalProject: '', subfolders: true,
  });
  assert.equal(codec.missionView('?project=p2&view=all').project, '');
  assert.equal(codec.missionView('?session=%2Fbad').session, '');
});
it('patches owned query keys without dropping unrelated state or duplicating owned values', () => {
  const search = codec.patchSearch('?external=%C3%A9&session=old&session=older', { session: 'new', popup: ['project-new'] });
  assert.deepEqual(new URLSearchParams(search).getAll('session'), ['new']);
  assert.equal(new URLSearchParams(search).get('external'), 'é');
  assert.equal(new URLSearchParams(codec.patchSearch(search, { session: null })).has('session'), false);
});
it('login return targets cannot leave the app or restore API/action routes', () => {
  for (const value of ['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/api/agents', '/login?returnTo=/vault', '/setup']) {
    assert.equal(codec.safeReturnTo(value), '/agents');
  }
  assert.equal(codec.safeReturnTo('/mission?session=s1&popup=runner-settings:r1'), '/mission?session=s1&popup=runner-settings:r1');
});
it('canonicalizes malformed owned state with no change to a valid URL or unrelated parameters', () => {
  const valid = '?project=p1&view=project&session=s2&popup=runner-settings:r2&section=prompts&prompt=continue&external=keep';
  assert.equal(codec.canonicalMissionSearch(valid), valid);
  const canonical = codec.canonicalMissionSearch('?session=%2Fbad&conversation=c1&terminalProject=p1&section=bad&prompt=secret&external=keep');
  const p = new URLSearchParams(canonical);
  assert.equal(p.has('session'), false);
  assert.equal(p.has('section'), false);
  assert.equal(p.has('prompt'), false);
  assert.equal(p.get('conversation'), 'c1');
  assert.equal(p.get('external'), 'keep');
  assert.equal(codec.canonicalMissionSearch(canonical), canonical);
});
