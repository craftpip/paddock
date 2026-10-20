const { it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveConversationView } = require('../services/conversation-view');
const project = { id: 'p1', folder: '/workspace/project', agent_name: 'pad-test' };
const agent = { name: 'pad-test', agent_type: 'opencode' };
const activity = { store: { available: true }, resolvedSessionId: 'c1', title: 'Saved', directory: '/workspace/project', lastActivityAt: '2026-10-15', messageCount: 4, lastMessage: { user: { text: 'secret prose' } } };
const resolve = (data) => resolveConversationView(project, agent, 'c1', { read: () => data });

it('returns metadata only for an exact authorized project conversation', () => {
  const result = resolve(activity);
  assert.equal(result.conversation.id, 'c1');
  assert.equal(result.conversation.title, 'Saved');
  assert.equal(JSON.stringify(result).includes('secret prose'), false);
});
it('accepts nested folders but refuses a different folder or prefix lookalike', () => {
  assert.equal(resolve({ ...activity, directory: '/workspace/project/sub' }).conversation.directory, '/workspace/project/sub');
  for (const directory of ['/workspace/project-other', '/other', '/workspace/project/../other']) {
    assert.throws(() => resolve({ ...activity, directory }), (e) => e.status === 404);
  }
});
it('a guessed only-file or substring match is not exact identity', () => {
  assert.throws(() => resolve({ ...activity, resolvedSessionId: 'someone-else', matched: 'only-file' }), (e) => e.status === 404);
  assert.throws(() => resolve({ ...activity, resolvedSessionId: 'c1-longer', matched: 'name' }), (e) => e.status === 404);
});
it('unreadable and unknown-folder reads are not reported as deletion', () => {
  assert.throws(() => resolve({ store: { available: false, reason: 'unreadable', detail: 'Offline' } }), (e) => e.status === 503);
  assert.throws(() => resolve({ ...activity, directory: null }), (e) => e.status === 503);
  assert.throws(() => resolve({ store: { available: false, reason: 'session-not-found' } }), (e) => e.status === 404);
});
it('invalid resource IDs are refused before invoking the store reader', () => {
  let reads = 0;
  assert.throws(() => resolveConversationView(project, agent, '../secret', { read: () => { reads++; } }), (e) => e.status === 400);
  assert.equal(reads, 0);
});
