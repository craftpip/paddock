/**
 * Small helpers and constants shared by the Mission modules. Nothing here
 * requires a sibling module, so every sibling can load it first.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  agentRow,
  assertMissionAgent,
  normalizeFolder,
  normalizePlansFolder,
  newId,
  newTmuxId,
  requireAgent,
  supportedTypes,
});

const crypto = require('crypto');
const path = require('path');
const { getDb } = require('../db');
const drivers = require('../drivers');
const registry = require('../agent-registry');
const { MissionError } = require('./errors');

/** Look up a PAD by name, throwing if not found (shared with plans.js). */
function requireAgent(name) {
  const agent = registry.getAgent(name);
  if (!agent) {
    throw new MissionError('mission_agent_not_found', `Agent not found: ${name}`);
  }
  return agent;
}

// The three coding models are the only agents that get Mission projects. The
// personal agents (openclaw, picoclaw, hermes) are deliberately excluded: the
// gate lives here, in the service, so an MCP client cannot walk around a UI
// filter. Adding a type later is one `mission: { supported: true }` flag on its
// driver — nothing else changes.
function assertMissionAgent(agentType) {
  const d = drivers.getDriver(agentType);
  if (!(d.mission && d.mission.supported)) {
    throw new MissionError(
      'mission_unsupported_agent',
      `${d.type} does not support Mission workspaces (supported: ${supportedTypes().join(', ')})`
    );
  }
  return d;
}

function supportedTypes() {
  return Object.values(drivers.drivers)
    .filter((d) => d.mission && d.mission.supported)
    .map((d) => d.type);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/** A tmux session name for a mission row: `msn-` + 8 hex chars. Matches
 *  app.js's SESSION_NAME_RE ([a-zA-Z0-9][a-zA-Z0-9._-]{0,63}) so the row id and
 *  the tmux name are both safe to pass to tmux unquoted. */
function newTmuxId() {
  return `msn-${crypto.randomBytes(4).toString('hex')}`;
}

const TMUX_RE = /^msn-[0-9a-f]{8}$/;

function normalizeFolder(folder) {
  let f = String(folder || '').trim();
  if (!f) throw new MissionError('mission_bad_folder', 'A project needs a folder');
  if (f.length > 1) f = f.replace(/\/+$/, '');
  if (!path.isAbsolute(f)) {
    throw new MissionError('mission_bad_folder', 'The folder must be an absolute path inside the agent');
  }
  if (f.includes('\n') || f.includes('\0')) {
    throw new MissionError('mission_bad_folder', 'The folder contains illegal characters');
  }
  return f;
}

/** The project's own plans directory, RELATIVE to its folder (plan 82). Unlike
 *  the folder it must NOT be absolute: it is the agent's working subfolder, so
 *  an absolute value or a `..` escape would point plans somewhere outside the
 *  project — the one thing the resolution code treats as a refusal. An empty
 *  value means "the default", never an error: every project in the database
 *  predates the choice, and the documented default IS what they all use. */
function normalizePlansFolder(plansFolder) {
  let p = String(plansFolder ?? '').trim();
  if (!p) return 'plans';
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (path.isAbsolute(p)) {
    throw new MissionError('mission_bad_plans_folder', 'The plans folder must be relative to the project folder');
  }
  if (p.split('/').some((s) => s === '.' || s === '..')) {
    throw new MissionError('mission_bad_plans_folder', '". " and ".." are not allowed in the plans folder');
  }
  if (p.includes('\n') || p.includes('\0')) {
    throw new MissionError('mission_bad_plans_folder', 'The plans folder contains illegal characters');
  }
  if (p.length > 120) throw new MissionError('mission_bad_plans_folder', 'The plans folder is too long');
  return p;
}

function agentRow(agentName) {
  const row = getDb().prepare('SELECT name, agent_type, status, owner_id FROM agents WHERE name = ?').get(agentName);
  if (!row) throw new MissionError('mission_agent_not_found', `No agent named ${agentName}`, 404);
  return row;
}

/** Plan 91 §Phase 2 — prompt-template persistence contract.
 *
 * Input (`promptTemplates` on create/update) is a COMPLETE five-key object or
 * nothing: `undefined` preserves current values (omitted on update, defaults
 * on create), explicit `null` resets the whole saved set to defaults, and any
 * other shape is a field-specific 400. Returns the TEXT to store (`JSON` or
 * `null` for defaults) or the sentinel `PRESERVE` when the caller omitted it.
 * Validated before any session is minted or row written. */
const PROMPT_TEMPLATES_PRESERVE = Symbol('preserve');

/**
 * Phase 3 Plan 90: Compute truthful scheduler state for UI feedback.
 * Returns { workerState, schedulerDecision, reason, nextCheckMs }.
 * workerState: 'working' | 'idle' | 'unknown'
 * schedulerDecision: 'dispatch' | 'wait_idle_grace' | 'wait_nudge_interval' | 'wait_turn_end' | 'paused' | 'observation_unavailable' | 'no_work' | 'finished'
 *
 * Plan 91 §Phase 5: a confirmed send the worker never takes must not wait
 * forever. The retry budget never exhausts while an operation is outstanding,
 * so `wait_turn_end` once persisted 12+ minutes on a startup whose repaint
 * confirmation was the TUI boot banner, not the input landing (proven live:
 * the prompt never reached the conversation's store). Bound it: an
 * outstanding instruction with a VERIFIED-IDLE worker, no exact receipt, and
 * a send older than RUNNER_NO_RESPONSE_TIMEOUT_MS escalates to need_input.
 * Never a resend, never a silent release — the human re-Runs. A working
 * worker is exempt (long tasks must not trip it), and anything but verified
 * idle stays suppressed rather than escalating on a guess.
 */
const RUNNER_NO_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

Object.assign(exports, { TMUX_RE, PROMPT_TEMPLATES_PRESERVE, RUNNER_NO_RESPONSE_TIMEOUT_MS });
