/**
 * MissionError: the one error type the Mission service throws. Its `code` is the
 * machine-readable contract REST and MCP callers branch on.
 */

// Mission (plan 53): projects are (agent, folder) pairs, and a session is the
// only unit of work — one live tmux session per row, running the agent's TUI in
// the project's folder, typed into by the human and the agent alike.
//
// This module is the STORE plus the validation rules. The tmux/docker half
// (start a session, send keys, capture the screen) lives in tmux.js and is wired
// in Phase 1, so the CRUD surface can be built and tested on its own.

/** An error with a machine-readable code, so routes and MCP tools can answer
 *  with the same shape the UI and the LLM both branch on. */
class MissionError extends Error {
  constructor(code, message, status = 400, meta = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    // Plan 88 §Phase 2: a delivery outcome is not a boolean. `attempted` says
    // whether input was written to the pane; `acceptance` says whether we could
    // CONFIRM receipt ('confirmed' | 'unknown' | 'refused'). Serialized verbatim
    // by the REST and MCP error paths so a caller can offer recovery without
    // guessing from the message text.
    if (meta && typeof meta === 'object') Object.assign(this, meta);
  }
}

Object.assign(exports, { MissionError });
