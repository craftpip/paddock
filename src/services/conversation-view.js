const path = require('node:path');

class ConversationViewError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// A metadata-only, exact, project-scoped history resolver. No tmux, sessions,
// runner operations, callbacks or message delivery are reachable from this read.
function resolveConversationView(project, agent, id, { read = (...args) => require('./agent-store').readActivity(...args) } = {}) {
  const fail = (code, message, status) => { throw new ConversationViewError(code, message, status); };
  if (!/^[\w.-]{1,160}$/.test(id || '')) fail('conversation_id_invalid', 'Invalid conversation ID.', 400);
  if (!agent) fail('conversation_agent_missing', 'The conversation owner is unavailable.', 404);
  const activity = read(agent, id);
  if (!activity.store?.available) {
    const missing = activity.store?.reason === 'session-not-found';
    fail(missing ? 'conversation_not_found' : 'conversation_unreadable',
      activity.store?.detail || 'Could not read this conversation.', missing ? 404 : 503);
  }
  // The JSONL reader can find a filename by substring or fall back to its only
  // file. Neither establishes identity; compare the transcript's own ID.
  if (activity.resolvedSessionId !== id) fail('conversation_not_found', 'The store did not resolve this exact conversation.', 404);
  if (!activity.directory) fail('conversation_scope_unknown', 'The conversation folder could not be verified.', 503);
  const root = path.posix.resolve(project.folder);
  const folder = path.posix.resolve(activity.directory);
  if (folder !== root && !(root === '/' ? folder.startsWith('/') : folder.startsWith(root + '/'))) {
    fail('conversation_not_found', 'This conversation does not belong to this project folder.', 404);
  }
  return {
    project,
    conversation: { id, title: activity.title || '', directory: folder, updatedAt: activity.lastActivityAt,
      messageCount: activity.messageCount },
  };
}

module.exports = { ConversationViewError, resolveConversationView };
