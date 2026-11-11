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
const crypto = require('crypto');

const registry = require('./agent-registry');
const { getDriver } = require('./drivers');
const { containerViewOf, webuiMountViewOf } = require('./vm-manager');
const workspace = require('./workspace');
const { mkdirOwned, writeFileOwned, atomicWriteOwned } = require('./ownership');

// ONE definition of "where host scope starts" for this pad. Re-deriving it here
// would be the gate and the action disagreeing about the same folder again.
const hostBrowseRootFor = workspace.hostBrowseRoot;

const PLANS_DIR = 'plans';
const ARCHIVE_DIR = 'archive';

/** Files that carry the FOLDER's own instructions rather than a piece of work.
 *  `README.md` predated plans (the old harness note); `INDEX.md` and `QUEUE.md`
 *  are plan 82's project entry files. All three are skipped in listings and
 *  refused as `path` values, so `plan_write` can never clobber the folder's
 *  own voice with a plan body. */
const RESERVED_PLAN_NAMES = new Set(['readme.md', 'index.md', 'queue.md']);

/** The lifecycle a plan moves through (plan 82). Exactly five values, and the
 *  `## Status:` headers this repo already uses are folded onto them:
 *
 *    new  ← "Proposed", "Draft", "new"
 *    in progress
 *    blocked
 *    need clarification  ("needs clarification" too)
 *    done ← "Complete", "done", "finished", "review"
 *
 *  An unrecognized header is NEVER folded onto any of the five — coercing it
 *  would assert a lifecycle step nobody chose. It passes through verbatim as
 *  `status` (exactly what the row used to say) and `statusRaw` keeps the
 *  spelling either way, so no information is lost by either route. */
const PLAN_STATUSES = ['new', 'in progress', 'blocked', 'need clarification', 'done'];
const STATUS_RULES = [
  [/^(complete|done|finished|review)\b/i, 'done'],
  [/^in progress\b/i, 'in progress'],
  [/^need(?:s)? clarification\b/i, 'need clarification'],
  [/^blocked\b/i, 'blocked'],
  [/^(new|proposed|draft)\b/i, 'new'],
];

function planStatus(raw) {
  const text = raw == null ? '' : String(raw);
  for (const [re, value] of STATUS_RULES) {
    if (re.test(text)) return value;
  }
  return null;
}

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

/**
 * The HOST directory that holds one project's plans — `<folder>/<plans_folder>`
 * mapped onto the webui's own filesystem (plan 82). This is what makes a plan
 * part of the project rather than the pad: the folder IS the scope, so two
 * projects on one pad can never see each other's plans through this surface.
 *
 * Mapping rules, split by layout:
 *
 *  - custom workspace mount (meta WORKSPACE_HOST/DIR + HOST_BROWSE=1): the
 *    project folder must sit under the mount's CONTAINER path, and the mount's
 *    host source is looked up through `containerViewOf` exactly like
 *    `plansRoot` does for the pad root. A mount the webui cannot see (e.g.
 *    `/www1`) is refused the same way `plansRoot` refuses it: permission cannot
 *    buy a capability, and a plan written to a host path the webui does not
 *    mount would vanish the moment it was written.
 *
 *  - default layout: the project folder must sit under the driver's workspace
 *    dir, whose host twin lives under the agent data dir — the same mapping the
 *    pad-root case starts from, with the project's own folder (and, again, its
 *    own plans folder) appended.
 *
 *  - an out-of-scope folder (the project's folder is outside the workspace it
 *    was created on) is REFUSED rather than guessed: `containerViewOf`/path
 *    arithmetic can be made to say anything, but only the project's own folder
 *    is where a plan belongs.
 */
function projectPlansRoot(agent, project) {
  if (!project) return null;
  const pf = normalizePlansFolderShorthand(project.plans_folder);
  const folder = String(project.folder || '').replace(/\/+$/, '');
  const mount = agent.workspace_mount;
  if (mount && mount.host) {
    const cb = String(mount.container || '').replace(/\/+$/, '');
    const under = !!cb && (folder === cb || folder.startsWith(cb + '/'));

    // (A) The project folder sits UNDER the PAD's own workspace mount: map the
    //     mount's HOST source onto the webui view, then append the folder's
    //     relative path and the plans folder (the original /www1 case).
    if (under) {
      const rel = folder === cb ? '' : folder.slice(cb.length + 1);
      // 1. Project-root mapping: HOST_WORKSPACE → WORKSPACE (rw), covers /www2/paddock.
      const cv = containerViewOf(mount.host);
      if (cv) return path.join(cv, rel, pf);
      // 2. Webui's actual bind mounts: match the pad's workspace dir (cb) against
      //    the webui's own mountpoints. Longest prefix wins. The user mounts the
      //    same folder spelling into both pad and webui, so the spellings coincide.
      let wv = webuiMountViewOf(cb);
      if (!wv) wv = webuiMountViewOf(mount.host); // same string in compose
      if (wv) {
        if (wv.readonly) {
          throw new PlansError(
            'plan_workspace_read_only',
            `The webui sees ${mount.host} read-only; plan files cannot be written there.`
          );
        }
        return path.join(wv.view, rel, pf);
      }
      // Genuinely unmounted host-side — same refusal as before.
      plansRoot(agent); // throws plan_workspace_not_host_visible
    }

    // (B) The project folder is OUTSIDE the PAD's workspace mount — a second
    //     volume the PAD reaches but the primary mount does not cover (e.g.
    //     `/www2/paddock` while the PAD's workspace is `/www1`). Resolve the
    //     FOLDER itself, never by joining it onto the workspace mount (which
    //     built a phantom `/www1/www2/...` tree the webui never had — plan 86).
    //     1. The project-root mapping (HOST_WORKSPACE → WORKSPACE) covers the
    //        paddock project, whose folder IS the webui's rw `/workspace` bind;
    //        its spelling (`/www2/paddock`) is the host spelling, not a webui
    //        mountpoint, so a mountpoint-only match would wrongly land on the
    //        `:ro` `/www2` mount.
    const cvb = containerViewOf(folder);
    if (cvb) return path.join(cvb, pf);
    //     2. Otherwise match the folder's own spelling against the webui's
    //        mounts (longest prefix wins), and report a `:ro` cover clearly.
    const fv = webuiMountViewOf(folder);
    if (fv) {
      if (fv.readonly) {
        throw new PlansError(
          'plan_workspace_read_only',
          `The webui sees ${folder} read-only; plan files cannot be written there.`
        );
      }
      return path.join(fv.view, pf);
    }

    // (C) The webui has no mount covering this folder at all — refuse rather
    //     than guess a host root.
    plansRoot(agent); // throws plan_workspace_not_host_visible
  }
  const driver = getDriver(agent.agent_type);
  const dataDir = driver.dataDir || '';
  const wsDir = driver.workspaceDir || '';
  if (wsDir.startsWith(dataDir + '/')) {
    const wsHost = path.join(agent.workspace_root, wsDir.slice(dataDir.length + 1));
    if (!(folder === wsDir || folder.startsWith(wsDir + '/'))) {
      throw new PlansError(
        'plan_project_folder_outside_workspace',
        `The project folder ${folder} is not inside the driver workspace (${wsDir}) on ${agent.name}, so its plans would live outside the workspace. Repoint the project folder or pick another project.`
      );
    }
    const rel = folder === wsDir ? '' : folder.slice(wsDir.length + 1);
    return path.join(wsHost, rel, pf);
  }
  // No driver workspace dir: the data dir itself is the workspace (plansRoot's
  // `!wsDir` fallback), and its host twin is the agent's own data dir.
  if (!wsDir) {
    if (!(folder === agent.workspace_root || folder.startsWith(agent.workspace_root + '/'))) {
      throw new PlansError(
        'plan_project_folder_outside_workspace',
        `The project folder ${folder} is not inside the workspace of ${agent.name}, so its plans would live outside the workspace. Repoint the project folder or pick another project.`
      );
    }
    const rel = folder === agent.workspace_root ? '' : folder.slice(agent.workspace_root.length + 1);
    return path.join(agent.workspace_root, rel, pf);
  }
  // The driver's workspace is not under its data dir — same refusal as the pad
  // root case; there is no host folder to keep plans in.
  plansRoot(agent); // throws
}

/** `plan_project.plans_folder` may be missing on rows that predate the column
 *  migration — but it defaults in the database, so treat a missing value as the
 *  same default rather than building a path with a hole in it. */
function normalizePlansFolderShorthand(plansFolder) {
  const p = String(plansFolder ?? '').trim().replace(/\/+$/, '');
  return p || 'plans';
}

/** `plans` / `plans/archive` under the pad's workspace — or, when `project` is
 *  given, under that project's own `<folder>/<plans_folder>`. Created on first
 *  write. */
function plansDir(agent, { archive = false, project } = {}) {
  const root = project
    ? projectPlansRoot(agent, project)
    : path.join(plansRoot(agent), PLANS_DIR);
  return archive ? path.join(root, ARCHIVE_DIR) : root;
}

/**
 * Clamp a caller-supplied plan path to the plans folder (of the pad, or of one
 * project). A plan path is NOT a general workspace path: `../..` out of the
 * folder must be refused even though `workspace_write` would allow it inside
 * its own root, or `plan_write` becomes a general writer wearing a plan-shaped
 * hat. The reserved entry files are likewise refused as `path` values.
 */
/** Resolve `p` to a canonical path even when it (or part of it) does not exist
 *  yet: realpath the deepest EXISTING ancestor, then re-attach the tail. A
 *  symlink is thereby followed wherever the filesystem would follow it, so a
 *  plan path can be checked against the folder it will ACTUALLY land in rather
 *  than the string it was spelled with. (Plan 82: `planPath`'s lexical check is
 *  a string test, and a symlink inside `plans/` pointing out of it passes that
 *  test and then the write follows it out.) */
function realResolve(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function withinBase(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

function planPath(agent, relPath, { archive = false, project } = {}) {
  const raw = String(relPath == null ? '' : relPath).trim();
  if (!raw) throw new PlansError('plan_path_required', 'A plan path is required (e.g. "64-plans-facility.md").');
  if (raw.includes('\0')) throw new PlansError('plan_path_invalid', 'Invalid plan path.');
  if (path.isAbsolute(raw)) {
    throw new PlansError('plan_path_invalid', `A plan path is relative to the plans folder, not absolute: ${raw}`);
  }
  if (RESERVED_PLAN_NAMES.has(raw.toLowerCase())) {
    throw new PlansError('plan_reserved_name', `"${raw}" is reserved for the folder's own entry file and cannot be a plan.`);
  }
  const base = plansDir(agent, { archive, project });
  const resolved = path.resolve(base, raw);
  // The reserved check above compares the string as typed, so `./QUEUE.md`
  // or `x/../INDEX.md` walked straight past it. Check the file it resolves to.
  if (path.dirname(resolved) === base && RESERVED_PLAN_NAMES.has(path.basename(resolved).toLowerCase())) {
    throw new PlansError('plan_reserved_name', `"${raw}" is reserved for the folder's own entry file and cannot be a plan.`);
  }
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new PlansError('plan_path_invalid', `A plan path may not leave the plans folder: ${raw}`);
  }
  if (!resolved.endsWith('.md')) {
    throw new PlansError('plan_path_invalid', `A plan is a .md file: ${raw}`);
  }
  // Follow symlinks before trusting the containment above.
  if (!withinBase(realResolve(base), realResolve(resolved))) {
    throw new PlansError('plan_path_invalid', `A plan path must stay inside the plans folder: ${raw}`);
  }
  return resolved;
}

/** Relative-to-plans-folder form, as stored and reported. */
function planRel(agent, absPath, { archive = false, project } = {}) {
  const base = plansDir(agent, { archive, project });
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
 * The plan's own `## Status:` header verbatim, which is the completion
 * convention this repo already uses. Read as DATA here so `plan_list` can
 * answer "what is finished" without the caller re-reading every file.
 */
function statusRawOf(body) {
  const m = /^##[ \t]+Status:[ \t]*(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

/** The canonical lifecycle value for the header, un-recognized text passed
 *  through verbatim (see `planStatus` above for why it is never coerced). */
function statusOf(body) {
  const raw = statusRawOf(body);
  return planStatus(raw) ?? raw;
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
  const raw = statusRawOf(body);
  return {
    path: relPath,
    session: data.session || null,
    created: data.created || null,
    started: data.started || null,
    last_activity: data.last_activity || null,
    done: data.done || null,
    ...timings(data, now),
    title: titleOf(body),
    // `status` is the canonical five-value lifecycle word when the header
    // matches one, otherwise the header verbatim; `statusRaw` is ALWAYS the
    // header verbatim. The pair exists because the canonical form is what a
    // caller branches on (`status === 'done'`) and a raw 'Complete (2026-01-01)'
    // would silently never equal it.
    status: planStatus(raw) ?? raw,
    statusRaw: raw,
  };
}

/** One plan's frontmatter + header fields. Missing file → null, so a caller
 *  can tell "no such plan" from "a plan with no status". */
function readPlan(agent, relPath, { archive = false, project } = {}) {
  const abs = planPath(agent, relPath, { archive, project });
  if (!fs.existsSync(abs)) return null;
  const { data, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  // The body travels WITH the row. `describe` derives from it (title, status)
  // and threw it away, which left no way to read a plan's text through this
  // service at all — so a caller holding a plan name had to go back to
  // `exec cat`, i.e. the facility could create a plan and never read one back.
  return { abs, body, ...describe(data, body, { relPath: planRel(agent, abs, { archive, project }) }) };
}

/**
 * Every `*.md` in the plans folder, newest first by last activity (then created,
 * then name, so the order is total and stable). The `## Done` section of this
 * repo's own queue and the `done:` field agree: a plan with `done:` is finished.
 */
function listPlans(agent, { archive = false, now = Date.now(), project } = {}) {
  const dir = plansDir(agent, { archive, project });
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // `isFile()` is FALSE for a symlinked entry, so a symlink inside the folder
    // is skipped here too — following it would serve a file from outside under
    // a plan's name.
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    // The folder's own entry files (README/INDEX/QUEUE) are instructions rather
    // than a piece of work. Listing them would put a row with no `created` and
    // no `## Status:` in the middle of the working set, which reads as a plan
    // nobody wrote. They are refusable as paths too, so this is one rule.
    if (RESERVED_PLAN_NAMES.has(entry.name.toLowerCase())) continue;
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
        title: null, status: null, statusRaw: null,
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
 * The folder's own entry file (plan 82: `INDEX.md`). The agent works these
 * plans, so the folder has to explain itself to a reader that has never seen
 * it: where it is, what a plan is, and the five lifecycle states a `## Status:`
 * header can hold. Written ONCE, on the first plan, and never overwritten —
 * instructions that change under a caller who is mid-work are worse than no
 * instructions at all. Created through the workspace service, like the plan
 * file itself, so it obeys the same gate as the thing it describes.
 */
// A markdown code span. Named once so the entry body below can be written as
// ordinary single-quoted strings and still contain backticks.
const BT = String.fromCharCode(96);

/** The `INDEX.md` body for one folder. Interpolated because requirement 1 of the
 *  entry file is "who we are" — a folder has to name the project and PAD it
 *  belongs to, or the LLM reading it cannot tell whose plans these are. */
function indexBody(agent, project) {
  const where = project
    ? [
        '- Project: ' + (project.name || '(unnamed)'),
        '- PAD: ' + agent.name + ' (' + (agent.agent_type || 'agent') + ')',
        '- Project folder: ' + (project.folder || '(unknown)'),
        '- Plans folder: ' + (project.folder || '') + '/' + normalizePlansFolderShorthand(project.plans_folder),
      ]
    : [
        '- PAD: ' + agent.name + ' (' + (agent.agent_type || 'agent') + ')',
        '- This is the PAD-wide plans folder, not tied to one Mission project.',
      ];
  return [
    '# Plans',
    '',
    'One markdown file per piece of work. This folder is the durable record; a',
    'conversation is not — a session ends, a plan does not.',
    '',
    '## Who we are',
    '',
    ...where,
    '',
    '## Writing one',
    '',
    'Use ' + BT + 'plan_write {agent, project_id, path, content, session?}' + BT + ':',
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
    '## Statuses',
    '',
    'The body\'s ' + BT + '## Status:' + BT + ' line carries one of five lifecycle states, and they are',
    'the only five:',
    '',
    '- ' + BT + 'new' + BT + ' — recently added; pick it up in queue order.',
    '- ' + BT + 'in progress' + BT + ' — being worked; keep going.',
    '- ' + BT + 'blocked' + BT + ' — needs intervention. **STOP**: do not proceed to the next',
    '  queue item.',
    '- ' + BT + 'need clarification' + BT + ' — a question must be asked or sorted. Surface it',
    '  and wait.',
    '- ' + BT + 'done' + BT + ' — the task is done; move it to review/next.',
    '',
    'Update the status when the work moves, not at the end. A plan written once and',
    'never touched is a note. ' + BT + 'blocked' + BT + ' and ' + BT + 'need clarification' + BT + ' are stop states — record the',
    'reason and stop.',
    '',
    '## The queue',
    '',
    'Execution order, parser format and the runner\'s instructions live in',
    BT + 'QUEUE.md' + BT + ' in this folder when it exists. A plan that is ' + BT + 'blocked' + BT + ' or needs',
    'clarification must be reflected there as ' + BT + 'need input' + BT + ' with its reason. Do not keep',
    'a second queue here.',
    '',
    '## Ending one',
    '',
    'Rewrite it with its final state, then move the file into ' + BT + 'archive/' + BT + '. Read the',
    'ended ones with ' + BT + 'plan_list {agent, project_id, archive: true}' + BT + '; an archive that still',
    'turns up in the working list is a plan nobody closed.',
    '',
  ].join('\n');
}

async function ensureIndex(agent, base, project) {
  const abs = path.join(base, 'INDEX.md');
  if (fs.existsSync(abs)) return;
  const text = indexBody(agent, project);
  if (project) {
    mkdirOwned(path.dirname(abs), { boundary: base });
    writeFileOwned(abs, text, { boundary: base });
  } else {
    const rel = path.relative(hostBrowseRootFor(agent), abs).split(path.sep).join('/');
    await workspace.createDirectories(agent.name, path.posix.dirname(rel), 'host');
    await workspace.writeFile(agent.name, rel, text, 'host');
  }
}

/**
 * Initialize one project's plans folder and its `INDEX.md`, at CREATE time (plan
 * 82 Phase 5) — the same write-once entry file `writePlan` would create lazily,
 * now awaited by the creation flow so the folder exists the moment a project
 * does. Both the REST route and the MCP `mission_project_create` call THIS, so
 * the two surfaces cannot drift into two different entry files.
 *
 * Idempotent and non-destructive: an existing `INDEX.md` is left exactly as it
 * is (instructions that change under a mid-work caller are worse than none), and
 * a project whose plans folder already exists is untouched. Returns what it did
 * so the caller can REPORT the outcome rather than swallow it — a create must
 * not fail just because the workspace happened to be unwritable, but it must not
 * pretend the initialization happened either.
 */
async function initProjectPlans(agentName, project) {
  const agent = requireAgent(agentName);
  if (!project) return { created: false, dir: null, reason: 'no-project' };
  const base = plansDir(agent, { project });
  const abs = path.join(base, 'INDEX.md');
  const existed = fs.existsSync(abs);
  await ensureIndex(agent, base, project);
  return { created: !existed, dir: base, indexPath: abs };
}

/* ---------------------------------------------------------------- */
/*  QUEUE CONTRACT — plan 83 Phase 2                                */
/* ---------------------------------------------------------------- */

/** Queue file name. */
const QUEUE_FILENAME = 'QUEUE.md';

/** Markers that fence the machine-readable JSON block. */
const QUEUE_MARKERS = {
  start: '<!-- paddock-queue:start -->',
  end: '<!-- paddock-queue:end -->',
};

/** Supported queue version. */
const QUEUE_VERSION = 1;

/** Allowed item statuses. */
const QUEUE_ITEM_STATUSES = Object.freeze(['new', 'in progress', 'need input', 'done']);
/** Queue-level guidance is included verbatim in a worker prompt. Keep its limit
 * aligned with a single prompt template so one saved queue cannot dominate it. */
const QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

/** Queue paused marker file name. Exists when supervisor will NOT dispatch. */
const QUEUE_PAUSED_FILENAME = 'QUEUE.paused';

/** Compute the absolute path of the queue paused marker for a project. */
function queuePausedPath(agent, project) {
  return path.join(plansDir(agentObjOf(agent), { project }), QUEUE_PAUSED_FILENAME);
}

/** Create or remove the QUEUE.paused marker (best-effort). */
function setQueuePausedMarker(agent, project, paused) {
  const abs = queuePausedPath(agent, project);
  const base = plansDir(agentObjOf(agent), { project });
  try {
    if (paused) {
      mkdirOwned(path.dirname(abs), { boundary: base });
      writeFileOwned(abs, `# QUEUE.paused\nThis file exists while the supervisor is paused.\n`, { boundary: base });
    } else {
      fs.unlinkSync(abs);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[plans] queue pause marker:`, e.message);
  }
}

/** Resolve an `agent` argument that may be a NAME string or an agent OBJECT.
 *  The read/write helpers accept both (callers hold one or the other), and the
 *  one thing they must never do is hand an object to `requireAgent`. */
function agentObjOf(agent) {
  return typeof agent === 'string' ? requireAgent(agent) : agent;
}

/** Normalize a runner queue filename and prove it stays in this project's plans
 * folder, including through a symlinked subdirectory. */
function normalizeQueueFile(agent, project, queueFile = QUEUE_FILENAME) {
  const raw = String(queueFile == null ? '' : queueFile).trim() || QUEUE_FILENAME;
  if (raw.includes('\0') || path.isAbsolute(raw) || !raw.toLowerCase().endsWith('.md')) {
    throw new PlansError('runner_queue_file_invalid', `Queue file must be a relative Markdown path inside the plans folder: ${raw}`);
  }
  const base = plansDir(agentObjOf(agent), { project });
  const resolved = path.resolve(base, raw);
  if (!withinBase(base, resolved) || !withinBase(realResolve(base), realResolve(resolved))) {
    throw new PlansError('runner_queue_file_invalid', `Queue file must stay inside the plans folder: ${raw}`);
  }
  return path.relative(base, resolved).split(path.sep).join('/');
}

/**
 * May a runner take this file as its queue file? The runner WRITES the file
 * (it is a generated projection of the server's queue), so it must not be the
 * folder's own entry file, and must not be a file someone wrote by hand: a
 * runner created with queue file `INDEX.md`, or in a folder that already held
 * a hand-written QUEUE.md, used to replace that file without a word.
 * A missing file, or one Paddock generated earlier, is fine.
 */
function assertQueueFileClaimable(agent, project, queueFile = QUEUE_FILENAME) {
  const rel = normalizeQueueFile(agent, project, queueFile);
  const base = path.basename(rel).toLowerCase();
  if (base === 'index.md' || base === 'readme.md') {
    throw new PlansError('runner_queue_file_invalid', `${rel} is the plans folder's own entry file and cannot be a runner's queue file.`);
  }
  const abs = queuePath(agent, project, queueFile);
  let text = null;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (text !== null && text.trim() !== '' && !text.includes('> Generated by Paddock.')) {
    throw new PlansError('runner_queue_file_exists', `${rel} already exists and was not generated by Paddock. Move or rename it, or choose another queue file name; a runner overwrites its queue file.`);
  }
  return rel;
}

/** Compute the absolute path of a project's queue file. The optional filename
 * preserves the direct queue tools' legacy QUEUE.md behavior. */
function queuePath(agent, project, queueFile = QUEUE_FILENAME) {
  return path.join(plansDir(agentObjOf(agent), { project }), normalizeQueueFile(agent, project, queueFile));
}

/** SHA-256 content hash for compare-and-swap. */
function queueHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Generated QUEUE.md template (plan 83 §141-203).
 * Created once per project when the queue is first initialised.
 */
function queueTemplate(agent, project) {
  const where = project
    ? `- Project: ${project.name || '(unnamed)'}\n- PAD: ${agent.name} (${agent.agent_type || 'agent'})\n- Project folder: ${project.folder || '(unknown)'}\n- Plans folder: ${project.folder || ''}/${normalizePlansFolderShorthand(project.plans_folder)}`
    : `- PAD: ${agent.name} (${agent.agent_type || 'agent'})\n- This is the PAD-wide plans folder, not tied to one Mission project.`;

  return [
    '# Plan queue',
    '',
    'Read this file and `INDEX.md` before starting or resuming work. `INDEX.md` explains',
    'how to maintain plans; this file explains how to run this queue.',
    '',
    '## Worker rules',
    '',
    '1. Read the whole queue before acting. Work one item per turn.',
    '2. If ANY item is `need input`, stop immediately. Explain its `reason` to the',
    '   human, keep this session open, and wait. Never skip it to do later items.',
    '3. Resume the `in progress` item first. Otherwise take the first `new` item and',
    '   write `in progress` BEFORE doing work. Keep one item in progress at a time;',
    '   if more than one is marked, resume the earliest.',
    '4. Read the referenced plan and follow INDEX.md\'s plan lifecycle. Keep the plan\'s',
    '   progress current. Mark a queue item `done` only when its required work and',
    '   verification are complete under those rules. Finishing a chat turn is not done.',
    '5. When blocked or needing clarification, update the plan and set this item to',
    '   `need input`. Put the exact question or required intervention in `reason`.',
    '   Then stop. Do not guess, skip the item, or clear your own blocker.',
    '6. Work exactly ONE item per turn/session instruction, then end your turn —',
    '   the supervisor sends the next task; do not take a second item yourself.',
    '7. Before starting an item, check that a file named `QUEUE.paused` does not',
    '   exist here. If it does, do not start another item — stop and wait.',
    '8. When every item is done, report completion and wait. Do not invent work.',
    '9. After the human resolves a blocker, they explicitly resume/requeue the item.',
    '   Re-read the updated queue on Start; do not assume an old answer still applies.',
    '',
    '## Editing rules — keep the parser working',
    '',
    '- Preserve the two markers and exactly one JSON block between them.',
    '- Keep `version` equal to 1 and use the exact lowercase status strings:',
    '  `new`, `in progress`, `need input`, `done`.',
    '- Each item has a unique, stable `id`, a `plan` path relative to this directory,',
    '  a `status`, and a string `reason`. No absolute paths or paths escaping this directory.',
    '- `reason` is required and nonempty for `need input`; use an empty string otherwise.',
    '- Add new items at the end with status `new`. Never change existing item IDs.',
    '- Keep completed entries as `done`; do not delete them to signal completion.',
    '- Do not add comments or trailing commas inside JSON, extra JSON fields, duplicate',
    '  keys, or a hand-written overall queue status. Overall status is computed in code.',
    '- Re-read before writing so newly added tasks are preserved. Use the queue update',
    '  operation with its revision check when available. Never overwrite a newer revision.',
    '- Write the complete valid file atomically; never leave half-written JSON behind.',
    '- Put explanations outside the marked block, or in the item\'s `reason` when blocked.',
    '',
    QUEUE_MARKERS.start,
    '```json',
    JSON.stringify({ version: QUEUE_VERSION, items: [] }, null, 2),
    '```',
    QUEUE_MARKERS.end,
  ].join('\n');
}

/** Render the worker-facing queue projection. The database is authoritative;
 * this file is intentionally readable but never an input to queue mutation. */
function queueProjection(items, customInstructions = '') {
  const projected = items.map((item) => ({
    id: item.id,
    plan: item.plan,
    status: item.status.replace('_', ' '),
    reason: item.reason || '',
  }));
  const payload = { version: QUEUE_VERSION, items: projected };
  if (customInstructions) payload.customInstructions = customInstructions;
  return [
    '# Plan queue',
    '',
    '> Generated by Paddock. Do not edit this file: use the Mission queue controls.',
    '> Paddock will detect an external change and pause the runner until it is regenerated.',
    '',
    QUEUE_MARKERS.start,
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    QUEUE_MARKERS.end,
    '',
  ].join('\n');
}

/** Write one deterministic queue projection. This is the only queue-file writer
 * the canonical queue service may call. */
function writeQueueProjection(agent, project, items, customInstructions = '', queueFile = QUEUE_FILENAME) {
  const abs = queuePath(agent, project, queueFile);
  const boundary = plansDir(agentObjOf(agent), { project });
  const text = queueProjection(items, customInstructions);
  atomicWriteOwned(abs, text, { boundary });
  return { path: abs, hash: queueHash(text) };
}

/**
 * Parse a QUEUE.md file, validate structure, and return the parsed JSON plus metadata.
 * Throws PlansError with code on any validation failure.
 * @returns { version, items[], customInstructions, hash, rawJson }
 */
function parseQueue(raw) {
  const { start, end } = QUEUE_MARKERS;
  const startIdx = raw.indexOf(start);
  const endIdx = raw.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new PlansError('queue_markers_missing', 'Queue file missing or malformed markers (<!-- paddock-queue:start/end -->).');
  }
  const jsonStart = startIdx + start.length;
  const jsonBlock = raw.slice(jsonStart, endIdx).trim();
  if (!jsonBlock.startsWith('```json') || !jsonBlock.endsWith('```')) {
    throw new PlansError('queue_json_fence_missing', 'JSON block must be fenced with ```json ... ```.');
  }
  const jsonText = jsonBlock.slice(7, -3).trim(); // strip ```json and ```
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new PlansError('queue_json_invalid', `JSON parse error: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new PlansError('queue_json_invalid', 'Queue JSON must be an object.');
  }
  if (parsed.version !== QUEUE_VERSION) {
    throw new PlansError('queue_version_unsupported', `Unsupported queue version: ${parsed.version} (expected ${QUEUE_VERSION}).`);
  }
  if (!Array.isArray(parsed.items)) {
    throw new PlansError('queue_items_missing', 'Queue must have an `items` array.');
  }
  if (parsed.customInstructions !== undefined) {
    if (typeof parsed.customInstructions !== 'string') {
      throw new PlansError('queue_custom_instructions_invalid', 'Queue customInstructions must be a string.');
    }
    if (Buffer.byteLength(parsed.customInstructions, 'utf8') > QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES) {
      throw new PlansError('queue_custom_instructions_too_large', `Queue customInstructions must be at most ${QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes.`);
    }
  }
  for (const key of Object.keys(parsed)) {
    if (!['version', 'items', 'customInstructions'].includes(key)) {
      throw new PlansError('queue_json_invalid', `Queue has unexpected field: ${key}.`);
    }
  }
  const seenIds = new Set();
  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    if (!item || typeof item !== 'object') {
      throw new PlansError('queue_item_invalid', `Item ${i} is not an object.`);
    }
    if (!item.id || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new PlansError('queue_item_invalid', `Item ${i} missing required nonempty string id.`);
    }
    if (seenIds.has(item.id)) {
      throw new PlansError('queue_duplicate_id', `Duplicate item id: ${item.id}`);
    }
    seenIds.add(item.id);
    if (!item.plan || typeof item.plan !== 'string' || item.plan.trim() === '') {
      throw new PlansError('queue_item_invalid', `Item ${item.id} missing required nonempty string plan.`);
    }
    // Path containment: relative, no absolute, no .. escape
    if (path.isAbsolute(item.plan) || item.plan.includes('..')) {
      throw new PlansError('queue_plan_path_invalid', `Item ${item.id} plan path must be relative and not escape the plans folder: ${item.plan}`);
    }
    if (!QUEUE_ITEM_STATUSES.includes(item.status)) {
      throw new PlansError('queue_item_invalid', `Item ${item.id} has invalid status: ${item.status} (allowed: ${QUEUE_ITEM_STATUSES.join(', ')}).`);
    }
    if (item.reason === undefined || item.reason === null) {
      throw new PlansError('queue_item_invalid', `Item ${item.id} missing required reason (string, empty for non-need-input).`);
    }
    if (typeof item.reason !== 'string') {
      throw new PlansError('queue_item_invalid', `Item ${item.id} reason must be a string.`);
    }
    if (item.status === 'need input' && item.reason.trim() === '') {
      throw new PlansError('queue_item_invalid', `Item ${item.id} has status 'need input' but reason is empty.`);
    }
    if (item.status !== 'need input' && item.reason !== '') {
      // Allow non-empty reason for other statuses? Plan says "use an empty string otherwise" — enforce empty.
      throw new PlansError('queue_item_invalid', `Item ${item.id} has status '${item.status}' but reason is not empty.`);
    }
    // No extra fields beyond id, plan, status, reason
    const allowedKeys = ['id', 'plan', 'status', 'reason'];
    for (const k of Object.keys(item)) {
      if (!allowedKeys.includes(k)) {
        throw new PlansError('queue_item_invalid', `Item ${item.id} has unexpected field: ${k}. Allowed: ${allowedKeys.join(', ')}.`);
      }
    }
  }
  return {
    version: parsed.version,
    items: parsed.items,
    customInstructions: parsed.customInstructions || '',
    hash: queueHash(jsonText),
    rawJson: jsonText,
  };
}

/** Alias for parseQueue — validates and returns parsed queue. */
function validateQueue(raw) {
  return parseQueue(raw);
}

/** Best-effort, read-only item preview for repairing semantic queue errors. This
 * intentionally does not validate or normalize the queue: callers must never
 * use it to schedule or write work. */
function queueRepairPreview(raw) {
  const startIdx = raw.indexOf(QUEUE_MARKERS.start);
  const endIdx = raw.indexOf(QUEUE_MARKERS.end);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const block = raw.slice(startIdx + QUEUE_MARKERS.start.length, endIdx).trim();
  if (!block.startsWith('```json') || !block.endsWith('```')) return null;
  try {
    const value = JSON.parse(block.slice(7, -3).trim());
    if (!Array.isArray(value?.items)) return null;
    const seen = new Set();
    const duplicateIds = new Set();
    const items = value.items.map((item, index) => {
      const id = typeof item?.id === 'string' ? item.id : null;
      if (id && seen.has(id)) duplicateIds.add(id);
      if (id) seen.add(id);
      return {
        index,
        id,
        plan: typeof item?.plan === 'string' ? item.plan : null,
        status: typeof item?.status === 'string' ? item.status : null,
        reason: typeof item?.reason === 'string' ? item.reason : null,
      };
    });
    return { items, duplicateIds: [...duplicateIds] };
  } catch {
    return null;
  }
}

/**
 * Validate a parsed queue and compute aggregate state.
 * @returns { state: 'new'|'in progress'|'need input'|'done'|'invalid', reason?, inProgressItem?, needInputItem? }
 */
function queueAggregateState(parsed) {
  // Spec order (plan 83 §"Parser and aggregate status"): an empty queue has
  // nothing left to do → done; an untouched NONEMPTY queue has work that has not
  // started → new. These are different questions and the code once answered the
  // first with `new` and the second with `in progress`, which are both the wrong
  // word for the state (a fresh QUEUE.md read as active work).
  if (!parsed || !parsed.items || !parsed.items.length) {
    return { state: 'done', reason: 'Queue is empty.' };
  }
  const needInputItem = parsed.items.find((it) => it.status === 'need input');
  if (needInputItem) {
    // Need input wins over everything, regardless of position in the list.
    return { state: 'need input', reason: 'Blocked on input.', needInputItem };
  }
  const inProgressItem = parsed.items.find((it) => it.status === 'in progress');
  if (inProgressItem) {
    return { state: 'in progress', inProgressItem };
  }
  const allDone = parsed.items.every((it) => it.status === 'done');
  if (allDone) {
    return { state: 'done', reason: 'All items completed.' };
  }
  const anyDone = parsed.items.some((it) => it.status === 'done');
  if (anyDone) {
    // Completed items with remaining new work — some progress was made.
    return { state: 'in progress', reason: 'Completed items with remaining new work.' };
  }
  // Every item is still `new`: nothing has started.
  return { state: 'new', reason: 'Untouched queue.' };
}

/**
 * Read and validate the queue file for a project.
 * Returns { parsed, aggregate, condition, summary, path, hash } or throws PlansError.
 *
 * `condition` distinguishes the three ways a queue can be unusable — `missing`
 * (the file is not there), `unreadable` (it is there but did not open) and
 * `malformed` (it opened but did not parse) — from `ok`. They all fold onto the
 * same `aggregate.state === 'invalid'` because the SUPERVISOR only needs "cannot
 * run", but the setup UI must not offer to overwrite an unreadable file the way
 * it offers to create a missing one: "no queue yet" and "your queue is broken"
 * are different sentences and only one of them has a safe automatic fix.
 *
 * They must NOT throw: the supervisor branches on `aggregate.state === 'invalid'`,
 * and a throw here is that branch never running (the runner stops progressing
 * with only a log line) and a 500 on the runners list for the whole project.
 */
async function readQueue(agent, project, queueFile = QUEUE_FILENAME) {
  const abs = queuePath(agent, project, queueFile);
  const emptyParsed = { version: QUEUE_VERSION, items: [] };
  if (!fs.existsSync(abs)) {
    return {
      parsed: emptyParsed,
      aggregate: { state: 'invalid', reason: 'Queue file does not exist.' },
      condition: 'missing', summary: queueSummary(emptyParsed), path: abs, hash: null,
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return {
      parsed: emptyParsed,
      aggregate: { state: 'invalid', reason: `Queue file could not be read: ${e.message}` },
      condition: 'unreadable', summary: queueSummary(emptyParsed), path: abs, hash: null,
    };
  }
  let parsed;
  try {
    parsed = parseQueue(raw);
  } catch (e) {
    const repair = queueRepairPreview(raw);
    return {
      parsed: emptyParsed,
      aggregate: { state: 'invalid', reason: e.message },
      condition: 'malformed', summary: queueSummary(emptyParsed), path: abs, hash: null,
      repairItems: repair?.items || [], repairDuplicateIds: repair?.duplicateIds || [],
    };
  }
  const aggregate = queueAggregateState(parsed);
  return { parsed, aggregate, condition: 'ok', summary: queueSummary(parsed), path: abs, hash: parsed.hash };
}

/**
 * The shared queue projection (plan 86 §Phase 1). ONE place derives
 * current/next/blocked/counts from parsed items, so the runner supervisor, the
 * REST read and the React panel cannot drift into three answers to "what is it
 * working on?". Pure — no filesystem, no worker probe. Queue statuses are FILE
 * facts; whether the worker is actually turning is a separate probe layered on
 * top, never folded in here.
 *
 * `next` is the first `new` item in ARRAY order (the order the worker walks), not
 * "after the current one" — an in-progress item does not remove the first new
 * item's claim to be next. `blocked` is the need-input item if any, because a
 * blocker outranks both.
 */
function queueSummary(parsed) {
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
  const counts = { total: items.length, new: 0, inProgress: 0, needInput: 0, done: 0 };
  for (const it of items) {
    if (it.status === 'new') counts.new++;
    else if (it.status === 'in progress') counts.inProgress++;
    else if (it.status === 'need input') counts.needInput++;
    else if (it.status === 'done') counts.done++;
  }
  const inProgressItems = items.filter((it) => it.status === 'in progress');
  const warnings = [];
  if (inProgressItems.length > 1) {
    warnings.push({
      code: 'queue_multiple_in_progress',
      message: `${inProgressItems.length} items are marked "in progress" (${inProgressItems.map(i => i.id).join(', ')}). Work them in order.`,
      itemIds: inProgressItems.map((i) => i.id),
    });
  }
  const pick = (it) => (it ? { id: it.id, plan: it.plan, status: it.status, reason: it.reason } : null);
  return {
    total: counts.total,
    counts,
    current: pick(inProgressItems[0]),
    next: pick(items.find((it) => it.status === 'new')),
    blocked: pick(items.find((it) => it.status === 'need input')),
    allDone: items.length > 0 && counts.done === items.length,
    warnings,
  };
}

/** The marker-fenced JSON block, as it is written to disk. */
function queueBlock(payload) {
  return [QUEUE_MARKERS.start, '```json', payload, '```', QUEUE_MARKERS.end].join('\n');
}

/** Replace the JSON block between the markers, preserving every byte of prose
 *  outside it. The old writer rebuilt the whole file from the markers and so
 *  DELETED the template's worker rules and any human note the moment a plan was
 *  added (plan 86 §1: "Preserve all prose outside markers"). A file whose
 *  markers are unusable falls back to appending — never to truncation. */
function spliceQueueBlock(raw, block) {
  const startIdx = raw.indexOf(QUEUE_MARKERS.start);
  const endIdx = raw.indexOf(QUEUE_MARKERS.end);
  if (startIdx !== -1 && endIdx > startIdx) {
    return raw.slice(0, startIdx) + block + raw.slice(endIdx + QUEUE_MARKERS.end.length);
  }
  return raw.endsWith('\n') ? raw + block : `${raw}\n${block}`;
}

/** Validate an items array under the EXACT rules `parseQueue` applies — one
 *  definition shared by read and write, so the two can never accept different
 *  shapes. Throws PlansError on the first violation. */
function validateQueueItems(items) {
  if (!Array.isArray(items)) throw new PlansError('queue_items_missing', 'Queue items must be an array.');
  const seenIds = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') throw new PlansError('queue_item_invalid', `Item ${i} is not an object.`);
    if (!item.id || typeof item.id !== 'string' || item.id.trim() === '') throw new PlansError('queue_item_invalid', `Item ${i} missing required nonempty string id.`);
    if (seenIds.has(item.id)) throw new PlansError('queue_duplicate_id', `Duplicate item id: ${item.id}`);
    seenIds.add(item.id);
    if (!item.plan || typeof item.plan !== 'string' || item.plan.trim() === '') throw new PlansError('queue_item_invalid', `Item ${item.id} missing required nonempty string plan.`);
    if (path.isAbsolute(item.plan) || item.plan.includes('..')) throw new PlansError('queue_plan_path_invalid', `Item ${item.id} plan path must be relative and not escape the plans folder: ${item.plan}`);
    if (!QUEUE_ITEM_STATUSES.includes(item.status)) throw new PlansError('queue_item_invalid', `Item ${item.id} has invalid status: ${item.status} (allowed: ${QUEUE_ITEM_STATUSES.join(', ')}).`);
    if (item.reason === undefined || item.reason === null) throw new PlansError('queue_item_invalid', `Item ${item.id} missing required reason (string, empty for non-need-input).`);
    if (typeof item.reason !== 'string') throw new PlansError('queue_item_invalid', `Item ${item.id} reason must be a string.`);
    if (item.status === 'need input' && item.reason.trim() === '') throw new PlansError('queue_item_invalid', `Item ${item.id} has status 'need input' but reason is empty.`);
    if (item.status !== 'need input' && item.reason !== '') throw new PlansError('queue_item_invalid', `Item ${item.id} has status '${item.status}' but reason is not empty.`);
    const allowedKeys = ['id', 'plan', 'status', 'reason'];
    for (const k of Object.keys(item)) if (!allowedKeys.includes(k)) throw new PlansError('queue_item_invalid', `Item ${item.id} has unexpected field: ${k}. Allowed: ${allowedKeys.join(', ')}.`);
  }
}

/**
 * Write the queue file with compare-and-swap (CAS) on the content hash.
 *
 * `expectedRevision` is the hash a prior `readQueue` returned. The check runs
 * UNCONDITIONALLY when a revision is given — even when the proposed content is
 * byte-identical to the current one — because it protects against a THIRD
 * writer, not against this caller (plan 86 §1). An absent/unreadable/malformed
 * CURRENT file is a `queue_revision_conflict`, never permission to overwrite:
 * a queue we cannot read is one whose content we cannot promise to preserve.
 * An existing queue updated WITHOUT a revision is a `queue_revision_required`
 * (a revision-less overwrite is not safe — it can clobber another writer's
 * change made after we read). `null` is therefore only a true create (file
 * absent); `ensureQueue` owns that path exclusively. Explicit updates always
 * pass a revision.
 *
 * Prose outside the markers is preserved and the file is replaced atomically.
 * @returns { hash, path }
 */
async function writeQueue(agent, project, items, expectedRevision, queueFile = QUEUE_FILENAME, options = {}) {
  const abs = queuePath(agent, project, queueFile);
  validateQueueItems(items);

  let currentRaw = null;
  let currentRevision = null;
  let currentProblem = null;
  const exists = fs.existsSync(abs);
  if (exists) {
    try {
      currentRaw = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      currentProblem = `Queue file could not be read: ${e.message}`;
    }
    if (currentRaw !== null) {
      try {
        currentRevision = parseQueue(currentRaw).hash;
      } catch (e) {
        currentProblem = e.message;
      }
    }
  }

  if (expectedRevision !== null && expectedRevision !== undefined) {
    if (!exists) {
      throw new PlansError('queue_revision_conflict', 'Queue file does not exist; cannot update an absent queue. Set it up first.');
    }
    if (currentProblem) {
      throw new PlansError('queue_revision_conflict', `The current queue is not readable/valid (${currentProblem}); refusing to overwrite it.`);
    }
    if (currentRevision !== expectedRevision) {
      throw new PlansError('queue_revision_conflict', `Queue was modified by another writer (expected ${expectedRevision}, current ${currentRevision}). Reload and retry.`);
    }
  } else if (exists) {
    // No revision supplied but a queue already exists: updating it REQUIRES
    // the current revision. A revision-less overwrite would silently clobber
    // whatever another writer changed between our read and our write, so it is
    // not a safe availability default (plan 86). The only remaining
    // revision-less write is the true create path (file absent), which
    // ensureQueue owns exclusively.
    throw new PlansError(
      currentProblem ? 'queue_revision_conflict' : 'queue_revision_required',
      currentProblem
        ? `An existing queue is not valid (${currentProblem}); refusing to overwrite it. Repair it or read it first.`
        : 'An existing queue must be updated with its current revision. Read the queue and pass the revision it returns, then retry.'
    );
  }

  const hasCustomInstructions = Object.prototype.hasOwnProperty.call(options, 'customInstructions');
  const customInstructions = hasCustomInstructions ? options.customInstructions : (currentRaw === null ? '' : parseQueue(currentRaw).customInstructions);
  if (typeof customInstructions !== 'string') {
    throw new PlansError('queue_custom_instructions_invalid', 'Queue customInstructions must be a string.');
  }
  if (Buffer.byteLength(customInstructions, 'utf8') > QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES) {
    throw new PlansError('queue_custom_instructions_too_large', `Queue customInstructions must be at most ${QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes.`);
  }
  const value = { version: QUEUE_VERSION, items };
  if (customInstructions) value.customInstructions = customInstructions;
  const payload = JSON.stringify(value, null, 2);
  const newHash = queueHash(payload);
  const block = queueBlock(payload);
  // A file we could not read was rejected above, so `currentRaw` here is either
  // the readable original (preserve its prose) or nothing (seed from template).
  const base = currentRaw !== null ? currentRaw : queueTemplate(agentObjOf(agent), project);
  const boundary = plansDir(agentObjOf(agent), { project });
  atomicWriteOwned(abs, spliceQueueBlock(base, block), { boundary });
  return { hash: newHash, path: abs };
}

/**
 * Ensure the queue file exists (create from template if missing).
 * Returns { created, path, hash, invalid? }.
 *
 * Creation is EXCLUSIVE (`wx`): two callers that both see a missing file must
 * not both write, with the slower one clobbering the faster one's content. The
 * loser re-reads and reports the winner's file (plan 86 §1).
 */
async function ensureQueue(agent, project, queueFile = QUEUE_FILENAME) {
  const abs = queuePath(agent, project, queueFile);
  if (fs.existsSync(abs)) {
    const raw = fs.readFileSync(abs, 'utf8');
    try {
      const parsed = parseQueue(raw);
      return { created: false, path: abs, hash: parsed.hash };
    } catch {
      // Existing file is invalid — leave it, report error on read
      return { created: false, path: abs, hash: null, invalid: true };
    }
  }
  const text = queueTemplate(agentObjOf(agent), project);
  const boundary = plansDir(agentObjOf(agent), { project });
  try {
    writeFileOwned(abs, text, { boundary, exclusive: true });
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Lost the create race — never replace the winner's content.
      const raw = fs.readFileSync(abs, 'utf8');
      try {
        const parsed = parseQueue(raw);
        return { created: false, path: abs, hash: parsed.hash, raced: true };
      } catch {
        return { created: false, path: abs, hash: null, invalid: true, raced: true };
      }
    }
    throw e;
  }
  const parsed = parseQueue(text);
  return { created: true, path: abs, hash: parsed.hash };
}

/**
 * Write a plan. For pad-root scope (no project), the file is produced BY the
 * workspace service — one gate, one reason, one place (plan 64 3a/3d).
 * A direct write there would be a writer that never asks whether the pad's
 * workspace may be browsed, so `plan_write` would put a file on a pad the user
 * had refused, while `workspace_write` on the same pad says no.
 *
 * For project scope, `projectPlansRoot` has ALREADY resolved the absolute path
 * and verified the webui has an rw bind mount covering it. The project folder
 * IS the scope, so we write directly at the resolved path; the resolver is the
 * gate. The mkdir goes through the same absolute write for the same reason.
 */
async function writePlan(agent, relPath, body, { session, now = Date.now(), project } = {}) {
  const abs = planPath(agent, relPath, { project });
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
    // The frontmatter is `key: value` lines, so a line break in the id would
    // write a second key (or a line no reader accepts, making the plan
    // unwritable afterwards). A conversation id is a plain token.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(String(session))) {
      throw new PlansError('plan_session_invalid', 'session must be the agent\'s own conversation id: letters, digits, "_", "-", "." or ":" only.');
    }
    data.session = session;
    data.started = existing.started || stamp;
  }
  const text = renderFrontmatter(data) + body;
  if (project) {
    const base = plansDir(agent, { project });
    writeFileOwned(abs, text, { boundary: base });
    await ensureIndex(agent, base, project);
  } else {
    const base = hostBrowseRootFor(agent);
    const relToBrowseRoot = path.relative(base, abs).split(path.sep).join('/');
    await workspace.createDirectories(agent.name, path.posix.dirname(relToBrowseRoot), 'host');
    await ensureIndex(agent, plansDir(agent, { project }), project);
    await workspace.writeFile(agent.name, relToBrowseRoot, text, 'host');
  }
  return { abs, ...describe(data, body, { now, relPath: planRel(agent, abs, { project }) }) };
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
      () => agent.name
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
  RESERVED_PLAN_NAMES,
  plansRoot,
  plansDir,
  planPath,
  planRel,
  projectPlansRoot,
  parseFrontmatter,
  renderFrontmatter,
  stripFrontmatter,
  planStatus,
  statusOf,
  statusRawOf,
  titleOf,
  timings,
  describe,
  readPlan,
  listPlans,
  withSessionState,
  scopeByProjectFolder,
  writePlan,
  initProjectPlans,
  requireAgent,
  QUEUE_MARKERS,
  QUEUE_VERSION,
  QUEUE_ITEM_STATUSES,
  QUEUE_CUSTOM_INSTRUCTIONS_MAX_BYTES,
  queueTemplate,
  queueProjection,
  writeQueueProjection,
  normalizeQueueFile,
  assertQueueFileClaimable,
  queuePath,
  queueHash,
  parseQueue,
  validateQueue,
  validateQueueItems,
  queueAggregateState,
  queueSummary,
  readQueue,
  writeQueue,
  ensureQueue,
  QUEUE_PAUSED_FILENAME,
  queuePausedPath,
  setQueuePausedMarker,
};
