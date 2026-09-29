/**
 * The plans facility (plan 64). A plan file lives in a PAD's workspace under
 * `plans/` and is the DURABLE record of a piece of work; the agent's own
 * conversation store is only the LIVE signal layered on top of it (see
 * agent-store.js). The file is the record on purpose: a `plans` table beside
 * `mission_sessions` would be a second source of truth that dies with the
 * container and disagrees with the file.
 *
 * The session binding lives in the file's own frontmatter, so a plan stays
 * readable with `exec cat` when these tools are not there at all.
 */
const fs = require('fs');
const path = require('path');

const registry = require('./agent-registry');
const { getDriver } = require('./drivers');
const { containerViewOf } = require('./vm-manager');
const workspace = require('./workspace');

// ONE definition of "where host scope starts" for this pad. Re-deriving it here
// would be the gate and the action disagreeing about the same folder again.
const hostBrowseRootFor = workspace.hostBrowseRoot;

const PLANS_DIR = 'plans';
const ARCHIVE_DIR = 'archive';

class PlansError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The host directory that holds a PAD's `plans/`, expressed as the webui sees
 * it. Three cases, and the difference matters:
 *
 *  - custom workspace mount → the mount's own source, mapped through
 *    `containerViewOf` because the host spelling may not be the webui's own
 *    view (`/www2` is mounted `:ro`; the project root is `.:/workspace:rw`, so
 *    writing to the host spelling alone fails EROFS with the gate wide open).
 *  - default workspace → the driver's workspace dir under the agent's data
 *    dir, which is where the AGENT looks, not the data dir root.
 *  - nothing resolvable → refuse with a reason instead of guessing a root.
 *
 * `agent` is required rather than inferred (plan 64 3d): three pads share
 * `/www1`, so "the workspace" has no single referent across the fleet.
 */
function plansRoot(agent) {
  if (!agent) throw new PlansError('plan_agent_not_found', 'Agent not found');
  const mount = agent.workspace_mount;
  if (mount && mount.host) {
    const view = containerViewOf(mount.host);
    if (!view) {
      // A mount from outside the project root has no host view at all — the same
      // refusal `workspace_write` gives, with the same wording source.
      throw new PlansError(
        'plan_workspace_not_host_visible',
        `The workspace of ${agent.name} is mounted from ${mount.host}, which the webui cannot reach on the host. ` +
        'Plans can only be kept for a PAD whose workspace is a folder the webui can see.'
      );
    }
    // Browsable, or not? The gate is the SAME one `workspace_write` uses, and
    // it applies to READING too: `plan_list` is not a new way to browse a pad
    // the user refused. Reading a plan file is reading that pad's workspace, and
    // the reason comes from the same field so both surfaces explain themselves
    // identically instead of one saying "policy" and the other "capability".
    if (mount.hostBrowsable === false) {
      throw new PlansError(
        'plan_workspace_not_host_visible',
        mount.hostBrowseReason ||
        `The workspace of ${agent.name} is not available for host browsing, so its plans cannot be read or written here.`
      );
    }
    return view;
  }
  const driver = getDriver(agent.agent_type);
  const dataDir = driver.dataDir || '';
  const wsDir = driver.workspaceDir || '';
  if (wsDir.startsWith(dataDir + '/')) {
    return path.join(agent.workspace_root, wsDir.slice(dataDir.length + 1));
  }
  if (!wsDir) return agent.workspace_root;
  // The driver's workspace is not under its data dir, so there is no host path
  // to speak of without the container.
  throw new PlansError(
    'plan_workspace_not_host_visible',
    `The workspace of ${agent.name} (${wsDir}) lives outside its data dir, so there is no host folder to keep plans in.`
  );
}

function requireAgent(name) {
  const agent = registry.getAgent(name);
  if (!agent) {
    throw new PlansError('plan_agent_not_found', `Agent not found: ${name}`);
  }
  return agent;
}

/** `plans` / `plans/archive` under the pad's workspace, created on first write. */
function plansDir(agent, { archive = false } = {}) {
  const root = path.join(plansRoot(agent), PLANS_DIR);
  return archive ? path.join(root, ARCHIVE_DIR) : root;
}

/**
 * Clamp a caller-supplied plan path to the pad's `plans/` folder. A plan path
 * is NOT a general workspace path: `../..` out of `plans/` must be refused even
 * though `workspace_write` would allow it inside its own root, or `plan_write`
 * becomes a general writer wearing a plan-shaped hat.
 */
function planPath(agent, relPath, { archive = false } = {}) {
  const raw = String(relPath == null ? '' : relPath).trim();
  if (!raw) throw new PlansError('plan_path_required', 'A plan path is required (e.g. "64-plans-facility.md").');
  if (raw.includes('\0')) throw new PlansError('plan_path_invalid', 'Invalid plan path.');
  if (path.isAbsolute(raw)) {
    throw new PlansError('plan_path_invalid', `A plan path is relative to the PAD's plans/ folder, not absolute: ${raw}`);
  }
  const base = plansDir(agent, { archive });
  const resolved = path.resolve(base, raw);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new PlansError('plan_path_invalid', `A plan path may not leave the plans/ folder: ${raw}`);
  }
  if (!resolved.endsWith('.md')) {
    throw new PlansError('plan_path_invalid', `A plan is a .md file: ${raw}`);
  }
  return resolved;
}

/** Relative-to-`plans/` form, as stored and reported. */
function planRel(agent, absPath, { archive = false } = {}) {
  const base = plansDir(agent, { archive });
  return path.relative(base, absPath).split(path.sep).join('/');
}

// --- frontmatter -----------------------------------------------------------
// A tiny, strict subset of YAML: `key: value` scalars, one per line, between
// `---` fences. Deliberately NOT a YAML parser — a plan's frontmatter is
// machine-written and machine-read, so an ambiguous value (a colon in a title,
// a quote that is not closed) has to be REFUSED rather than guessed at. A
// plan body is markdown and is never parsed.

const FRONTMATTER_KEYS = new Set(['session', 'created', 'started', 'last_activity', 'done']);

function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!match) return { data: {}, body: src };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!kv) {
      throw new PlansError('plan_frontmatter_invalid', `Frontmatter line is not "key: value": ${line}`);
    }
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
    if (!FRONTMATTER_KEYS.has(key)) {
      throw new PlansError('plan_frontmatter_invalid', `Unknown frontmatter key "${key}" (allowed: ${[...FRONTMATTER_KEYS].join(', ')}).`);
    }
    if (!value) continue;
    if (key !== 'session' && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value)) {
      throw new PlansError('plan_frontmatter_invalid', `Frontmatter "${key}" must be an ISO timestamp: ${value}`);
    }
    data[key] = value;
  }
  return { data, body: src.slice(match[0].length) };
}

function renderFrontmatter(data) {
  const lines = [];
  for (const key of ['session', 'created', 'started', 'last_activity', 'done']) {
    if (data[key]) lines.push(`${key}: ${data[key]}`);
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
}

/** Strip a leading frontmatter block so a `plan_write` body can replace the
 *  file without ever writing two blocks or duplicating the old one. */
function stripFrontmatter(text) {
  return parseFrontmatter(text).body.replace(/^\r?\n/, '');
}

/**
 * The plan's own `## Status:` header, which is the completion convention this
 * repo already uses. Read as DATA here so `plan_list` can answer "what is
 * finished" without the caller re-reading every file.
 */
function statusOf(body) {
  const m = /^##[ \t]+Status:[ \t]*(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

function titleOf(body) {
  const m = /^#[ \t]+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

/** Derived timings, so "is this stale?" is one field instead of date maths.
 *  `ageMs` = since created, `idleMs` = since last activity (a plan never
 *  touched has no idle time — reported as null, not as "infinitely idle"), and
 *  `elapsedMs` = since started until done. */
function timings(data, now = Date.now()) {
  const at = (v) => (v ? Date.parse(v) : NaN);
  const created = at(data.created);
  const started = at(data.started);
  const last = at(data.last_activity);
  const done = at(data.done);
  const num = (n) => (Number.isFinite(n) ? n : null);
  return {
    ageMs: num(created) ? now - created : null,
    idleMs: num(last) ? now - last : null,
    elapsedMs: num(started) ? (num(done) || now) - started : null,
  };
}

function describe(data, body, { now = Date.now(), relPath } = {}) {
  return {
    path: relPath,
    session: data.session || null,
    created: data.created || null,
    started: data.started || null,
    last_activity: data.last_activity || null,
    done: data.done || null,
    ...timings(data, now),
    title: titleOf(body),
    status: statusOf(body),
  };
}

/** One plan's frontmatter + header fields. Missing file → null, so a caller
 *  can tell "no such plan" from "a plan with no status". */
function readPlan(agent, relPath, { archive = false } = {}) {
  const abs = planPath(agent, relPath, { archive });
  if (!fs.existsSync(abs)) return null;
  const { data, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  // The body travels WITH the row. `describe` derives from it (title, status)
  // and threw it away, which left no way to read a plan's text through this
  // service at all — so a caller holding a plan name had to go back to
  // `exec cat`, i.e. the facility could create a plan and never read one back.
  return { abs, body, ...describe(data, body, { relPath: planRel(agent, abs, { archive }) }) };
}

/**
 * Every `*.md` in `plans/`, newest first by last activity (then created, then
 * name, so the order is total and stable). The `## Done` section of this repo's
 * own queue and the `done:` field agree: a plan with `done:` is finished.
 */
function listPlans(agent, { archive = false, now = Date.now() } = {}) {
  const dir = plansDir(agent, { archive });
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    // The harness README lives here too, and it is instructions rather than a
    // piece of work. Listing it would put a row with no `created` and no
    // `## Status:` in the middle of the working set, which reads as a plan
    // nobody wrote.
    if (entry.name.toLowerCase() === 'readme.md') continue;
    const abs = path.join(dir, entry.name);
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
      // A malformed frontmatter must not hide the plan from the listing — the
      // body is still the durable record. Report the reason on the row instead.
      rows.push({
        path: entry.name,
        session: null, created: null, started: null, last_activity: null, done: null,
        ageMs: null, idleMs: null, elapsedMs: null,
        title: null, status: null,
        unreadable: e.message,
        bytes: fs.statSync(abs).size,
      });
      continue;
    }
    rows.push({
      ...describe(parsed.data, parsed.body, { now, relPath: entry.name }),
      bytes: fs.statSync(abs).size,
    });
  }
  rows.sort((a, b) => {
    const key = (r) => Date.parse(r.last_activity || r.created || 0) || 0;
    const delta = key(b) - key(a);
    return delta !== 0 ? delta : a.path.localeCompare(b.path);
  });
  return rows;
}

/**
 * Write a plan, stamping the frontmatter. The BODY is the caller's — this never
 * rewrites prose. The stamps follow one rule each, because a wrong stamp is a
 * wrong answer later:
 *
 *  - `created`  set once, on first write, and never moved.
 *  - `started`  set once, when the plan first binds a session.
 *  - `session`  the session id given now; a plan re-bound to a new conversation
 *    keeps `started` (the work began then) but follows the new session.
 *  - `last_activity` always bumped to now — that is what makes `plan_list`'s
 *    "what is being worked on right now" answer true, and a write that failed
 *    to bump it makes a just-finished plan look abandoned.
 *  - `done`     only ever set, never cleared here: ending a plan is a human
 *    decision expressed by moving it to `plans/archive/`.
 */

/**
 * The harness prompt (the user's requirement, plan 64 §1): the agent works these
 * plans, so the folder has to explain itself to a reader that has never seen it.
 * Written ONCE, on the first plan, and never overwritten — instructions that
 * change under a caller who is mid-work are worse than no instructions at all.
 * Created through the workspace service, like the plan file itself, so the
 * harness prompt obeys the same gate as the thing it describes.
 */
// A markdown code span. Named once so the harness prompt below can be written as
// ordinary single-quoted strings and still contain backticks.
const BT = String.fromCharCode(96);

const README_BODY = [
  '# Plans',
  '',
  'One markdown file per piece of work. This folder is the durable record; a',
  'conversation is not — a session ends, a plan does not.',
  '',
  '## Writing one',
  '',
  'Use ' + BT + 'plan_write {agent, path, content, session?}' + BT + ':',
  '',
  'The folder is created on the first plan, and only then.',
  '',
  '- ' + BT + 'path' + BT + ' is a file name relative to this folder, e.g. ' + BT + '64-plans-facility.md' + BT + '. A',
  '  number prefix keeps the folder readable in order; it is not enforced.',
  '- ' + BT + 'content' + BT + ' is the body. Frontmatter is managed for you: ' + BT + 'created' + BT + ' is stamped on',
  '  the first write and never moves, ' + BT + 'last_activity' + BT + ' moves on every write, and ' + BT + 'session' + BT + ' / ' + BT + 'started' + BT + ' are',
  '  stamped when you pass a session id.',
  '- ' + BT + 'session' + BT + ' is the agent\'s own conversation id, so the plan can be joined to that',
  '  conversation later with ' + BT + 'plan_activity {agent, session_id}' + BT + '.',
  '',
  '## Keeping one honest',
  '',
  '- The body carries a ' + BT + '## Status:' + BT + ' line using this repo\'s vocabulary: ' + BT + 'Complete' + BT + ', ' + BT + 'In progress' + BT + ', ' + BT + 'Proposed' + BT + ', ' + BT + 'Blocked' + BT + ', ' + BT + 'Draft' + BT + '.',
  '- Update the plan when the work moves, not at the end. A plan written once and',
  '  never touched is a note.',
  '- One plan is one piece of work. If it needs an "and also", it is two plans.',
  '',
  '## Ending one',
  '',
  'Rewrite it with its final state, then move the file into ' + BT + 'archive/' + BT + '. Read the',
  'ended ones with ' + BT + 'plan_list {agent, archive: true}' + BT + '; an archive that still turns up in',
  'the working list is a plan nobody closed.',
  '',
].join('\n');

async function ensureReadme(agent, base) {
  const abs = path.join(base, 'README.md');
  if (fs.existsSync(abs)) return;
  const rel = path.relative(hostBrowseRootFor(agent), abs).split(path.sep).join('/');
  await workspace.writeFile(agent.name, rel, README_BODY, 'host');
}

/**
 * Write a plan. The file is produced BY the workspace service, not by a private
 * `fs.writeFileSync` here — one gate, one reason, one place (plan 64 3a/3d).
 * A direct write here would be a writer that never asks whether the pad's
 * workspace may be browsed, so `plan_write` would put a file on a pad the user
 * had refused, while `workspace_write` on the same pad says no. The mkdir goes
 * through the same service for the same reason: creating `plans/` IS a write.
 */
async function writePlan(agent, relPath, body, { session, now = Date.now() } = {}) {
  const abs = planPath(agent, relPath);
  // MILLISECOND resolution, deliberately. Truncating to whole seconds made
  // `last_activity` unchanged by two writes inside the same second — which is a
  // normal thing for an agent to do while editing one plan — and that field is
  // exactly what answers "what is being worked on right now". A stamp that
  // cannot move is a field that lies.
  const stamp = new Date(now).toISOString();
  const existing = fs.existsSync(abs) ? parseFrontmatter(fs.readFileSync(abs, 'utf8')).data : {};
  const data = {
    ...existing,
    created: existing.created || stamp,
    last_activity: stamp,
  };
  if (session) {
    data.session = session;
    data.started = existing.started || stamp;
  }
  const text = renderFrontmatter(data) + body;
  const base = hostBrowseRootFor(agent);
  const relToBrowseRoot = path.relative(base, abs).split(path.sep).join('/');
  await workspace.createDirectories(agent.name, path.posix.dirname(relToBrowseRoot), 'host');
  await ensureReadme(agent, plansDir(agent));
  await workspace.writeFile(agent.name, relToBrowseRoot, text, 'host');
  return { abs, ...describe(data, body, { now, relPath: planRel(agent, abs) }) };
}

/**
 * Stamp each plan row with the live/dead state of the conversation it is bound
 * to. A plan is the durable record of a piece of work, and "is the conversation
 * behind it still running?" is the question that makes a stale list actionable —
 * a plan from three weeks ago and one from a session you are in right now look
 * identical in the file.
 *
 * The truth comes from the Mission service, NOT from a second probe here. Two
 * reasons, and the second is the one that bites: mission owns the fields
 * (`live`, `open`, `busy`, `busyKnown`) and re-deriving any of them produces a
 * second source of truth that was written before the field existed; and the
 * busy probe is scoped to (PAD, folder), so a stamp computed from the plan's
 * folder rather than the session's project would answer about the wrong
 * conversation.
 *
 * A plan whose session has no Mission row is NOT dead — the conversation may
 * have been started outside the page. `sessionLive: null` says "unknown", and
 * `sessionTracked: false` says why.
 */
const UNTRACKED = {
  sessionTracked: false, sessionLive: null, sessionOpen: null, sessionBusy: null, sessionBusyKnown: null,
  sessionProject: null,
};

/** The project a plan belongs to, via the conversation it is worked in. Plan
 *  FILES live in the pad's workspace, not in a mission project's folder, so the
 *  link is the session's project — a second source of truth per folder would be
 *  a thing to keep in step with the roster. */
function projectOf(session) {
  const p = session && session.project;
  if (!p) return null;
  return { id: p.id, name: p.name, folder: p.folder };
}

/** Keep only the plans worked in one mission project (plan 64 \u00a73f). Rows whose
 *  session is untracked CANNOT be attributed, so they are counted rather than
 *  dropped silently: a short answer that looks complete is the exact failure the
 *  folder filter exists to avoid. */
function scopeByProjectFolder(rows, folder) {
  if (!folder) return { rows, unattributed: 0 };
  const want = String(folder);
  const keep = [];
  let unattributed = 0;
  for (const r of rows) {
    if (!r.sessionProject) { unattributed++; continue; }
    if (r.sessionProject.folder === want) keep.push(r);
  }
  return { rows: keep, unattributed };
}

async function withSessionState(agent, rows) {
  if (!rows || !rows.length) return rows || [];
  const ids = new Set(rows.map((r) => r.session).filter(Boolean));
  if (!ids.size) return rows;

  const mission = require('./mission');
  let sessions = [];
  try {
    sessions = await mission.withLiveSessions(
      mission.listSessionsForAgent(agent.name),
      agent.name
    );
    sessions = await mission.withAgentBusy(
      sessions,
      () => agent.name,
      (s) => s.project?.folder || s.directory || s.cwd || null
    );
  } catch {
    // The plans folder is on disk and the store is the answer about WORK; a
    // tmux probe failing is a gap in the liveness stamp, not a reason to fail
    // the read. Say "unknown" per row instead of pretending.
    return rows.map((r) => (r.session ? { ...r, ...UNTRACKED } : r));
  }

  const byAgentSession = new Map();
  for (const s of sessions) {
    if (s.agent_session_id) byAgentSession.set(s.agent_session_id, s);
  }
  return rows.map((r) => {
    if (!r.session) return { ...r, sessionTracked: false, sessionLive: null };
    const s = byAgentSession.get(r.session);
    // Every field present, every one null. A MISSING field and a null one are
    // different to a caller: absent reads as 'this version does not say', null
    // reads as 'it says it does not know'.
    if (!s) return { ...r, ...UNTRACKED };
    return {
      ...r,
      sessionTracked: true,
      sessionLive: !!s.live,
      sessionOpen: !!s.open,
      sessionBusy: !!s.busy,
      sessionBusyKnown: s.busyKnown !== false,
      sessionLabel: s.label || null,
      sessionProject: projectOf(s),
    };
  });
}

module.exports = {
  PlansError,
  PLANS_DIR,
  ARCHIVE_DIR,
  plansRoot,
  plansDir,
  planPath,
  planRel,
  parseFrontmatter,
  renderFrontmatter,
  stripFrontmatter,
  statusOf,
  titleOf,
  timings,
  describe,
  readPlan,
  listPlans,
  withSessionState,
  scopeByProjectFolder,
  writePlan,
  requireAgent,
};
